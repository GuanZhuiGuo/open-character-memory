# 沙箱、并行 Subagent 与持久 Deep Agent Runtime

## 定位

当前运行时由四层组成：

1. **Pi ReAct 主 Agent**：主模型决定回答、调用记忆工具、调用已解锁 Skill/MCP，或派发并行子任务。
2. **有界并行 Subagent**：主模型只在确定性路由器识别到多任务意图后获得 `delegate_parallel_tasks`；子任务拥有独立上下文、角色与工具白名单，并在受控并发池中运行。
3. **OpenSandbox 工具平面**：文件读取、文档生成/渲染与 Bash/Python/Node 命令在隔离工作区执行，产物回写应用的作用域化 Artifact Store。
4. **持久 Deep Agent**：复杂任务以经过校验的 DAG 落库，独立 Worker 通过租约跨请求执行，支持检查点、审批、受限重规划和不可幂等写入对账。

`0.8.0` 已经形成当前产品内的 **单机持久 Deep Agent Runtime**。它不等于通用编码 Harness：当前仍没有多机分布式队列、递归子团队、Agent 间实时通信或 Git worktree/PR 工作流。持久状态机与运维合同见 [持久 Deep Agent Runtime](deep-agent-runtime.md)。

## 协作链路

```text
用户消息 + 附件
  -> 服务端意图路由
     -> 普通陪聊：不暴露沙箱和 Subagent 工具
     -> 明确文件/文档/命令意图：暴露匹配的沙箱工具白名单
     -> 明确多项独立任务：暴露 delegate_parallel_tasks
     -> 明确复杂长任务：暴露 start_durable_workflow
  -> Pi ReAct 主模型
     -> 直接回答
     -> 调用沙箱工具 -> 隔离工作区执行 -> toolResult -> 主模型续答
     -> 派发 2-N 个子任务
        -> 持久化任务组和 queued 状态
        -> 并发池启动独立子 Agent
        -> 每个子 Agent 获取独立 Prompt、消息与工具 profile
        -> 可选调用自己作用域内的沙箱工具
        -> 汇总成功/失败/产物 -> toolResult -> 主模型综合回答
     -> 登记持久 DAG -> HTTP 请求结束
        -> 独立 Worker 领取就绪节点
        -> 等待依赖 / 审批 / 重试 / 重规划 / 对账
        -> 全部有效节点完成 -> 最终汇总
  -> Trace 展示主模型、工具、子任务、沙箱运行与产物
```

## 沙箱工具

| 工具 | 用途 | 写权限 |
| --- | --- | --- |
| `sandbox_list_files` | 查看当前会话工作区文件 | 无 |
| `sandbox_read_file` | 读取 TXT/Markdown/HTML/JSON/CSV | 无 |
| `sandbox_document_read` | 提取 TXT/Markdown/HTML/DOCX/PDF 文本 | 无 |
| `sandbox_write_file` | 写入任务 `output` 目录 | 有 |
| `sandbox_document_create` | 生成 Markdown、HTML、DOCX、PDF | 有 |
| `sandbox_document_render` | DOCX 转 PDF、PDF 分页转 PNG 质检 | 有 |
| `sandbox_run_command` | 运行白名单中的 Bash/Python/Node 程序 | 有 |

用户上传文件只导入 `input`，工具不能覆盖；模型生成文件只写入 `output`。产物按 `user + agent + conversation + trace + subagent task` 记录，下载接口再次校验当前登录用户。

## Subagent 合同

- 默认角色：`general-purpose / researcher / analyst / writer / verifier`。
- 工具 profile：`none / read_only / document / workspace`。
- 默认单次最多 4 个任务、同时运行 3 个，可配置但有服务端硬上限。
- 当前最大深度为 1，子 Agent 不拥有 `delegate_parallel_tasks`，因此不会递归失控。
- 每个子任务只收到精简公共背景和自己的 instruction，不继承完整主对话或其他子任务私有上下文。
- 子 Agent 返回的是不可信工具结果，主模型负责综合；服务端负责作用域、预算、状态和产物归属。
- 一项简单任务、严格顺序任务或会写同一文件的任务不应并行。

## 为什么不是让模型始终看到全部工具

工具暴露分两步：确定性路由器先判断本轮是否存在文件、命令或多任务意图，主模型再决定是否真正调用。这样保留模型自主性，同时避免普通角色陪聊误触 Bash、文档生成或子 Agent，减少 Prompt 体积与工具误选。

## 安全边界

- `NODE_ENV=production` 禁止使用本地 provider；生产只能连接独立 OpenSandbox control plane。
- 沙箱容器不注入模型 Key、数据库路径、管理员密码或宿主机目录。
- 网络默认关闭；需要访问的主机必须显式进入 `SANDBOX_NETWORK_ALLOWED_HOSTS`。
- 命令程序、运行时间、输出字符数、文件大小、任务数、并发数和模型轮数均有硬限制。
- Bash 仍可能执行复杂命令，所以安全性来自隔离容器、无宿主挂载、无密钥和网络策略，而不是命令文本过滤本身。
- 本地 provider 仅用于开发文件操作；只有显式设置 `SANDBOX_LOCAL_UNSAFE_COMMANDS=true` 才允许在本机运行命令，生产启动会拒绝该方案。

## 部署

先构建沙箱镜像：

```bash
docker build -f sandbox/Dockerfile -t open-character-memory/sandbox:0.1.0 .
```

再按 [OpenSandbox](https://github.com/opensandbox-group/OpenSandbox) 文档部署 control plane，并配置：

```dotenv
SANDBOX_RUNTIME_ENABLED=true
SANDBOX_PROVIDER=opensandbox
SANDBOX_IMAGE=open-character-memory/sandbox:0.1.0
OPEN_SANDBOX_DOMAIN=opensandbox.example.com
OPEN_SANDBOX_PROTOCOL=https
OPEN_SANDBOX_API_KEY=replace-with-server-side-secret
SANDBOX_NETWORK_ALLOWED_HOSTS=

SUBAGENT_RUNTIME_ENABLED=true
SUBAGENT_MAX_CONCURRENCY=3
SUBAGENT_MAX_TASKS_PER_CALL=4
SUBAGENT_MAX_DEPTH=1

DEEP_AGENT_RUNTIME_ENABLED=true
DEEP_AGENT_WORKER_MODE=external
DEEP_AGENT_MAX_CONCURRENCY=2
DEEP_AGENT_MAX_NODES=16
DEEP_AGENT_MAX_REPLANS=2
```

仓库的 `compose.yaml` 只部署 Memory Agent 与 Neo4j，不假装附带 OpenSandbox control plane。未配置 control plane 时应保持 `SANDBOX_RUNTIME_ENABLED=false`；此时 Subagent 仍可做纯模型并行任务，但不能执行沙箱文件或命令工具。

## Trace 与界面

对话流会实时显示工具活动和并行子任务状态。Trace 的“执行平面”进一步展示：

- 主模型本轮看到的沙箱/Subagent 工具；
- 每个子任务的角色、工具 profile、状态、耗时和结果；
- 每次沙箱运行的 provider、命令/工具、退出状态、耗时和输出摘要；
- 上传附件与生成产物的下载入口；
- 当前部署是否真正启用 OpenSandbox，而不只显示代码能力存在。
- 关联的持久 Run、计划版本、节点依赖、审批、检查点、重规划和副作用对账状态。

## 参考实现取舍

- [OpenAI Codex multi-agent handler](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents_spec.rs)：参考父任务派发、状态更新与结果回收，但本项目当前禁止递归。
- [Claude Code subagent templates](https://github.com/anthropics/claude-plugins-official/blob/main/plugins/claude-code-setup/skills/claude-automation-recommender/references/subagent-templates.md)：参考专用角色和工具权限配置。
- [DeepSeek Harness subagent subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/subagent.md)：参考上下文隔离与子任务委派边界。
- [LangChain Deep Agents](https://github.com/langchain-ai/deepagents/blob/main/README.md)：参考 planning、filesystem、context management、subagents 与 persistence/checkpointing 的能力分层。

当前持久层已经补齐任务 DAG、依赖调度、租约 Worker、检查点/恢复、人工审批和跨请求预算。后续生产升级重点是 PostgreSQL 队列、多主机 Worker、对象存储、分布式可观测与更完整的 Agent 团队协议，而不是继续提高递归深度。
