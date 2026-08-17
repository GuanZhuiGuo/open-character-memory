# SDK 与生产成熟度说明

## 结论

当前系统的“角色陪聊记忆产品能力”明显强于“通用 SDK 与生产基础设施能力”。前者已有结构化控制、事件状态、图谱证据、纠正式/Agentic 召回、剧情触发和可观测界面；后者仍是一个单体应用的内部模块集合。因此，SDK 成熟度偏低不是说记忆逻辑差，而是说第三方还不能低成本、稳定地把它嵌进另一套 Agent Runtime。

## 为什么还不是成熟 SDK

成熟 SDK 至少需要稳定的公开接口，例如 `MemoryStore`、`Extractor`、`Retriever`、`PromptCompiler` 和 `Provider`；还需要类型声明、错误码、生命周期、取消/超时、版本兼容、迁移钩子、扩展点、示例工程和契约测试。

当前代码仍有这些应用级耦合：

- `lib/db.js` 在模块加载时创建 SQLite 单例，调用方不能注入自己的连接池或事务。
- 配置从进程环境全局读取，不能为同一进程中的多个租户或 Agent 分别初始化实例。
- 领域函数直接返回内部数据库行，尚未形成版本化的公共 DTO 与错误协议。
- 抽取、召回、剧情和 Trace 是完整产品链路，但还没有发布成可独立安装的包，也没有跨版本兼容矩阵。
- 本次新增 Provider Adapter 解决了模型耦合，但数据库、队列、鉴权和观测仍没有 Adapter 合同。

## 什么是持久化生态

它不只是“数据能写进硬盘”，而是一整套可替换、可迁移、可运维的 Store/Checkpointer 能力：PostgreSQL、Redis、MongoDB 等后端适配器，schema migration、事务、TTL、备份恢复、加密、连接池、异步接口、故障恢复和监控。

当前 SQLite 表已经能可靠保存单机状态，但没有统一 Store 接口、外部 Checkpointer、在线迁移工具和多后端一致性测试，所以“有持久化”不等于“持久化生态成熟”。LangGraph 的生产 Checkpointer/Store 文档可作为这个概念的参照：https://docs.langchain.com/oss/python/langgraph/persistence

## 什么是分布式执行

分布式执行是同一任务可以由多个进程或机器安全协作，并在任一 Worker 崩溃后继续。它通常要求持久化任务队列、租约或分布式锁、幂等键、会话序号、检查点、重试退避、死信队列、超时取消和结果去重。

当前 `conversationTurnQueues` 是进程内 `Map`：它只能串行同一个 Node 进程里的用户-角色请求。启动第二个副本后，两个副本彼此不知道对方的锁；阈值轮抽取也仍在 HTTP 请求内等待完成。因此它适合单机演示，不是可横向扩容的 Durable Execution。

## 为什么时序图谱与图数据库能力仍有边界

当前并非“没有图谱”：`events / entities / event_entities / claims / entity_edges` 已经组成可视化证据图，声明也有版本、状态、剧情时间和分支。

`0.5.0` 已经实现完整的应用级双时态合同：事件、声明、关系边和结构化历史统一使用 `valid_from / valid_to` 与 `transaction_from / transaction_to`，并支持通过 `valid_at + known_at` 回放“故事世界当时成立什么”以及“系统当时知道什么”。SQLite 是版本事实源，Neo4j 是通过 outbox 构建的当前有效图投影。

剩余边界主要是工程和通用图能力：

1. Neo4j 当前只投影当前有效版本，完整历史仍在 SQLite，因此还不能直接在图数据库里执行任意 `valid_at + known_at` 历史路径查询。
2. 应用层主要消费 1-2 跳证据，尚未提供通用 Cypher API、社区算法、长路径规划、独立投影 worker 或大图压测。
3. 实体和关系类型服务于当前角色陪聊 schema，缺少 Graphiti 式可扩展 ontology、批量 episode 解析与通用时序图 SDK。
4. outbox 重放器仍在单个 Node 进程内；多副本生产环境需要租约、幂等 worker、死信和投影延迟指标。

Graphiti 的 episode 溯源、可扩展 ontology、时序事实和混合图检索仍是下一阶段参照：https://github.com/getzep/graphiti 。详细市场对比见 [`market-memory-comparison-2026.md`](market-memory-comparison-2026.md)。

## SQLite 是否比 PostgreSQL + pgvector 差很多

不是绝对差，而是适用边界不同。SQLite 对本地、单机、低写并发、零运维非常合适，官方也明确说明同一时刻只有一个写事务；客户端/服务器数据库更适合多个进程和高并发写入：https://www.sqlite.org/whentouse.html

当前真正拉开差距的是向量与多副本：本系统把向量保存为 JSON，再拉到 Node 进程逐条计算余弦相似度。数据量增大后，扫描、内存和延迟会线性增长。pgvector 提供服务端向量类型、HNSW/IVFFlat、过滤后的近似检索，以及 PostgreSQL 原生的事务、复制、备份和权限能力：https://github.com/pgvector/pgvector

所以：几千到几万条、单机体验时 SQLite 很合适；多实例、多写者、十万级以上向量、在线备份和权限审计时，PostgreSQL + pgvector 的优势会迅速放大。

## 为什么生产级扩展仍弱

- 单进程锁，不能协调多副本。
- 轮后抽取阻塞 HTTP，没有持久化任务与失败重放。
- 多步记忆写入尚未统一放入一个数据库事务，后续步骤失败时早先写入不会自动回滚。
- SQLite 本地文件限制水平扩容，向量检索仍是应用层扫描。
- 认证是产品演示级账号与单管理员密码，不是企业 SSO、RBAC 或租户密钥管理。
- 有 Trace，但还没有 OpenTelemetry、指标、告警、SLO、容量压测和成本预算。
- 没有滚动升级、备份恢复演练、数据迁移校验与灾难恢复 Runbook。

`0.5.0` 已补 Pi ReAct 工具循环、纠正式/Agentic 记忆召回、双时态版本、Neo4j 图投影和受控 Skill/MCP 能力网关；SDK、PostgreSQL/pgvector、持久化抽取队列和多副本执行仍是明确的生产扩展 backlog，不能把单机可运行等同于分布式生产就绪。
