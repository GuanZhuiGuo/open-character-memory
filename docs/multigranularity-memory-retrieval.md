# 多粒度记忆召回设计

> 适用版本：Open Character Memory 0.6.0

## 目标

本次改造吸收多粒度记忆方案的核心思想，但不把摘要、原话或向量命中升级为新的事实源。系统仍以 SQLite 中的规范事件、Claim、关系边和双时态状态作为唯一裁决依据。

需要同时解决五类问题：

1. 同一事实用不同问法时，单一事件摘要可能召回不到。
2. 固定权重无法适配“问原话、问人物属性、问时间线、问剧情经过”等不同查询。
3. 首轮近邻只能找到直接相似项，难以发现与高质量种子间接相关的事件。
4. Planner 展开后可能得到重复或弱相关详情，直接全部注入会增加噪声。
5. 新机制必须可观测、可回退、可重建，并且不能破坏 Active Only、作用域隔离和双时态版本。

## 五步实现

### 1. 六类可重建视图

每个 active 规范事件投影为六类 `memory_views`：

| 视图 | 内容 | 典型问题 |
| --- | --- | --- |
| `turn` | 来源轮次原文 | “我当时怎么说的？” |
| `event` | 标题、类型、时间和事件摘要 | “那件事什么时候发生？” |
| `claim` | 原子化 subject/predicate/object | “悠悠喜欢什么？” |
| `episode` | 事件、声明、实体、关系和来源轮次组合 | “后来具体发生了什么？” |
| `summary` | 标题和压缩摘要 | “最近我们都聊了什么？” |
| `entity_keyword` | 实体、别名、关系和关键词 | “我女儿相关的事还有哪些？” |

所有视图都保存 `canonical_type=event` 和 `canonical_id`。更新、替代或撤回事件时，对应视图同步失活。历史数据首次召回时可复用规范事件向量兼容补建；管理员执行原生重建后，每类视图分别请求 Embedding。

### 2. 低熵动态 Router

Router 对六类视图分别计算：

- 候选熵：结果越集中，说明该粒度区分度越高。
- Top1/Top2 间隔：第一名相对第二名越明确，置信度越高。
- 门槛覆盖率：能通过目录相似度或关键词阈值的候选比例。
- 查询先验：例如“原话”提高 `turn`，“喜欢/是谁”提高 `claim`，“先后/最近一次”提高 `event`。

支持四种模式：

- `fixed`：只保留既有排序，多粒度结果用于诊断。
- `shadow`：计算权重和候选，但不改变排序，默认值。
- `dynamic`：按配置权重融合 legacy score 和 multi-view score。
- `ab`：按 `user + agent + story + branch` 稳定分桶，避免同一记忆实例在不同请求间跳组。

动态模式也不能绕过 Active Only、作用域、意图硬过滤、详情门槛和 Planner 授权。

### 3. 语义关联图与有界 PPR

`memory_associations` 保存视图之间的语义相关边。它与 `entity_edges` 的事实关系完全分开：

- `entity_edges` 表示有事件证据的“人物属于谁、物品放在哪里”等世界关系。
- `memory_associations` 只表示两个检索视图在同一 Embedding 空间中相关，用于发现候选。

建边过程先按目标事件保留最佳视图，再用两分量一维 GMM 识别高相关簇，同时执行最低相似度和最大度限制。默认每个来源视图最多 6 条边。

PPR 从 Router 的高质量视图命中出发，默认阻尼系数 0.85、12 次迭代、返回 8 个事件。服务端硬限制最多 2 跳和 240 个节点；输入关联边已经由当前作用域查询锁定。PPR 只在动态 Router 生效时参与排序，Shadow 模式只记录诊断。

Neo4j 同时投影：

- 规范事实图：实体、事件、Claim、证据关系。
- 可重建检索图：MemoryView 和 `ASSOCIATED_WITH`。

SQLite 仍保存完整主记录和投影源。Neo4j 不可用时，关联扩散读取 SQLite 投影。

### 4. LLM 上下文过滤与证据护栏

过滤器发生在 Corrective Planner 完成事件选择之后、最终 Claim/关系合并之前。模型输入只有当前 Query 和已选事件，输出只能包含：

```json
{
  "keep_event_ids": [],
  "evidence_sufficient": true,
  "reason": "一句话原因"
}
```

模型没有以下权限：

- 新增候选或请求其他作用域。
- 修改事件、Claim、关系或双时态状态。
- 将候选文本当作系统指令执行。
- 删除服务端标记的受保护事件。

受保护集合包括直接关键词证据、精确实体证据、确定性图关系证据和有序集合的全部时间线成员。服务端还会恢复配置的最少保留数。模型输出异常、判断证据不足或调用失败时保留全部候选。

支持 `off / shadow / active`。默认 `shadow` 只展示拟保留、拟删除和服务端恢复结果，不改变主模型 Input。

### 5. 观测、迁移与上线

召回测试和 Trace 展示：

- 六类视图候选数、熵、权重和 Top 命中。
- Router 请求模式、实际模式、A/B bucket 和是否影响排序。
- 关联边来源、边数、GMM 参数。
- PPR 访问节点、使用边、迭代次数、扩展事件和是否影响排序。
- Filter 的模式、候选、模型提议、服务端恢复、实际删除和原因。

管理员可调用：

```http
POST /api/admin/memory-index/rebuild
Content-Type: application/json

{
  "user_id": "user_xiaoyu",
  "agent_id": "agent_linwan",
  "story_id": "main_story",
  "branch_id": "main",
  "native_embeddings": true
}
```

接口会按当前作用域重新计算六视图 Embedding、重建语义边，并刷新 Neo4j 投影。它不会删除或改写规范事件、Claim、结构化记忆和对话历史。

建议上线顺序：

1. `granularity_router_mode=shadow`、`context_filter_mode=shadow`，积累 Trace。
2. 对长期记忆评测集比较 legacy 与多粒度候选覆盖率、噪声率和时序正确率。
3. 切换 `granularity_router_mode=ab`，逐步增加动态组比例。
4. Router 稳定后再将 Filter 切到 `active`；不要同时改变多个变量。
5. 监控证据恢复率、过滤器 fallback 率、PPR 扩展命中和最终回答事实准确率。

## 默认配置

| 配置 | 默认值 |
| --- | --- |
| 多粒度视图 | 开启 |
| Router 模式 | `shadow` |
| A/B 动态组比例 | 50% |
| 多粒度融合权重 | 0.35 |
| 语义关联图 | 开启 |
| 最低建边相似度 | 0.50 |
| 单视图最大关联数 | 6 |
| PPR | 开启 |
| PPR 阻尼/迭代/TopK | 0.85 / 12 / 8 |
| PPR 融合权重 | 0.15 |
| Filter 模式 | `shadow` |
| Filter 启动候选数 | 2 |
| Filter 最少保留 | 1 |

## 不变量

- 只有当前 `user + agent + story + branch` 的 active 数据可以进入候选。
- `superseded / retracted` 版本不会被视图、关联图、PPR 或 Filter 复活。
- 语义相关不等于事实关系，PPR 分数不等于事实置信度。
- LLM 只能提出候选选择，所有作用域、状态、预算和证据保护由服务端裁决。
- SQLite 是事实源；视图、关联边和 Neo4j 都可以从规范记录重建。
