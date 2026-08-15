# 未来 SDK 与存储路线

## 本次明确不做

- 不发布独立 Memory SDK。
- 不迁移 PostgreSQL。
- 不接入 pgvector。
- 不接入 OpenSearch。

这些项目是明确 backlog，不是 `0.3.0` 的隐藏能力。当前事实源仍是单机 SQLite，向量仍以 JSON 保存并在 Node 进程中计算。

## SDK 何时值得做

满足任一条件时启动 SDK：

- 第二个业务应用需要复用记忆写入、as-of 查询或召回。
- 需要稳定的 TypeScript/Python 客户端、版本兼容和租户鉴权合同。
- 需要把当前领域函数与 SQLite 方言解耦，支持远程 Memory Service。

建议顺序：先定义 HTTP/OpenAPI 合同和兼容策略，再抽 Store/Graph/Retrieval 接口，最后发布 TypeScript SDK；不要直接把当前数据库函数包装成公共 API。

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

1. 先建立双时态与 Neo4j 投影的评测、延迟和失败指标。
2. 将图投影 outbox 处理移到独立 worker，补死信与重放控制台。
3. 抽象 Store/Graph/Retrieval 接口并冻结 API 合同。
4. 数据量或并发命中阈值后迁移 PostgreSQL + pgvector。
5. 只有搜索语料规模和混合检索指标证明需要时，再增加 OpenSearch 投影。
6. 合同稳定后发布 SDK。
