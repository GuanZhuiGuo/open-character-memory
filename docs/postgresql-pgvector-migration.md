# PostgreSQL + pgvector 迁移方案

> 状态：`0.6.0` 暂缓实施，仅保留未来路线。当前 SQLite 是事实源，Neo4j 已作为可重建的事实图与语义关联图投影接入。

## 何时迁移

SQLite 适合本地演示、单机部署和低并发写入。出现多应用副本、并发记忆写入、在线备份恢复、细粒度数据库权限或十万级以上向量集合时，应迁移到 PostgreSQL。Neo4j 当前只承担可重建图投影，不能用它替代关系事实源迁移。

## 目标架构

- PostgreSQL 16+ 保存对话、结构化状态、事件、声明、图边、触发器、Trace 和任务状态。
- pgvector 保存事件与代码切片向量，使用与实际 Embedding 维度一致的 `vector(N)`。
- HNSW 作为默认近似索引；小数据集先保留精确搜索基线，再根据延迟和召回率选择参数。
- 生产级记忆抽取进入持久化队列；Worker 使用幂等键和会话序号提交结果。
- Neo4j 当前已通过 outbox 保存只读图投影；迁移后 PostgreSQL 接替 SQLite 成为事实源，Neo4j 的投影合同保持不变。

## 分阶段迁移

1. 建立数据库 Adapter，保持领域函数不直接依赖 SQLite 方言。
2. 使用版本化 migration 创建 PostgreSQL 表、外键、唯一约束和行级作用域索引。
3. 将 `embeddings.vector_json` 转换为 `vector(N)`；并行保留 JSON 校验一段时间。
4. 双写到 SQLite 与 PostgreSQL，但读取仍来自 SQLite；比较行数、版本链和向量维度。
5. 影子读取 PostgreSQL，记录结果差异和查询延迟，不影响用户回复。
6. 按租户或用户灰度切换读取，保留可逆开关。
7. 停止 SQLite 写入，完成最终校验、备份和回滚演练。

## 关键 SQL 方向

```sql
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE embeddings ADD COLUMN vector_value vector(2048);
CREATE INDEX embeddings_hnsw_cosine
  ON embeddings USING hnsw (vector_value vector_cosine_ops);

CREATE INDEX events_scope_active
  ON events (user_id, agent_id, story_id, branch_id, updated_at DESC)
  WHERE status = 'active';
```

维度 `2048` 只是当前默认模型示例；正式迁移必须从实际模型响应校验，不能硬编码后直接导入。

## 一致性与回滚

每个抽取批次使用稳定的 `extraction_batch_id`。结构化更新、Claim 版本切换、事件、实体关系和水位推进放在同一数据库事务中；重试时通过幂等键返回既有结果。切换前必须验证跨用户隔离、旧结论淘汰、角色共同故事和剧情分支冲突五类评测全部通过。
