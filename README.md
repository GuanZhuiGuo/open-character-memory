# Open Character Memory

**角色-用户双向记忆模块 | Role-User Memory Runtime**

[中文](README.md) | [English](README.en.md) | [Apache-2.0](LICENSE)

Open Character Memory 是一个面向角色陪聊、AI 教育等多轮场景的开源记忆 Agent 参考实现和可视化工作台。它不只“记得用户”，也会管理角色说过的话、双方共同经历、事件更正、关系状态与剧情分支。系统将管理员定义的结构化字段、用户明确偏好、事件图谱、当前有效状态和混合召回分层管理。

当前 `0.5.0` 采用 **Pi Agent Core ReAct runtime + 纠正式/Agentic 记忆召回 + SQLite 双时态主账本 + Neo4j 图查询投影 + 受控 Skill/MCP 能力网关**。SQLite 仍是当前单机版本的唯一事实源；Neo4j 由可重放 outbox 同步，故障时召回自动回退 SQLite，不参与裁决哪个版本有效。

![Open Character Memory 总体架构](docs/assets/overall-architecture-v0.5.0.png)

## 项目特点

- **双向记忆**：分开用户事实、角色固定属性和按用户-角色隔离的“我们的故事”。
- **有效状态优先**：使用 `create / enrich / update / supersede / retract` 操作和双时态区间区分补充、现实变化、旧认知纠正、撤回与历史回放。
- **图谱与 Agentic 召回**：事件、实体、声明和证据关系可视化；回复前 Corrective Planner 可改写漏召回 Query，生成中主模型可按证据缺口调用只读记忆工具。
- **可配置记忆契约**：管理员可定义结构化字段、抽取节奏、提示词、召回策略和基于状态的剧情/道具触发。
- **受控 Agent 能力**：已解锁的 Skill/MCP 才会当轮暴露，工具结果回传 Pi 后再由主模型续答，并保留确认、白名单和执行回执。
- **可观测与可评测**：Trace 展示完整 Prompt、记忆注入、召回证据、模型/工具循环与轮后写入，仓库附带离线回归评测。
- **Headless 记忆契约**：新增 `observe / recall / expand / mutate / forget` 原子 API、持久化抽取队列、TypeScript SDK、Pi/通用适配器和只读 MCP Server，现有 Studio 功能保持兼容。

## Headless Memory Runtime

新接入方使用 [`openapi/memory-v1.yaml`](openapi/memory-v1.yaml) 和 [`packages/sdk`](packages/sdk)；现有角色聊天、剧情、Trace 和每 X 轮抽取仍使用原 API，不需要迁移历史数据。

```js
import { MemoryClient } from '@open-character-memory/sdk';

const memory = new MemoryClient({ baseUrl, apiKey }).scope({
  tenantId: 'default', subjectId: userId, agentId, spaceId: storyId, branchId: 'main'
});
const pack = await memory.recall({ query: userText });
await memory.observe({
  idempotencyKey: turnId,
  messages: [{ role: 'user', content: userText }, { role: 'assistant', content: answer }]
});
```

完整边界、任务语义、MCP 启动方式和已知限制见 [`docs/headless-memory-runtime.md`](docs/headless-memory-runtime.md)。

## 方案对比

最新市场对比见 [`docs/market-memory-comparison-2026.md`](docs/market-memory-comparison-2026.md)。文档分别比较了 TencentDB Agent Memory、Mem0、Zep/Graphiti、Letta、LangGraph、Hindsight 等应用型记忆方案，以及 Codex、Claude Code、Cursor 的编码 Agent 记忆机制，并附带注明日期和口径的公开热度/市场信号。

## 已实现

- 用户、角色、故事和分支四级隔离。
- 管理员可配置固定字段：类型、作用域、默认值、约束、抽取策略、独立抽取说明、敏感级别和回复 Prompt 模板。
- 默认包含称呼、回复语言/风格/详细度、必须/避免项、亲密度、信任度、关系阶段、边界、兴趣、安全约束、知识点掌握度和错因模式。
- 显式称呼、风格和长期回复规则走同步快速通道，当轮生效；“必须 / 一定要 / 不要 / 别再”等要求经独立模型区分长期规则与剧情台词，通过边界校验后写入固定注入的 `response.must_rules / response.avoid_rules`。一般记忆按场景配置为每 X 个完整轮次批量抽取。
- 场景级“抽取配置”：明确展示短期记忆、每 X 轮长期记忆更新、结束点、同步屏障和抽取辅助上下文；分别配置事件、实体、关系/声明指令，并预览真实编译后的完整模型 Input。
- 抽取配置主体与完整 Input 合同分别加载；合同预览异常时仍显示并允许管理事件、实体、关系和阈值配置。
- 记忆查询包含独立的“结构化记忆”和“事件列表”；事件列表可按故事时间或写入时间排序，并可选择查看已被更新/撤回的历史版本。
- 事件、实体、事件-实体证据链接、关系边、带视角声明和剧情线图谱。
- 图形化记忆网络：事件、实体、声明和关系边可缩放、筛选并查看节点详情；点击实体可查看并定位关联事件。
- `active / superseded / retracted` 状态和完整版本历史。`enrich` 会保留原有有效声明并增加新细节；`superseded` 表示旧结论已被新版本替代，`retracted` 表示结论被明确撤回或取消。
- 事件、声明、关系边和结构化历史采用双时态模型：`valid_from / valid_to` 回答“故事世界中何时成立”，`transaction_from / transaction_to` 回答“系统何时知道并采用”；事件/图查询支持 `valid_at + known_at` 历史回放。
- 事件对齐器会在模型生成不同 event key 时，仍然将地点/时间更新到原事件槽位。
- 三层记忆召回：首轮使用向量、关键词和图关系形成轻量目录及严格详情候选；回复前 Corrective Planner 可展开目录，也可在目录为空/不足时改写 Query，并跳出首轮意图池搜索当前作用域全部 active 事件；生成中主模型若仍发现证据缺口，可调用 `memory_search / memory_expand`，取得 `toolResult` 后再次推理。
- 图谱本体采用“高度抽象实体类型 + 受控核心关系族 + 可追溯开放谓词”：具体关系文本用于解释，`child_of / parent_of / spouse_of / sibling_of / owns / located_at / participates_in / related_to` 关系族用于通用遍历。查询会先解析当前用户身份锚点和“我的女儿/父亲/配偶/物品”等关系意图，再扩展证据事件。
- 确定性关系召回会生成“当前用户锚点 + 关系族 + 关系对象 + 有效证据边”的回答契约。若最近对话中的历史 assistant 旧答与当前有效图谱冲突，本轮隔离旧答并以长期记忆为准；该策略覆盖亲属、配偶、所属物和后续可扩展的关系族，并在 Trace 中显示采用原因与省略消息数。
- 场景级召回策略：可分别配置候选目录阈值、纯向量详情阈值、Corrective Planner、零候选纠正、Planner 改写数、主模型记忆工具及其调用/Query 预算、向量/关键词/图谱通道、TopK、排序权重、图谱跳数和时效半衰期；`Active Only` 与四级作用域是不可关闭的硬保护。
- 召回测试工作台：展示实时 Embedding 模型/维度/向量预览、候选目录、详情资格、Planner 决策、图谱证据事件、过滤原因和最终 Prompt 注入片段。
- 角色固定属性按角色全局常驻注入；用户事实写入 `user_memory`；角色和用户共同发生的承诺、物件、对话进展写入按用户-角色-故事-分支隔离的 `shared_story`，不会串到该角色与其他用户的会话。
- 修改已投入使用的角色人设或固定属性时，系统展示影响范围并要求二次确认，同时保留角色版本历史。
- “剧情与道具”工作台：剧情节点按前置节点组成故事树；低代码触发器通过下拉选择结构化记忆、剧情/道具状态、判断条件和后续动作，并实时生成可读规则预览。预设“雨夜来信”包含男、女、非二元/不透露三条无刻板印象支线及各自后续章节，性别只接受用户明确自述。
- 道具库支持下载模板、上传 Skill ZIP 或 MCP JSON，并经草稿、风险检查和管理员审核后才能被条件解锁。每轮只把当前用户-角色-故事-分支已解锁的工具暴露给主模型；MCP 通过官方 Client 执行 `tools/list / tools/call`，Skill 支持经校验的说明加载与声明式 template / HTTP 工具，不执行 ZIP 内任意脚本。
- 角色设置支持新建角色并强制归属场景；记忆设置支持新建场景，创建时同步生成唯一的记忆设置、长期记忆抽取配置和召回策略。
- 对话页展示双方头像、长期记忆更新进度环、道具图鉴和剧情图鉴；未解锁项显示部分名称线索并置灰，不暴露 Skill/MCP 实现。点击进度环可立即提交当前待抽取批次，更新期间冻结输入和发送。主回复通过 NDJSON 增量输出，消息按 GFM Markdown 渲染并由 DOMPurify 清洗。
- 侧栏可切换管理端与用户端；用户端提供“见字如面 / 我们的故事 / 角色清单 / 剧情与道具”四个沉浸式视图。普通用户仍可切换到管理端查看完整配置，但所有写入能力保持只读。
- Trace 协作视图：直观展示 `Memory Agent Turn Pipeline → 回复前 Corrective Planner → Pi ReAct Runtime → 第 N 次模型请求 → memory_search / memory_expand 或 Skill/MCP → toolResult → 模型续答 → 轮后记忆更新`，同时保留改写 Query、跨池命中、工具作用域、执行状态、完整系统 Prompt、模型输入/输出和原始 Span。
- Trace 列表支持“无短期记忆”诊断重跑：复用原 query 和用户-角色-故事作用域，召回规划器与主模型均不附带最近 8 轮，只生成新的只读 Trace；不会新增对话消息、写入长期记忆、推进剧情/触发器或执行 Skill/MCP，便于验证回答是否真正来自长期记忆。
- 管理员“系统架构图”：查看入口、Agent Runtime、记忆平面、模型与数据层，以及真实轮次阈值、写入顺序和第 N 次主模型请求的完整 Input 切片；可跳转到对应配置来源。
- 系统代码问答：将核心代码按职责切片并持久化 Embedding，使用向量 82% + 关键词 18% 混合召回后调用文本模型；仅回答当前系统代码逻辑，并在每次回答中明确系统版本和代码索引最后 Embedding 时间。
- 单条聊天消息最多 1000 个 Unicode 字符，客户端即时拦截且服务端再次校验；用户总数达到 15 后关闭自助注册并提示联系韩康获取体验账户。
- 文本 Provider 支持 Ark、OpenAI、Anthropic 和离线 Mock；Embedding 支持 Ark、OpenAI 和本地确定性降级，可独立选择。
- 主回复由 `@earendil-works/pi-agent-core` 承担 ReAct 式 turn 状态、生命周期与工具循环。服务端按记忆意图/已有证据路由只读 `memory_search / memory_expand`，并按解锁资格、工具白名单、确认策略、主机/命令白名单和次数上限额外暴露 Skill/MCP；两类结果都以标准 `toolResult` 返回 Pi 后触发模型二次推理。记忆工具不能写状态，也不能接受模型传入 user/agent/story/branch。
- Neo4j 保存当前实体、事件、声明和证据关系的只读图投影；SQLite 提交成功后按 scope 合并 outbox，投影失败不丢主记录，可由 `POST /api/admin/graph/replay` 重放。
- 主模型 Input 分为稳定前缀与动态上下文：角色人设、通用硬规则和角色固定属性可缓存；服务器当前时间、结构化记忆、剧情、召回结果与短期对话逐轮重新编译。Ark 默认只展示 Responses usage 中的 Provider 托管缓存；`cached_tokens=0` 表示上游未报告命中或本次未命中，不能推断为本地缓存故障。只有配置兼容的 Endpoint ID 并显式设置 `ARK_PREFIX_CACHE_MODE=common_prefix` 时才使用 Context API。

## 运行

要求 Node.js 24 或更高版本。首次运行先按锁文件安装依赖：

```bash
npm ci
```

不配置外部模型即可本地体验：

```bash
npm run start:mock
```

Mock 模式只监听 `127.0.0.1`，本地管理员密码为 `local-demo-admin-2026`。

接入真实模型：

```bash
cp .env.example .env.local
# 在 .env.local 选择 Provider，并填写对应 API Key 和管理员密码
npm start
```

打开 `http://127.0.0.1:4173`。当前本地实例的管理员密码由 `.env.local` 中的 `ADMIN_PASSWORD` 控制。

挂载到 Nginx 子路径时设置 `BASE_PATH=/memory-agent`；本地根路径运行时留空。

测试：

```bash
ARK_API_KEY='' npm test
```

测试会使用本地确定性向量降级器，不消耗远程 API。
配置真实文本与 Embedding Provider 后，可运行 `npm run eval:long-term:real` 复测跨会话出行排序与宠物护理时间线；脚本会为每条事实建立独立会话，最终提问只保留当前消息，因此会消耗真实 API 额度。

完整发布前检查：

```bash
npm run eval
npm run check:open-source
ADMIN_PASSWORD='replace-with-a-strong-secret' \
NEO4J_PASSWORD='replace-with-a-different-strong-secret' \
docker compose up --build
```

`NODE_ENV=production` 时，未设置管理员密码、使用示例值或密码不足 12 位都会拒绝启动。

## 运行链路

```text
用户消息
  -> 显式控制记忆快速更新
  -> 常驻结构化记忆加载
  -> 条件触发器 / function call
  -> 事件/实体/关系轻量候选目录（不进入主模型 Input）
  -> Corrective Recall Planner 判断证据充分性
     -> 目录可用：请求事件详情或图谱证据
     -> 目录为空/不足：改写 Query，跨首轮候选池检索当前 scope 全部 active 事件
  -> 严格详情门槛 + Active Only + 命名空间硬过滤
  -> 合并有效 Claim、相关事件和有证据的图关系
  -> Prompt 编译
  -> 当轮工具路由：记忆问题按需暴露只读 memory_search / memory_expand
                  + 已解锁 Skill 清单 / MCP tools/list -> 当轮能力白名单
  -> Pi ReAct turn -> Text Provider 第 1 次推理
     -> 无需工具：直接生成角色回复
     -> 证据不足：tool call -> 服务端锁定作用域的长期记忆检索/图谱展开
                  -> active-only 证据 -> toolResult -> Text Provider 续答
     -> 需要能力：tool call -> 能力网关 -> Skill / MCP tools/call
                  -> 外部结果标记 + 执行回执 -> toolResult -> Text Provider 续答
  -> 持久化助手消息（语义轮结束，完整轮次计数 +1）
  -> 未达到 X 轮：保留原始消息并直接进入后置触发
  -> 达到 X 轮：合并水位后的待抽取批次，执行记忆操作抽取
  -> 结构化顺序写入 / 派生重算 / 双时态事件对齐与持久化
  -> graph_projection_outbox -> Neo4j 当前图投影（失败时保留待重放任务）
  -> 后置触发器执行
  -> HTTP 返回，释放会话锁（系统轮结束 / 下一轮可发送）
```

当前运行模式是 `blocking_after_assistant`：系统在每条 assistant 消息落库后检查会话抽取水位，累计达到场景配置的 X 个完整轮次才启动抽取；如果未满 X 轮就切换或新建对话，则在下一次跨对话发送前先提交上一对话的尾批次。抽取与记忆写入都在 `/api/chat` 请求内，调用方会阻塞等待模型、Embedding 和数据库操作完成；连续对话的非阈值轮不调用抽取模型。抽取成功后才推进水位，失败则保留批次等待后续重试。服务端按用户与角色串行化聊天请求，避免跨对话尾批次与当前回复并发改写同一记忆作用域；该锁不提供通用的数据库读取隔离。

当前缓存只优化主模型稳定前缀，不缓存动态记忆，也不参与记忆是否有效的判断。Ark 默认使用 Responses 的 Provider 托管缓存；`common_prefix` 仅作为需要兼容 Endpoint ID 的显式可选模式。存在当轮工具时由 Pi 原生 tool-capable stream 执行，无工具时由内置 Provider bridge 执行，两条路径都保留真实 usage 和缓存命中统计。具体边界见 [`docs/cache-design.md`](docs/cache-design.md)。

主模型当前把最近 16 条消息（约 8 轮）作为短期记忆直接装配进 Input，未实现 token 阈值或滚动摘要。长期记忆更新默认每 8 轮执行一次，可按场景调低为 1-8 轮，但不能超过短期记忆容量；用户明确提出的长期回复规则仍走即时快通道。陪伴场景的抽取辅助上下文默认读取待抽取批次之前 2 轮、最多 4 条只读消息，只用来理解“它、那件事、还是改到银座”等代词、省略或承接关系，不会把这些历史内容重复写入长期记忆，可按场景配置为 1-10 轮。

## 数据库

当前主记录库使用 Node.js 内置 SQLite，数据位于 `data/memory-agent.db`（已被 Git 忽略）。双时态版本先在 SQLite 落账；Neo4j 只是面向路径查询的当前图投影。表按以下边界分组：

- 对话：`users` / `agents` / `conversations` / `messages`
- 账号与权限：`user_accounts` / `user_sessions`
- 固定记忆：`memory_schemas` / `memory_values` / `memory_history`
- 场景配置：`scenes` / `memory_profiles` / `retrieval_profiles` / `event_extraction_profiles`
- 图谱：`entities` / `entity_edges` / `events` / `event_entities` / `claims`；事件通过 `memory_space` 区分 `user_memory` 与 `shared_story`，关系边通过 `event_id` 指向证据事件
- 图投影：`graph_projection_outbox` 合并同一 `user + agent + story + branch` 的待投影任务；Neo4j 使用 `MemoryScope / MemoryEntity / MemoryEvent / MemoryClaim` 节点以及 `INVOLVES / SUBJECT / EVIDENCE / RELATED` 关系
- Headless 契约：`memory_observations` / `memory_observation_messages` 保存外部 Agent 证据，`memory_jobs` 保存可重试抽取任务，`memory_operation_receipts` 保存幂等写回执
- 角色记忆：`agents.fixed_attributes_json` / `agents.profile_version` / `agent_profile_history`
- 向量：`embeddings`
- 架构问答：`architecture_knowledge_chunks` / `architecture_qa_logs`
- 模型前缀缓存：`model_prefix_caches` 只保存 Provider Context ID、版本键和命中统计，不保存业务事实
- 剧情、道具与调度：`plots` 通过 `parent_plot_id / branch_label / node_type` 表达故事树；`capability_props` / `user_prop_states` 保存 Skill/MCP 道具及用户解锁状态；`capability_tool_catalog` 保存发现并暴露的工具，`capability_runs` 保存参数脱敏后的成功、阻断或失败回执；原有低代码调度记录使用 `user_plot_states` / `triggers` / `trigger_runs` / `tools` / `tool_runs`
- 可观测与反馈：`traces` / `trace_spans` / `feedback`

TypeScript SDK 和持久化单机抽取队列已以 alpha 形式落地，但尚未独立发布 npm/PyPI。SQLite 适合当前单机体验与低写并发，仍不具备多副本并发写、服务端 ANN 向量索引、在线迁移和完整生产运维能力；PostgreSQL + pgvector、Python SDK 和分布式 worker 的触发条件见 [`docs/future-storage-sdk-roadmap.md`](docs/future-storage-sdk-roadmap.md)。

OpenSearch 不应替换当前主记录库或 Neo4j。它更适合作为未来的大规模混合检索索引：当事件/文档达到十万级以上，并强依赖 BM25、向量、过滤、聚合和多模态检索时，可以由主库异步投影到 OpenSearch；当前阶段再加入第三套投影会增加一致性、重建与运维成本，记忆正确性不会自动提升。详细取舍见 [`docs/bitemporal-neo4j-pi-runtime.md`](docs/bitemporal-neo4j-pi-runtime.md)。

## 权限与密钥

- 普通用户可自助注册；可查看全部系统配置、自己的对话、记忆、图谱和 Trace，但无法编辑配置或访问其他用户数据。
- 自助注册以 `users` 表总数 15 为体验上限；达到上限后服务端拒绝创建第 16 个用户，管理员创建的“仅数据档案”也计入总数，独立管理员登录本身不占名额。
- 管理员可编辑字段、记忆、角色、场景、剧情、道具、召回策略和触发器，并可查看用户列表、全部反馈与关联 Trace。
- 每条已持久化消息都可提交快捷反馈。客户端只上传消息 ID 和建议；服务端校验所有权后，自动封存完整轮次快照及 Trace ID。
- 所有业务记录必须带 `user_id`，故事记忆额外带 `agent_id / story_id / branch_id`。服务端不信任客户端传入的用户范围。
- `.env.local` 和 SQLite 数据库均不进入 Git。Trace 会自动脱敏 Ark Key 和 Bearer Token。
- `MEMORY_SERVICE_API_KEY` 仅能访问 `/v1/memory/*`；作用域中的 subject 仍由服务端校验，用户会话不能写入其他用户。
- MCP HTTP 与 Skill HTTP 只允许 `CAPABILITY_HTTP_ALLOWED_HOSTS` 中的主机；MCP stdio 默认关闭，启用后仍必须配置 `MCP_STDIO_ALLOWED_COMMANDS`。清单中的密钥只能写成 `${secret:ENV_NAME}`，stdio 子进程不会继承服务端全部环境变量。
- 线上应将当前本地管理员密码替换为企业 SSO/RBAC，并使用 KMS 或 Secret Manager 注入 API Key。

## 当前取舍

现有 Studio 达到 X 轮阈值时仍同步抽取，保证下一轮一定看到已提交批次。Headless `observe` 另外支持 `none / sync / async`；`async` 使用 SQLite 持久化任务、幂等键、指数退避和 dead 状态，但仍是单机 worker，不冒充分布式队列。用户明确的称呼、风格和戏外更正在两条链路都保持同步通道。

Neo4j 投影的失败策略与主记忆抽取不同：主 SQLite 写入不会回滚，outbox 保留待重放 scope，当前请求可降级使用 SQLite 图关系继续回答。Compose 默认启动 Neo4j；直接运行 `npm start` 时可设置 `GRAPH_STORE=sqlite`，或提供 Neo4j 配置后设置 `GRAPH_STORE=neo4j`。

## Git 与发布

本地源码使用 Git 记录版本，`.env.local`、SQLite 数据和浏览器验收产物不进入仓库。Git 解决的是变更历史、差异审查和版本回退，不会自动把服务器发布变成增量传输。当前云端发布仍使用小型完整代码包做原子替换，但会保留服务器上的 `data/` 和环境变量，并在健康检查失败时回滚。

需要增量发布时，应先绑定远程 Git 仓库，然后让服务器按已验证 commit 执行 `git fetch` + `git checkout`；或使用带发布目录与健康检查的 `rsync` 方案。不建议直接在正在运行的目录里逐文件覆盖。

首次公开到 GitHub 前，按 [`docs/open-source-release-checklist.md`](docs/open-source-release-checklist.md) 完成密钥扫描、离线测试、五类记忆评测、Docker 构建和安全设置；Headless 契约见 [`docs/headless-memory-runtime.md`](docs/headless-memory-runtime.md)，未完成的 PostgreSQL + pgvector、Python SDK、分布式 worker 与 OpenSearch 决策点见 [`docs/future-storage-sdk-roadmap.md`](docs/future-storage-sdk-roadmap.md)。
