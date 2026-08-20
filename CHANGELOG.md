# Changelog

这里记录所有重要变更。项目遵循语义化版本，公开 API 在 1.0 之前仍可能调整。

## Unreleased

## [0.6.0](https://github.com/GuanZhuiGuo/open-character-memory/releases/tag/v0.6.0) - 2026-08-19

### Added

- 新增 `turn / event / claim / episode / summary / entity_keyword` 六类可重建记忆视图；规范事件、声明与双时态版本仍是唯一事实源。
- 新增基于候选熵、置信度、间隔与覆盖度的多粒度 Router，支持 `fixed / shadow / dynamic / ab` 与稳定作用域分桶。
- 新增与事实关系边隔离的语义关联图、GMM 自适应建边和作用域锁定的有界 Personalized PageRank。
- 新增 Planner 后的 LLM 长期记忆上下文过滤，模型只有删除提议权，服务端强制保护直接证据、关系证据与时间线成员。
- 召回实验室与 Trace 新增六粒度权重、关联边来源、PPR 扩散预算和上下文过滤结果；管理员可按当前作用域重建索引与 Neo4j 投影。
- 新增右上角版本入口和产品内 Release Notes 中心；以仓库 Changelog 为事实源，支持当前版、历史版、待发布更新及 GitHub Release 直达链接。
- 新增 `memory-runtime/v1` Headless 契约，提供 `observe / recall / expand / mutate / forget` 五个原子操作与结构化 `ContextPack`。
- 新增 JavaScript/TypeScript alpha SDK、Pi/通用 Agent 适配器、OpenAPI 文档和只读 Memory MCP Server。
- 新增 observation 证据账本、幂等回执和 SQLite 持久化抽取任务，支持 `none / sync / async`、重试退避和 dead 状态。

### Changed

- 召回链路升级为 `作用域与 active 过滤 -> 六粒度检索 -> 动态 Router -> 语义关联/PPR -> Corrective Planner -> 证据保护过滤 -> 主模型记忆工具`。
- 历史数据首次召回时会兼容性补建六视图与关联边；原生重建入口可重新计算每类视图 Embedding，并刷新 Neo4j 可重建投影。
- Headless 作用域统一为 `tenant + subject + agent + space + branch`，再由兼容适配器映射到现有 Studio 的用户、角色、故事和分支记录。
- 架构图与代码 RAG 新增原子记忆契约、Memory Service、SDK、适配器、MCP 和持久化任务边界。

### Security

- 多粒度视图、语义关联边、PPR 和 LLM 过滤均继承 `user + agent + story + branch` 硬作用域；过滤模型不能新增事件或删除受保护证据。
- `MEMORY_SERVICE_API_KEY` 仅允访问 `/v1/memory/*`；模型只能使用服务端锁定作用域的只读记忆工具，不能直接提交记忆写入。
- 幂等 key 仅能重放同一请求；跨作用域或不同 payload 的 key 复用会被 `409` 拒绝，避免误吞写入或返回其他作用域的旧回执。

### Validation

- 新增多粒度完整性、跨用户隔离、稳定 A/B、GMM/PPR 边界和 LLM 证据保护专项测试。

## [0.5.0](https://github.com/GuanZhuiGuo/open-character-memory/releases/tag/v0.5.0) - 2026-08-17

### Added

- 新增 Corrective Recall Planner：首轮候选为 0 或证据不足时，可在预算内改写 Query，并跳出初始意图候选池检索当前作用域的全部有效事件。
- 新增作用域锁定、仅查询当前有效版本的 `memory_search` 和 `memory_expand` 系统工具；Pi 主模型可补齐证据并通过 `toolResult` 继续推理，但不获得记忆写权限。
- 新增场景级 Planner 配置和 Trace 诊断，展示改写 Query、跨池命中、记忆工具路由、调用预算及单次 Query 预算。
- 召回测试可区分目录准入、确定性展开、Planner 可选、后续 Query 与图谱证据展开。

### Changed

- 只在本轮涉及记忆、已有相关证据或 Planner 要求补证据时暴露记忆工具；普通闲聊继续走原有流式与缓存路径。
- 架构图、代码 RAG、发布文档和双语 README 明确区分回复前纠正式召回、生成中 Agentic 召回和用户已解锁的 Skill/MCP 执行。
- 主回复链路升级为 `首轮召回 -> 纠正式规划 -> Pi 工具调用 -> toolResult -> 模型续答`，作用域、状态、预算与写权限仍由服务端强制裁决。

### Fixed

- 首轮没有候选或证据不足时，不再直接让模型得出“从未提过”的结论；受限的改写 Query 可在当前完整命名空间内找回相关有效事件。
- 主模型发起的记忆展开不能越过 `user + agent + story + branch`，不能复活 `superseded/retracted` 历史，也不能把只读召回变成记忆写入。

### Validation

- Node 自动化测试：38/38 通过。
- 开源发布预检通过。
- 桌面端与移动端界面检查通过。

## [0.4.4](https://github.com/GuanZhuiGuo/open-character-memory/releases/tag/v0.4.4) - 2026-08-17

### Added

- 每条符合条件的 Trace 新增“无短期记忆”诊断重跑入口。
- Trace 协作视图明确展示 0 条短期消息、来源 Trace ID 及所有被禁用的副作用。

### Changed

- 诊断重跑只把原始 Query 交给召回规划器和主模型，不附加最近 8 轮对话。
- 重跑只生成新的 Trace，不写消息和长期记忆，不推进剧情或触发器，也不执行 Skill/MCP。
- 普通用户只能重跑自己的 Trace；管理员也被限制在当前选中的用户作用域内。

### Validation

- Node 自动化测试：36/36 通过。
- 67 个开源文件通过发布预检。
- 桌面端与 390px 窄屏交互检查通过。

## [0.4.3](https://github.com/GuanZhuiGuo/open-character-memory/releases/tag/v0.4.3) - 2026-08-16

### Added

- 新增事件 `enrich` 补充语义，在不覆盖原声明的前提下追加细节，并修复双时态证据链。
- 新增受控关系族、开放谓词和“当前用户”关系解析，支持从实体关系回查共同事件。
- 新增服务器当前时间、未解锁剧情/道具图鉴、系统版本展示及更清晰的缓存状态说明。
- 新增跨会话时序与护理履历真实模型评测脚本。

### Changed

- 确定性图谱证据优先于冲突的历史助手旧答，Trace 会展示短期记忆隔离策略及省略的消息数量。
- 事件与 Claim 更新保留原始证据、有效版本和历史版本，不再用稀疏更正抹掉未变化字段。

## [0.4.1](https://github.com/GuanZhuiGuo/open-character-memory/releases/tag/v0.4.1) - 2026-08-16

### Added

- 主回复支持 NDJSON 流式传输、安全的 GFM Markdown 渲染及长期记忆进度实时刷新。
- 新增 2026 年应用记忆系统与 Coding Agent 仓库记忆方案对比。

### Fixed

- Ark 缓存观测可穿过 Pi 适配器保留 Provider 用量，默认使用 Responses 服务端缓存；显式 Context 缓存仅对兼容 Endpoint ID 按需启用。
- 长期记忆抽取关闭推理、允许完整结构化输出，并按配置的 8 轮批次消化积压，不再反复重试持续增长的完整历史。
- 事件对账可避免 Key 冲突、合并同主题更新分支、忽略同消息重复撤回，并闭合已过期的会面出席声明。
- 默认召回阈值校准为 `0.36 / 0.48 / 0.12`；高扇出图实体不再把无关事件强塞进主模型 Input。

## [0.4.0](https://github.com/GuanZhuiGuo/open-character-memory/releases/tag/v0.4.0) - 2026-08-15

### Added

- 新增动态解锁能力 Runtime：支持声明式 Skill ZIP 校验、官方 MCP Client、`tools/list` 发现、`tools/call` 执行、审批门禁、执行回执及 Pi `toolResult` 续答。
- Ark/OpenAI/Anthropic 流式适配器支持工具调用，并提供确定性 Mock 工具调用、单请求模型/工具上限与 MCP HTTP/stdio 安全边界。
- 能力目录与执行回执持久化，并补齐 Skill/MCP 端到端 Runtime 测试。

### Changed

- Trace 与架构图展示每次 ReAct 模型请求、中间 Skill/MCP 执行、`toolResult` 回传、次数限制和最终模型续答。
- Skill ZIP 按安全的声明式包协议校验，不会执行压缩包中的任意 JavaScript 或 Python。

## 0.3.0 - 2026-08-15

### Added

- 引入 Pi Agent Core 单轮 Runtime、生命周期事件及 Provider Bridge，保留 Ark/OpenAI/Anthropic/Mock 行为与前缀缓存。
- 为结构化记忆历史、事件、Claim 和实体关系增加有效时间与事务时间，并支持按时点查询事件和图谱。
- 增加 Neo4j 当前图投影、作用域隔离、幂等投影替换、可重放 SQLite Outbox、健康状态及 SQLite 召回降级。
- 增加 Docker Compose Neo4j 服务，以及 Runtime、时态语义、图所有权和延期存储工作的架构文档。

### Changed

- 架构页明确区分 Pi Runtime、SQLite 事实源、双时态状态与 Neo4j 只读投影。
- Trace 在原始 Span 之前展示具体单轮链路、Pi Runtime/版本、Provider Bridge、当前 LLM、生命周期耗时和自动工具循环状态。
- Docker 构建按锁文件安装 Runtime 依赖。

## 0.2.5 - 2026-08-15

### Added

- 拆分稳定/动态 Prompt，并增加 Ark `common_prefix` 上下文缓存、TTL、失败冷却与完整请求降级。
- 增加 Ark、OpenAI、Anthropic 和离线 Mock 文本 Provider 适配器；Embedding Provider 可独立选择。
- Trace 增加输入 Token、缓存 Token、缓存状态和命中率指标。
- 剧情节点支持性别受众约束，身份更正后会抑制不兼容分支。
- 增加 5 条记忆回归评测集及确定性 Provider 测试。
- 增加 Apache-2.0 License、贡献/安全政策、双语 README、Docker/Compose、GitHub CI 与发布预检。
- 增加 PostgreSQL + pgvector 分阶段迁移指南。

### Changed

- 架构图区分可缓存角色前缀与动态记忆，并使用 Provider 中立的模型标签。
- 生产启动会拒绝缺失、过短或示例管理员密码。

## 0.2.4 - 2026-08-14

- 新增多分支角色扮演剧情、性别条件触发及后续章节。
- 新增用户注册、普通用户只读配置/Trace、整轮反馈抓取及管理员用户/反馈列表。
- 新增两阶段记忆召回、图谱证据展开、召回测试和系统代码问答。
- 新增每 X 轮长期记忆更新，以及事件、实体、关系抽取指令配置。
