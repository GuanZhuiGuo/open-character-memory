# SDK 与生产成熟度说明

## 结论

当前系统的“角色陪聊记忆产品能力”仍强于“生产级通用基础设施能力”。现在已有 `memory-runtime/v1` OpenAPI、JavaScript/TypeScript alpha SDK、Pi/通用适配器和只读 MCP Server，第三方可以不依赖 Studio UI 完成接入。但它还没有独立包发布、多语言 SDK、可替换存储、多租户密钥体系与分布式 worker，因此应定位为“可接入的 alpha Memory Service”，不是已成熟的生产 SDK。

## 为什么还不是成熟 SDK

成熟 SDK 至少需要稳定的公开接口，例如 `MemoryStore`、`Extractor`、`Retriever`、`PromptCompiler` 和 `Provider`；还需要类型声明、错误码、生命周期、取消/超时、版本兼容、迁移钩子、扩展点、示例工程和契约测试。

当前公共契约已有 DTO、类型声明、错误码、超时、幂等语义和契约测试，但仍有这些成熟度缺口：

- `lib/db.js` 在模块加载时创建 SQLite 单例，调用方不能注入自己的连接池或事务。
- 配置从进程环境全局读取，不能为同一进程中的多个租户或 Agent 分别初始化实例。
- `lib/memory-service.js` 的当前 Store Adapter 仍直连 SQLite 单例和现有 Studio 的用户/角色记录。
- SDK 仍是 workspace alpha 包，没有 npm/PyPI 独立发布、多版本兼容矩阵和完整升级指南。
- 只有 JavaScript/TypeScript 客户端，尚无 Python SDK，也没有多语言一致性测试。
- 数据库、向量、图、任务队列和观测还没有可替换 Adapter 合同。
- `MEMORY_SERVICE_API_KEY` 是服务级单密钥，已限定只访问 `/v1/memory/*`，但还不是租户级 key 管理、轮换、配额和审计体系。

## 什么是持久化生态

它不只是“数据能写进硬盘”，而是一整套可替换、可迁移、可运维的 Store/Checkpointer 能力：PostgreSQL、Redis、MongoDB 等后端适配器，schema migration、事务、TTL、备份恢复、加密、连接池、异步接口、故障恢复和监控。

当前 SQLite 表已经能可靠保存单机状态，但没有统一 Store 接口、外部 Checkpointer、在线迁移工具和多后端一致性测试，所以“有持久化”不等于“持久化生态成熟”。LangGraph 的生产 Checkpointer/Store 文档可作为这个概念的参照：https://docs.langchain.com/oss/python/langgraph/persistence

## 什么是分布式执行

分布式执行是同一任务可以由多个进程或机器安全协作，并在任一 Worker 崩溃后继续。它通常要求持久化任务队列、租约或分布式锁、幂等键、会话序号、检查点、重试退避、死信队列、超时取消和结果去重。

当前 Headless `async observe` 已把任务保存到 `memory_jobs`，支持幂等、重试退避和 dead 状态，解决了“进程重启后任务必然丢失”的基础问题。但 worker 仍在单个 Node 进程内，没有租约、分布式锁或多 worker 抢占协议；原 Studio 的 `conversationTurnQueues` 也仍是进程内 `Map`，X 轮抽取保持 HTTP 内阻塞语义。因此它是单机 durable queue，不是可横向扩容的 Durable Execution。

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
- 原 Studio 的 X 轮抽取仍阻塞 HTTP；Headless 虽有持久化任务与失败重试，但尚无多副本租约和独立 worker 部署。
- 多步记忆写入尚未统一放入一个数据库事务，后续步骤失败时早先写入不会自动回滚。
- SQLite 本地文件限制水平扩容，向量检索仍是应用层扫描。
- 认证是产品演示级账号与单管理员密码，不是企业 SSO、RBAC 或租户密钥管理。
- 有 Trace，但还没有 OpenTelemetry、指标、告警、SLO、容量压测和成本预算。
- 没有滚动升级、备份恢复演练、数据迁移校验与灾难恢复 Runbook。

`0.5.0` 之后的当前开发版已补 Pi ReAct 工具循环、纠正式/Agentic 召回、双时态版本、Neo4j 图投影、受控 Skill/MCP 能力网关、Headless Memory API、TypeScript alpha SDK 和单机持久化抽取队列。独立包发布、Python SDK、PostgreSQL/pgvector、可替换存储适配器和多副本执行仍是明确的生产扩展 backlog，不能把单机可运行等同于分布式生产就绪。
