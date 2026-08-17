# 双时态、Neo4j 与 Pi Runtime 设计

## 当前版本边界

`0.5.0` 的运行结构是：

```text
HTTP /api/chat
  -> 会话锁、固定规则、触发器、混合预召回与 Prompt Compiler
  -> Corrective Recall Planner -> 必要时改写 Query 并跨首轮候选池重检
  -> 记忆意图路由 -> 只读 memory_search / memory_expand
  -> 已解锁 Skill/MCP 解析与工具白名单
  -> Pi Agent Core ReAct turn state + lifecycle events
  -> Text Provider -> 可选记忆/能力 tool call -> toolResult -> Text Provider 续答
  -> SQLite 双时态主记录
  -> graph_projection_outbox
  -> Neo4j 当前图投影
```

SQLite 是当前唯一事实源。Neo4j 可以删除后从 SQLite 全量重建；它不裁决记忆版本，也不保存独有业务事实。Pi Agent Core 管理主回复 turn 的状态、生命周期和 ReAct 工具循环；记忆工具的 namespace、Active Only、只读边界与预算由服务端锁定，道具资格、白名单、确认、网络/进程边界与执行回执仍由服务端能力网关裁决。

## 两类二次召回

回复前的 Corrective Recall Planner 与生成中的主模型工具不是同一层：

1. **回复前纠正**：首轮向量、关键词和图召回先形成轻量目录。Planner 判断证据是否足够；目录为空或不足时可生成最多 N 个更具体 Query，并在当前 `user + agent + story + branch` 的全部 active 事件中重检，不再受首轮事件类型/collection 候选池限制。
2. **生成中补证据**：主模型第一次推理后若仍发现事实缺口，可调用 `memory_search` 改写检索词，或用 `memory_expand` 展开已知 event id / entity 的声明与证据邻居。结果作为 `toolResult` 回灌 Pi，再进行下一次模型推理。

两层都不能修改记忆。模型不能传入或更换作用域键；单轮调用次数、单次 Query 数、TopK、图跳数和 Active Only 均由场景配置及服务端硬限制控制。系统只在记忆相关问题、已有记忆证据或 Planner 请求补查时暴露这两个工具，普通闲聊不承担工具循环开销。

## 双时态语义

每个长期记忆版本同时包含两组半开区间：

| 时间 | 字段 | 回答的问题 |
| --- | --- | --- |
| 有效时间 | `valid_from <= t < valid_to` | 这件事在故事世界中何时成立？ |
| 认知时间 | `transaction_from <= t < transaction_to` | 系统在何时知道并采用这个版本？ |

空的 `valid_to` 或 `transaction_to` 表示开放区间。模型只可基于明确证据建议 `valid_from / valid_to`；`transaction_*` 永远由服务端生成。

### 三种变更

- `update`：世界状态真的发生变化。例如会议地点从周三起改到银座。旧版本的有效区间和认知区间都在新版本起点闭合。
- `supersede`：系统后来发现旧认知有误。例如用户说“我刚才说错了，其实一直是银座”。旧版本只闭合认知区间，新版本可继承原有效起点。
- `retract`：当前不再采用该结论。旧版本闭合认知区间，但证据与历史可按过去的 `known_at` 回放。

默认回答只读取 `status = active AND transaction_to = ''`。管理员可在事件或图查询中传入：

```text
GET /api/memory/events?...&valid_at=2026-08-01T00:00:00.000Z&known_at=2026-08-10T00:00:00.000Z
GET /api/memory/graph?...&valid_at=...&known_at=...
```

旧数据库会原地补列。历史行缺少精确业务时间时，以原 `created_at` 做保守回填；新写入才具备完整的操作级区分。

## Neo4j 投影

### 数据模型

- `MemoryScope`：`user_id + agent_id + story_id + branch_id` 隔离根。
- `MemoryEntity`：人物、地点、物品、组织、事件与概念。
- `MemoryEvent`：当前有效事件版本。
- `MemoryClaim`：当前有效声明版本。
- `INVOLVES`：事件涉及实体，并保留角色。
- `SUBJECT`：声明主语。
- `EVIDENCE`：声明回指证据事件。
- `RELATED`：实体关系，保留谓词、证据事件和双时态字段。

### 写入与恢复

1. SQLite 完成事件、声明、边和向量写入。
2. 同一 scope 的 outbox 使用唯一键合并，避免逐事件堆积重复任务。
3. Neo4j 使用 managed write transaction 原子替换该 scope 的当前图投影。
4. 成功后 outbox 标记为 `succeeded`。
5. 连接失败时任务回到 `pending` 并指数退避；聊天召回改读 SQLite 图表。
6. 管理员可调用 `POST /api/admin/graph/replay` 重放到期任务。

这种方式保证主记忆不依赖 Neo4j 可用性，但当前实现仍是进程内重放器。生产多实例版未来应改为独立 worker、租约领取、死信队列和指标告警。

## Pi Agent Core

Pi runtime 当前提供：

- 一次主回复的 Agent state。
- `agent_start / turn_start / message_* / tool_execution_* / turn_end / agent_end` 生命周期事件。
- 模型产生 tool call、服务端执行工具、标准 `toolResult` 回传和模型续答的 ReAct 循环。
- 按需暴露、作用域锁定的只读 `memory_search / memory_expand`，以及与其分离的已解锁 Skill/MCP 工具。
- 会话 ID 透传。
- 每次请求的模型轮数、工具调用次数与同批工具串行/并行上限。

没有可用工具时，Provider bridge 将 Provider 的流式结果转换为 Pi 消息事件；Ark 默认使用 Responses Provider 托管缓存，显式 Context 仅为 Endpoint ID 部署的可选模式。存在当轮工具时，Ark/OpenAI/Anthropic 改走 Pi 原生 tool-capable stream；Mock 用确定性桥接器验证同一事件合同。工具请求由模型决定，但记忆工具是否按需暴露、作用域、调用预算，以及外部能力是否允许和执行结果是否成功，均由服务端决定。

Skill ZIP 当前是受控声明式包：`skill.json` 可声明 template 或 HTTP 工具并附带 `SKILL.md`，不会加载或执行 ZIP 内任意 JavaScript/Python。MCP 使用官方 TypeScript Client 执行 `tools/list / tools/call`；HTTP 受主机白名单约束，stdio 默认关闭且受命令白名单约束。`AGENT_RUNTIME=legacy` 可用于紧急回退，但 legacy 不执行动态能力。

这里的运行架构是 ReAct 式工具循环，不是独立 Plan-Execute，也不是 Deep Agent。`AGENT_TOOL_EXECUTION=sequential|parallel` 只控制同一批工具如何执行；`AGENT_THINKING_LEVEL` 只控制支持该能力的模型推理强度。若要 Plan-Execute，需要在 Pi 外增加持久化计划、Planner/Executor 状态机和重规划节点；若要 Deep Agent，还要增加子 Agent、工作区/文件、任务树、检查点和跨任务调度。

## 保留的既有功能

本次升级不改变以下产品合同：用户隔离、普通用户只读配置与自己的 Trace、用户长期必须/避免规则、角色固定属性、用户记忆与“我们的故事”双向记忆、每 X 轮抽取、手动抽取、剧情性别分支、低代码触发器、Skill/MCP 道具资格、反馈与架构代码问答。原两阶段召回升级为“预召回 + Corrective Planner + 主模型只读记忆工具”，但版本裁决和写入权限仍在服务端。

## 配置

```dotenv
AGENT_RUNTIME=pi
AGENT_THINKING_LEVEL=off
AGENT_TOOL_EXECUTION=sequential
AGENT_MAX_TOOL_CALLS=6
AGENT_MAX_MODEL_TURNS=6
CAPABILITY_RUNTIME_ENABLED=true
CAPABILITY_HTTP_ALLOWED_HOSTS=mcp.example.com
MCP_ALLOW_STDIO=false
MCP_STDIO_ALLOWED_COMMANDS=
GRAPH_STORE=neo4j
NEO4J_URI=bolt://127.0.0.1:7687
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=strong-secret
NEO4J_DATABASE=neo4j
NEO4J_REQUIRED=false
```

`NEO4J_REQUIRED=false` 表示图层故障时保留主请求并回退 SQLite；设为 `true` 适合严格验收环境，但会让投影失败直接导致请求失败。
