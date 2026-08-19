# 未来 SDK 与存储路线

## 当前已落地

- `memory-runtime/v1` HTTP/OpenAPI 合同，包含 `observe / recall / expand / mutate / forget`。
- JavaScript/TypeScript alpha SDK 与类型声明。
- Pi Agent 和通用 `beforeModel / afterModel` 适配器。
- 只读、服务端锁定作用域的 Memory MCP Server。
- SQLite 持久化 observation、幂等回执与单机抽取任务，支持重试、退避和 dead 状态。

这些能力已在仓库内可用，但仍属 alpha：包尚未独立发布到 npm/PyPI，也没有完成多版本兼容矩阵。当前事实源仍是单机 SQLite，向量仍以 JSON 保存并在 Node 进程中计算。

## 下一阶段 SDK

- 将 `memory-core` 和 TypeScript SDK 发布为独立包，建立 semver 兼容策略、升级指南和契约测试矩阵。
- 提供 Python SDK，保持与 OpenAPI DTO、错误码和幂等语义一致。
- 抽象 Store / Vector / Graph / Job 适配器，使 Memory Service 不再直接依赖 SQLite 单例与 Studio 预置用户/角色记录。
- 补齐多租户 API key、配额、审计、限流和轮换机制。

## PostgreSQL + pgvector 何时迁移

出现以下信号再投入：

- 多应用副本或多个写进程。
- 同一租户持续并发写记忆。
- 事件/向量达到十万级，应用层全量向量扫描延迟不可接受。
- 需要在线备份恢复、复制、行级权限、连接池和数据库级审计。

PostgreSQL 应接管结构化事实源和 outbox；pgvector 接管带 metadata 过滤的 ANN 检索；Neo4j 继续作为可重建图投影。迁移步骤详见 `docs/postgresql-pgvector-migration.md`。

## OpenSearch 会不会更好

OpenSearch 对以下检索工作可能比当前 SQLite + 应用层向量扫描更好：

- BM25 关键词与向量的混合检索。
- 大量文档、长故事正文、附件或多模态描述。
- 高基数过滤、聚合、分片扩展和搜索可观测。
- 对召回延迟和吞吐量要求高于事务写一致性。

但它不适合替代：

- SQLite/PostgreSQL 的事务事实源与双时态版本约束。
- Neo4j 的多跳路径、关系证据与图遍历。
- 固定注入规则和当前有效状态裁决。

因此 OpenSearch 不是“更好的数据库”，而是特定规模下更强的搜索投影。若现在同时维护 SQLite、Neo4j、OpenSearch，会新增第三套投影的一致性、重建、容量和运维成本，而当前数据量尚无证据证明收益高于成本。

## 推荐演进顺序

1. 用第二个独立 Agent 完成接入验证，冻结 `memory-runtime/v1` 的兼容边界。
2. 建立双时态、召回、任务和 Neo4j 投影的评测、延迟与失败指标。
3. 抽象 Store / Vector / Graph / Job 适配器，发布 TypeScript SDK，再补 Python SDK。
4. 将抽取和图投影任务移到带租约、死信与可观测性的独立 worker。
5. 数据量或并发命中阈值后迁移 PostgreSQL + pgvector。
6. 只有搜索语料规模和混合检索指标证明需要时，再增加 OpenSearch 投影。
