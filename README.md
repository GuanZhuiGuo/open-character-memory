# Open Character Memory

**角色-用户双向记忆模块 | Role-User Memory Runtime**

[中文](README.md) | [English](README.en.md) | [Apache-2.0](LICENSE)

Open Character Memory 是一个面向角色陪聊、AI 教育等多轮场景的开源记忆 Agent 参考实现和可视化工作台。它不只“记得用户”，也会管理角色说过的话、双方共同经历、事件更正、关系状态与剧情分支。系统将管理员定义的结构化字段、用户明确偏好、事件图谱、当前有效状态和混合召回分层管理。

当前 `0.4.0` 采用 **Pi Agent Core ReAct runtime + SQLite 双时态主账本 + Neo4j 图查询投影 + 受控 Skill/MCP 能力网关**。SQLite 仍是当前单机版本的唯一事实源；Neo4j 由可重放 outbox 同步，故障时召回自动回退 SQLite，不参与裁决哪个版本有效。

## 项目特点

- **双向记忆**：分开用户事实、角色固定属性和按用户-角色隔离的“我们的故事”。
- **有效状态优先**：使用 `active / superseded / retracted` 和双时态区间处理更正、撤回与历史回放。
- **图谱与混合召回**：事件、实体、声明和证据关系可视化，支持向量、关键词、图关系和 Recall Planner 两阶段召回。
- **可配置记忆契约**：管理员可定义结构化字段、抽取节奏、提示词、召回策略和基于状态的剧情/道具触发。
- **受控 Agent 能力**：已解锁的 Skill/MCP 才会当轮暴露，工具结果回传 Pi 后再由主模型续答，并保留确认、白名单和执行回执。
- **可观测与可评测**：Trace 展示完整 Prompt、记忆注入、召回证据、模型/工具循环与轮后写入，仓库附带离线回归评测。

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
- `active / superseded / retracted` 状态和完整版本历史。`superseded` 表示旧结论已被新版本替代，`retracted` 表示结论被明确撤回或取消；两者均保留证据，但不进入默认回答。
- 事件、声明、关系边和结构化历史采用双时态模型：`valid_from / valid_to` 回答“故事世界中何时成立”，`transaction_from / transaction_to` 回答“系统何时知道并采用”；事件/图查询支持 `valid_at + known_at` 历史回放。
- 事件对齐器会在模型生成不同 event key 时，仍然将地点/时间更新到原事件槽位。
- 两阶段记忆召回：第一阶段只生成事件名、实体和关系的轻量候选目录；独立 Recall Planner 可请求事件详情或沿图谱关系补充证据，只有通过严格详情门槛的内容才会进入主模型 Input。
- 场景级召回策略：可分别配置候选目录阈值、纯向量详情阈值、Planner、向量/关键词/图谱通道、TopK、排序权重、图谱跳数和时效半衰期；`Active Only` 是不可关闭的硬保护。
- 召回测试工作台：展示实时 Embedding 模型/维度/向量预览、候选目录、详情资格、Planner 决策、图谱证据事件、过滤原因和最终 Prompt 注入片段。
- 角色固定属性按角色全局常驻注入；用户事实写入 `user_memory`；角色和用户共同发生的承诺、物件、对话进展写入按用户-角色-故事-分支隔离的 `shared_story`，不会串到该角色与其他用户的会话。
- 修改已投入使用的角色人设或固定属性时，系统展示影响范围并要求二次确认，同时保留角色版本历史。
- “剧情与道具”工作台：剧情节点按前置节点组成故事树；低代码触发器通过下拉选择结构化记忆、剧情/道具状态、判断条件和后续动作，并实时生成可读规则预览。预设“雨夜来信”包含男、女、非二元/不透露三条无刻板印象支线及各自后续章节，性别只接受用户明确自述。
- 道具库支持下载模板、上传 Skill ZIP 或 MCP JSON，并经草稿、风险检查和管理员审核后才能被条件解锁。每轮只把当前用户-角色-故事-分支已解锁的工具暴露给主模型；MCP 通过官方 Client 执行 `tools/list / tools/call`，Skill 支持经校验的说明加载与声明式 template / HTTP 工具，不执行 ZIP 内任意脚本。
- 角色设置支持新建角色并强制归属场景；记忆设置支持新建场景，创建时同步生成唯一的记忆设置、长期记忆抽取配置和召回策略。
- 对话页展示双方头像、长期记忆更新进度环、已解锁道具和已解锁剧情；点击进度环可立即提交当前待抽取批次，更新期间冻结输入和发送。
- 侧栏可切换管理端与用户端；用户端提供“见字如面 / 我们的故事 / 角色清单 / 剧情与道具”四个沉浸式视图。普通用户仍可切换到管理端查看完整配置，但所有写入能力保持只读。
- Trace 协作视图：直观展示 `Memory Agent Turn Pipeline → Pi ReAct Runtime → 第 N 次模型请求 → Tool → toolResult → 模型续答 → 轮后记忆更新`，同时保留已暴露工具、执行状态、常驻记忆、召回结果、完整系统 Prompt、模型输入/输出和原始 Span。
- 管理员“系统架构图”：查看入口、Agent Runtime、记忆平面、模型与数据层，以及真实轮次阈值、写入顺序和第 N 次主模型请求的完整 Input 切片；可跳转到对应配置来源。
- 系统代码问答：将核心代码按职责切片并持久化 Embedding，使用向量 82% + 关键词 18% 混合召回后调用文本模型；仅回答当前系统代码逻辑，并在每次回答中明确系统版本和代码索引最后 Embedding 时间。
- 单条聊天消息最多 1000 个 Unicode 字符，客户端即时拦截且服务端再次校验；用户总数达到 15 后关闭自助注册并提示联系韩康获取体验账户。
- 文本 Provider 支持 Ark、OpenAI、Anthropic 和离线 Mock；Embedding 支持 Ark、OpenAI 和本地确定性降级，可独立选择。
- 主回复由 `@earendil-works/pi-agent-core` 承担 ReAct 式 turn 状态、生命周期与工具循环。服务端能力网关按解锁资格、工具白名单、确认策略、主机/命令白名单和次数上限暴露并执行 Skill/MCP，结果以标准 `toolResult` 返回 Pi 后触发模型二次推理；`AGENT_TOOL_EXECUTION` 只控制同批工具串行或并行，不改变推理架构。
- Neo4j 保存当前实体、事件、声明和证据关系的只读图投影；SQLite 提交成功后按 scope 合并 outbox，投影失败不丢主记录，可由 `POST /api/admin/graph/replay` 重放。
- 主模型 Input 分为稳定前缀与动态上下文：角色人设、通用硬规则和角色固定属性可缓存；结构化记忆、剧情、召回结果与短期对话逐轮重新编译。Ark 使用显式 `common_prefix` Context，失败时自动退回完整请求；Trace 展示输入 Token、缓存 Token、状态和命中率。

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
  -> Recall Planner 二次请求事件详情或图谱证据
  -> 严格详情门槛 + Active Only + 命名空间硬过滤
  -> 合并有效 Claim、相关事件和有证据的图关系
  -> Prompt 编译
  -> 已解锁能力解析 -> Skill 清单 / MCP tools/list -> 当轮工具白名单
  -> Pi ReAct turn -> Text Provider 第 1 次推理
     -> 无需工具：直接生成角色回复
     -> 需要工具：tool call -> 能力网关 -> Skill / MCP tools/call
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

当前缓存只优化主模型稳定前缀，不缓存动态记忆，也不参与记忆是否有效的判断。逻辑键包含 Provider/模型、角色、角色版本、场景配置版本和稳定 Prompt Hash；人设修改会生成新键。当本轮没有暴露动态工具时继续使用现有 Provider bridge 与 Ark 显式 Context 缓存；存在可用工具时改走 Pi 原生 tool-capable stream，由 Provider 管理缓存，不使用 Ark 显式 Context ID。具体边界见 [`docs/cache-design.md`](docs/cache-design.md)。

主模型当前把最近 16 条消息（约 8 轮）作为短期记忆直接装配进 Input，未实现 token 阈值或滚动摘要。长期记忆更新默认每 8 轮执行一次，可按场景调低为 1-8 轮，但不能超过短期记忆容量；用户明确提出的长期回复规则仍走即时快通道。陪伴场景的抽取辅助上下文默认读取待抽取批次之前 2 轮、最多 4 条只读消息，只用来理解“它、那件事、还是改到银座”等代词、省略或承接关系，不会把这些历史内容重复写入长期记忆，可按场景配置为 1-10 轮。

## 数据库

当前主记录库使用 Node.js 内置 SQLite，数据位于 `data/memory-agent.db`（已被 Git 忽略）。双时态版本先在 SQLite 落账；Neo4j 只是面向路径查询的当前图投影。表按以下边界分组：

- 对话：`users` / `agents` / `conversations` / `messages`
- 账号与权限：`user_accounts` / `user_sessions`
- 固定记忆：`memory_schemas` / `memory_values` / `memory_history`
- 场景配置：`scenes` / `memory_profiles` / `retrieval_profiles` / `event_extraction_profiles`
- 图谱：`entities` / `entity_edges` / `events` / `event_entities` / `claims`；事件通过 `memory_space` 区分 `user_memory` 与 `shared_story`，关系边通过 `event_id` 指向证据事件
- 图投影：`graph_projection_outbox` 合并同一 `user + agent + story + branch` 的待投影任务；Neo4j 使用 `MemoryScope / MemoryEntity / MemoryEvent / MemoryClaim` 节点以及 `INVOLVES / SUBJECT / EVIDENCE / RELATED` 关系
- 角色记忆：`agents.fixed_attributes_json` / `agents.profile_version` / `agent_profile_history`
- 向量：`embeddings`
- 架构问答：`architecture_knowledge_chunks` / `architecture_qa_logs`
- 模型前缀缓存：`model_prefix_caches` 只保存 Provider Context ID、版本键和命中统计，不保存业务事实
- 剧情、道具与调度：`plots` 通过 `parent_plot_id / branch_label / node_type` 表达故事树；`capability_props` / `user_prop_states` 保存 Skill/MCP 道具及用户解锁状态；`capability_tool_catalog` 保存发现并暴露的工具，`capability_runs` 保存参数脱敏后的成功、阻断或失败回执；原有低代码调度记录使用 `user_plot_states` / `triggers` / `trigger_runs` / `tools` / `tool_runs`
- 可观测与反馈：`traces` / `trace_spans` / `feedback`

SDK 与 PostgreSQL + pgvector 本次明确暂缓。SQLite 适合当前单机体验与低写并发，但尚不具备多副本并发写、服务端 ANN 向量索引、在线迁移和完整生产运维能力；未来触发迁移条件和分阶段方案记录在 [`docs/future-storage-sdk-roadmap.md`](docs/future-storage-sdk-roadmap.md)。

OpenSearch 不应替换当前主记录库或 Neo4j。它更适合作为未来的大规模混合检索索引：当事件/文档达到十万级以上，并强依赖 BM25、向量、过滤、聚合和多模态检索时，可以由主库异步投影到 OpenSearch；当前阶段再加入第三套投影会增加一致性、重建与运维成本，记忆正确性不会自动提升。详细取舍见 [`docs/bitemporal-neo4j-pi-runtime.md`](docs/bitemporal-neo4j-pi-runtime.md)。

## 权限与密钥

- 普通用户可自助注册；可查看全部系统配置、自己的对话、记忆、图谱和 Trace，但无法编辑配置或访问其他用户数据。
- 自助注册以 `users` 表总数 15 为体验上限；达到上限后服务端拒绝创建第 16 个用户，管理员创建的“仅数据档案”也计入总数，独立管理员登录本身不占名额。
- 管理员可编辑字段、记忆、角色、场景、剧情、道具、召回策略和触发器，并可查看用户列表、全部反馈与关联 Trace。
- 每条已持久化消息都可提交快捷反馈。客户端只上传消息 ID 和建议；服务端校验所有权后，自动封存完整轮次快照及 Trace ID。
- 所有业务记录必须带 `user_id`，故事记忆额外带 `agent_id / story_id / branch_id`。服务端不信任客户端传入的用户范围。
- `.env.local` 和 SQLite 数据库均不进入 Git。Trace 会自动脱敏 Ark Key 和 Bearer Token。
- MCP HTTP 与 Skill HTTP 只允许 `CAPABILITY_HTTP_ALLOWED_HOSTS` 中的主机；MCP stdio 默认关闭，启用后仍必须配置 `MCP_STDIO_ALLOWED_COMMANDS`。清单中的密钥只能写成 `${secret:ENV_NAME}`，stdio 子进程不会继承服务端全部环境变量。
- 线上应将当前本地管理员密码替换为企业 SSO/RBAC，并使用 KMS 或 Secret Manager 注入 API Key。

## 当前取舍

达到 X 轮阈值时，记忆抽取当前同步执行，会增加该阈值轮的回包延迟，但能保证下一轮一定看到已提交的批次记忆。若改为生产级异步模式，需使用带幂等键、会话序号、重试和死信处理的持久化队列，并明确下一轮是等待前批次提交还是携带“记忆延迟”状态继续。用户明确的称呼、风格和戏外更正仍保持同步通道，不等待 X 轮。

Neo4j 投影的失败策略与主记忆抽取不同：主 SQLite 写入不会回滚，outbox 保留待重放 scope，当前请求可降级使用 SQLite 图关系继续回答。Compose 默认启动 Neo4j；直接运行 `npm start` 时可设置 `GRAPH_STORE=sqlite`，或提供 Neo4j 配置后设置 `GRAPH_STORE=neo4j`。

## Git 与发布

本地源码使用 Git 记录版本，`.env.local`、SQLite 数据和浏览器验收产物不进入仓库。Git 解决的是变更历史、差异审查和版本回退，不会自动把服务器发布变成增量传输。当前云端发布仍使用小型完整代码包做原子替换，但会保留服务器上的 `data/` 和环境变量，并在健康检查失败时回滚。

需要增量发布时，应先绑定远程 Git 仓库，然后让服务器按已验证 commit 执行 `git fetch` + `git checkout`；或使用带发布目录与健康检查的 `rsync` 方案。不建议直接在正在运行的目录里逐文件覆盖。

首次公开到 GitHub 前，按 [`docs/open-source-release-checklist.md`](docs/open-source-release-checklist.md) 完成密钥扫描、离线测试、五类记忆评测、Docker 构建和安全设置；本次运行时/双时态/图投影设计见 [`docs/bitemporal-neo4j-pi-runtime.md`](docs/bitemporal-neo4j-pi-runtime.md)，延期的 SDK、PostgreSQL + pgvector 与 OpenSearch 决策点见 [`docs/future-storage-sdk-roadmap.md`](docs/future-storage-sdk-roadmap.md)。
