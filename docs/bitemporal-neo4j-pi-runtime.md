# 双时态、Neo4j 与 Pi Runtime 设计

## 当前版本边界

`0.3.0` 的运行结构是：

```text
HTTP /api/chat
  -> 原有会话锁、固定规则、触发器、两阶段召回与 Prompt Compiler
  -> Pi Agent Core turn state + lifecycle events
  -> 现有 Text Provider bridge（Ark / OpenAI / Anthropic / Mock）
  -> SQLite 双时态主记录
  -> graph_projection_outbox
  -> Neo4j 当前图投影
```

SQLite 是当前唯一事实源。Neo4j 可以删除后从 SQLite 全量重建；它不裁决记忆版本，也不保存独有业务事实。Pi Agent Core 管理主回复 turn 的状态和生命周期，现有剧情、道具、触发器与权限逻辑仍由服务端管线负责。

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
- `agent_start / turn_start / message_* / turn_end / agent_end` 生命周期事件。
- 统一的 stream contract 与未来工具执行边界。
- 会话 ID 透传。

Provider bridge 将现有非流式 Provider 结果转换为 Pi 的消息事件，因此 Ark 显式前缀缓存、OpenAI/Anthropic Provider 管理缓存、Mock 测试和现有 Trace 均继续生效。

当前不应宣称的能力：主回复模型尚未通过 Pi 自动调用 Skill/MCP；道具只是服务端授予的资格，外部执行仍需受控能力网关、确认策略和真实执行回执。`AGENT_RUNTIME=legacy` 可用于紧急回退。

## 保留的既有功能

本次升级不改变以下产品合同：用户隔离、普通用户只读配置与自己的 Trace、用户长期必须/避免规则、角色固定属性、用户记忆与“我们的故事”双向记忆、每 X 轮抽取、手动抽取、两阶段召回、剧情性别分支、低代码触发器、Skill/MCP 道具资格、反馈与架构代码问答。

## 配置

```dotenv
AGENT_RUNTIME=pi
GRAPH_STORE=neo4j
NEO4J_URI=bolt://127.0.0.1:7687
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=strong-secret
NEO4J_DATABASE=neo4j
NEO4J_REQUIRED=false
```

`NEO4J_REQUIRED=false` 表示图层故障时保留主请求并回退 SQLite；设为 `true` 适合严格验收环境，但会让投影失败直接导致请求失败。
