# 持久 Deep Agent Runtime

## 定位

`0.8.0` 在原有 Pi ReAct 与有界并行 Subagent 之外，增加了一条跨请求的持久 Plan-Execute 路径。复杂任务不再绑定一次 HTTP 请求：主模型提出计划，服务端校验后把 Run、Node、Edge、Checkpoint、Approval、Event 和 Effect Receipt 写入 SQLite，独立 Worker 通过租约领取可执行节点。

这是一套面向当前产品的 **单机持久 Deep Agent Runtime**。它已经覆盖 DAG、并行依赖调度、重试、检查点、重启恢复、取消、人工审批、受限动态重规划和副作用对账，但不等于 Codex、Claude Code 或 DeepSeek Harness 的通用编码运行时，也不宣称具备多机分布式队列、递归 Agent 团队或任意代码自治权限。

## 三条执行路径

| 路径 | 适用任务 | 生命周期 | 调度主体 |
| --- | --- | --- | --- |
| Pi ReAct | 一次回复内完成的记忆查询、Skill/MCP 或单个工具调用 | 当前请求 | 主模型与服务端工具循环 |
| 有界 Subagent | 2-N 个短小、彼此独立、可在当前请求收口的分析任务 | 当前请求 | 父模型 + 进程内并发池 |
| 持久 Deep Agent | 有依赖、会等待审批、可能失败重规划或需要跨请求继续的长任务 | 跨请求、跨进程重启 | 持久 DAG + 独立 Worker |

主模型只在确定性路由器识别到复杂多阶段任务时看到 `start_durable_workflow`。工具调用只代表“计划已登记”，不代表节点已经执行成功；最终结果只有在所有有效终点完成并通过汇总后才产生。

## 计划合同

每个计划节点包含：

- 稳定 `node_key`、标题和可独立执行的 instruction；
- `depends_on` 依赖集合；
- 角色与工具 profile；
- `effect_mode`：`read_only / idempotent_write / non_idempotent_write`；
- `approval_mode`：`none / always / external_write`；破坏性动作不设独立枚举，而是由副作用等级、能力网关和人工审批共同限制。
- 最大尝试次数和节点顺序。

服务端而非模型负责以下硬校验：

1. 节点数、字段长度、角色、工具 profile、重试和重规划预算不超过配置上限。
2. `node_key` 唯一，全部依赖存在，图中无环。
3. 非幂等写入自动提升为需要审批的外部写入。
4. 用户、角色、故事、分支、会话和 Trace 作用域由服务端注入，模型不能改写。
5. 计划补丁再次经过相同校验，不能借重规划越过权限与预算。

## Run 与节点状态

Run 主要状态：

```text
queued -> running -> waiting_approval -> running
                   -> replanning -> running
                   -> synthesizing -> succeeded
                   -> reconciling -> running | failed
                   -> failed | cancelled
```

Node 主要状态：

```text
queued -> leased -> running -> succeeded
                    |          -> retry_wait -> queued
                    |          -> failed -> replanned/superseded
                    |          -> reconciling
                    -> waiting_approval -> queued | failed
                    -> skipped | cancelled
```

下游节点只有在全部有效依赖进入 `succeeded / skipped / superseded` 后才可领取。被重规划替代的旧节点保留在账本中，Trace 可以解释计划为什么改变，但它不再阻塞新图。

## Worker、租约与恢复

Worker 通过 SQLite `BEGIN IMMEDIATE` 原子领取节点，并写入 `lease_owner / lease_expires_at`。同一台机器可以运行多个 Worker 进程，但当前 SQLite 仍是单机事实源，不支持多个主机共享文件并发调度。

- 安全读或幂等写的租约过期：清除旧租约，回到队列后重试。
- 非幂等写的租约过期：进入 `reconciling`，等待业务回执或管理员裁决，不盲目重放。
- 每次计划创建、节点重试/成功、审批、重规划、对账和 Run 终态都会写 Checkpoint。
- Worker 重启后重新扫描数据库，而不是依赖内存队列。
- Worker 心跳写入 `deep_agent_workers`，Web 进程只在心跳未过期时显示“正在运行”；独立进程会保持事件循环，收到 `SIGTERM / SIGINT` 后停止领取并写停机心跳。

生产环境必须把 Web 与 Worker 分开：

```dotenv
DEEP_AGENT_RUNTIME_ENABLED=true
DEEP_AGENT_WORKER_MODE=external
DEEP_AGENT_WORKER_POLL_MS=1000
DEEP_AGENT_MAX_CONCURRENCY=2
DEEP_AGENT_MAX_NODES=16
DEEP_AGENT_MAX_REPLANS=2
DEEP_AGENT_NODE_MAX_ATTEMPTS=2
DEEP_AGENT_LEASE_SECONDS=180
DEEP_AGENT_APPROVAL_TTL_SECONDS=86400
DEEP_AGENT_AUTO_REPLAN=true
```

```bash
npm start
npm run worker:deep-agent
```

systemd 使用 [`memory-agent.service`](../deploy/memory-agent.service) 与 [`memory-agent-deep-worker.service`](../deploy/memory-agent-deep-worker.service)；Compose 会启动 `memory-agent` 和 `deep-agent-worker` 两个服务并共享同一个 SQLite volume。

## 重规划

节点在重试预算耗尽后，Planner 只能提议有限操作：

- `retry`：按退避重新执行原节点；
- `replace`：用一个经过验证的新子图替换失败节点，并把原下游依赖接到新终点；
- `skip`：仅在结果允许降级时跳过；
- `abort`：终止 Run。

Planner 无法直接写数据库。服务端限制重规划次数、节点总数和依赖合法性，并保存 `plan_version`、失败原因与补丁事件。这样保留动态性，同时避免模型无限拆任务或在失败后偷偷扩权。

## 审批与副作用

高风险节点在执行前创建作用域化 Approval：

- 普通用户只能查看和批准自己的 Run；
- 管理员可以查看所有 Run，并处理 `reconciling`；
- 审批有过期时间，过期后节点失败，不会默认放行；
- 拒绝会终止对应节点和 Run；
- 外部写入应携带幂等键或业务对象 ID，并把结果写入 Effect Receipt。

若外部系统可能已经成功、但网络回包未知，状态必须是 `reconciling`，不能写成 `failed` 后自动重试。管理员核对业务系统后可选择 `succeeded / retry / failed`，裁决与回执都会进入 Trace。

## 工具与沙箱

持久节点复用现有 Pi 工具合同：记忆工具只读且作用域锁定；Skill/MCP 需先解锁并通过能力网关；文件读取、文档生成和 Bash/Python/Node 只通过 OpenSandbox。

仓库只包含 OpenSandbox 适配器和沙箱镜像，不把 control plane 假装成已部署。若 `SANDBOX_RUNTIME_ENABLED=false`，纯模型与只读记忆节点仍可运行，文件和命令节点必须失败并在 Trace 中说明原因。启用方式见 [沙箱与并行 Subagent Runtime](sandbox-subagent-runtime.md)。

## API 与 Trace

主要接口：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `POST` | `/api/deep-agent/runs` | 创建经过服务端校验的 Run |
| `GET` | `/api/deep-agent/runs` | 查询当前用户或管理员可见的 Run |
| `GET` | `/api/deep-agent/runs/:id` | 查看 DAG、节点、审批、事件和检查点 |
| `POST` | `/api/deep-agent/runs/:id/cancel` | 请求取消 |
| `POST` | `/api/deep-agent/approvals/:id/decision` | 批准或拒绝节点 |
| `POST` | `/api/deep-agent/runs/:runId/nodes/:nodeId/reconcile` | 管理员处理未知副作用 |

Trace 将普通 Pi 工具循环和持久 Run 分开显示，并关联原始 `trace_id`。需要重点观察：计划版本、依赖边、节点租约/尝试次数、等待审批、重规划原因、沙箱运行、产物、Effect Receipt 和最终汇总。

## 当前边界

`0.8.0` 已完成的是当前产品内的单机持久执行闭环，不包括：

- PostgreSQL/队列上的多主机 Worker、抢占式调度和跨区域容灾；
- 递归子团队、Agent 间实时消息、共享任务板和动态组织结构；
- Codex/Claude Code 级 Git worktree、补丁、代码审查、IDE、终端和 PR 生命周期；
- 对运行时专门训练或联合优化的模型；
- OpenSandbox control plane 的一键内置部署。

当需要多副本 Web、多个执行主机或高写并发时，应把队列与租约迁移到 PostgreSQL，并将 Artifact Store 放到对象存储；SQLite 可以继续作为开发和单机体验模式，但不能通过共享网络盘伪装成分布式调度器。
