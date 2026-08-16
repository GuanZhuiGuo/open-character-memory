# 2026 Agent 记忆方案对比

> 对比基线：Open Character Memory `0.4.1`  
> 资料核验日期：2026-08-16  
> 范围：面向应用的长期记忆基础设施，以及 Codex、Claude Code、Cursor 这类编码 Agent 的上下文记忆。

## 先给结论

市场上的“记忆”至少分成三类，不能只看是否提供 `add / search` 接口：

1. **记忆基础设施与团队记忆中枢**：TencentDB Agent Memory、Mem0、Zep/Graphiti、Hindsight，重点是从历史中提取、治理、共享和召回信息或经验资产。
2. **状态化 Agent Runtime**：Letta、LangGraph，重点是让 Agent 在运行过程中管理工作状态、上下文和长期 Store。
3. **编码 Agent 上下文记忆**：Codex、Claude Code、Cursor，重点是跨开发会话保存项目规则、构建命令、调试经验和个人偏好。

Open Character Memory 不应把自己定位成另一个通用向量记忆 API。它当前最有区分度的能力是：

- 把管理员规则、用户明确要求、角色固定属性、用户事实和双方共同故事分开治理。
- 以 `active / superseded / retracted` 和双时态区间维护当前有效结论，而不是仅依赖相似度决定“哪个说法是真的”。
- 原生表达 `user + agent + story + branch`，支持角色说过的话、共同承诺、剧情分支和关系状态。
- 将记忆值直接连接到剧情、道具和 Skill/MCP 解锁，并由服务端能力网关执行硬约束。

代价也很明确：当前实现仍是单机 SQLite 主账本，SDK、分布式抽取、在线迁移和大规模向量索引不如成熟平台。

## 当前方案基线

Open Character Memory `0.4.1` 的记忆由六层组成：

| 层 | 当前实现 | 是否进入主模型 |
| --- | --- | --- |
| 短期记忆 | 最近 16 条原始消息，约 8 轮 | 每轮直接进入 |
| 固定控制 | 角色人设、固定属性、结构化字段、用户长期必须/避免规则 | 常驻注入 |
| 当前状态 | 结构化字段和当前有效 Claim | 常驻或按需注入 |
| 事件账本 | 用户事件与按角色-用户隔离的“我们的故事” | 相关时召回 |
| 图谱投影 | 实体、事件、声明、证据关系，Neo4j 可重建投影 | 作为召回证据 |
| Agent Runtime | Pi ReAct、已解锁 Skill/MCP、能力网关和执行回执 | 当轮按资格暴露 |

长期记忆默认每 8 个完整轮次更新一次，场景可配置为 1-8 轮。用户明确提出的长期回复规则和戏外更正走同步快速通道，不等待批量抽取。事件、声明、关系边和结构化历史均有有效时间与认知时间；默认回答硬过滤非当前版本。

## 一、应用型记忆方案

下表中的“原生”表示产品直接提供相应语义，“可组装”表示框架能承载但需要开发者自行定义，“无”表示公开文档没有把它作为产品合同。

| 方案 | 核心定位 | 常驻结构化状态 | 旧事实更新 | 图谱与时间 | 召回方式 | Agent/工具运行时 | 角色陪聊适配 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Open Character Memory 0.4.1** | 角色-用户双向记忆与剧情运行层 | 原生字段、固定属性、必须/避免规则 | 服务端操作与 `active / superseded / retracted`，双时态历史 | 原生事件、实体、Claim、证据边；SQLite 账本 + Neo4j 当前投影 | 向量 + 关键词 + 图关系 + Planner 二次展开 + 硬门槛 | Pi ReAct + 受控 Skill/MCP 网关 | **最贴合**，原生用户、角色、故事、分支和条件触发 |
| **TencentDB Agent Memory 2.0.0** | 面向 Agent 团队的 Memory Hub 与经验资产层 | L0 对话、L1 原子记忆、L2 场景、L3 Persona；另有 Skill、Wiki、CodeGraph | 记忆资产有 owner、version、status 和人工维护；公开合同未提供双时态 `active-only` 状态机 | Wiki 有链接图，CodeGraph 有符号和调用关系；不是角色剧情的时序事件图 | L2/L3 快速恢复，按需下钻 L1/L0；BM25 + 向量 + RRF，并受条数、字符和超时预算限制 | 提供跨 Agent 资产装配及工具协议；官方明确记忆本身不运行 Agent loop | 团队知识和多 Agent 复用很强；角色、用户、故事、分支和视角语义需另建领域层 |
| **Zep Cloud / Graphiti OSS** | 时序 Context Graph 与 Agent Memory | 可通过实体类型和应用逻辑组装，不是固定注入控制面 | 原生时序事实、失效区间、episode 溯源 | **最强项**，实体、关系、事实、episode 与混合图检索 | 语义 + BM25 + 图遍历，返回面向 Prompt 的上下文 | 不负责完整 Agent Runtime | 很适合复杂人物关系和时间变化；剧情、硬规则、道具仍需应用层 |
| **Mem0 Platform / OSS** | 易接入的个性化记忆 API | 支持实体 scope、类别和直接导入，但固定规则需应用实现 | 新算法采用 ADD-only，保留新旧事实并在检索排序时处理当前性 | Platform 使用内建实体连接图；不是带类型谓词的关系图。新 OSS 已移除外部图存储 | 语义 + BM25 + Entity Linking，可选 rerank | 提供 SDK/MCP 集成，不是完整业务 Runtime | 快速个性化很合适；对剧情槽位、明确撤回和当前状态硬裁决较弱 |
| **Letta** | Memory-first 的状态化 Agent Runtime | **强**，Memory Blocks 常驻上下文，可只读或由 Agent 自编辑 | 主要由 Agent 使用 memory tools 改写 block；缺少原生双时态版本语义 | 无原生事件时序图；大内容放 archival memory 或外部 RAG | 常驻 blocks + 文件搜索 + archival semantic search + 工具按需读取 | **强**，记忆和工具循环是一体的 | `persona / human` 很适合陪聊原型；关键状态若允许模型自由改写，需要额外治理 |
| **LangGraph / LangMem 模式** | 可持久化工作流与 Agent 状态编排 | 可组装任意 JSON state/store | 更新策略、冲突解决和 schema 由应用定义 | 无原生时序知识图，可接外部 Store/图数据库 | thread checkpointer + namespace Store + 可选语义搜索 | **强**，检查点、中断恢复和多节点编排成熟 | 适合作为生产 Runtime 底座；角色记忆语义基本都要自己实现 |
| **Hindsight** | Retain、Recall、Reflect 的学习型 Agent Memory | Mental models 和 beliefs 可形成持续认知，但不是管理员固定字段系统 | 通过 retain 与 reflect 累积、整合世界事实、经历和信念 | 有时间、实体和关系网络；公开合同不等同于显式双时态账本 | 多策略 recall；reflect 可基于记忆生成更高阶答案 | 可通过 API、wrapper 和 MCP 接入现有 Agent | 适合经验学习和关系理解；固定规则、剧情分支和工具资格仍需应用控制面 |

### 1. TencentDB Agent Memory

TencentDB Agent Memory `2.0.0` 已经不只是早期的 OpenClaw 本地记忆插件。当前公开方案把 Chat Memory、Skill、LLM-Wiki 和 CodeGraph 统一为 Memory Assets，并通过 Memory Hub 管理 owner、version、status、visibility、usage 和 Agent binding。`private / team / restricted / agent` 加 ACL 与 Fixed Binding，使一套经验可以跨 Agent、跨框架复用，同时限制谁能读取和装配。

Chat Memory 采用 `L0 Conversation -> L1 Atom -> L2 Scenario -> L3 Core/Persona` 的逐层沉淀。通常先用 L2/L3 恢复大局，需要精确事实时再以 BM25、向量和 RRF 下钻 L1/L0；Wiki 与 CodeGraph 则通过 `/v3/tools/list`、`/v3/tools/call` 按需进入上下文。官方 PersonaMem 数据从 48% 提升到 76%，说明它在长期用户信息理解上已有公开基准信号，但仍需在本项目自己的剧情更正、跨分支和双向承诺数据集上复验。

它相对本项目的优势是明显的：团队资产治理更完整，跨框架可移植性更强，文档和代码冷启动能力更成熟，也已有 Python/TypeScript SDK、异步处理、Docker 与服务化形态。对企业开发团队、编码 Agent 和多人共享经验，它比当前 Open Character Memory 更完整。

它不能直接替代本项目的部分同样明确。公开合同未原生表达 `user + agent + story + branch`，没有区分世界事实、角色信念、传闻、梦境、假设与戏外规则，也未给出有效时间、认知时间以及 `active / superseded / retracted` 的剧情事实裁决。Wiki 链接图和代码调用图也不等同于“人物、事件、声明、证据”的叙事时序图。官方还明确说明 Memory 不运行 Agent loop，而本项目同时包含受控 Pi ReAct、剧情/道具资格和 Skill/MCP 能力网关。

因此更合理的关系不是二选一：可借鉴腾讯的 L0-L3 渐进披露、Memory Asset、ACL/loadout、Wiki/CodeGraph 和跨 Agent 复用；Open Character Memory 继续作为角色世界状态、共同故事和能力资格的权威领域层。若未来需要团队级知识资产，两者甚至可以上下分层组合。

### 2. Zep / Graphiti

Graphiti 与当前方案在“事件、关系、时间变化、证据来源”上最接近。它将原始输入保存为 episode，派生实体与带有效期的关系，并支持语义、关键词和图遍历的混合检索。相比本项目，它在通用时序图构建、图查询能力和规模化产品化上更成熟。

本项目的优势不在图数据库本身，而在图之上的领域合同：角色固定属性、用户明确规则、关系数值、故事分支、记忆空间隔离、剧情和道具触发。若未来图规模和时间查询成为瓶颈，优先考虑吸收 Graphiti 的 ontology、历史图查询和批量 episode 处理，不必替换现有控制面。

### 3. Mem0

Mem0 的优势是接入成本低、托管能力完整、混合检索成熟。当前 Platform 会从记忆中抽取实体，并以实体共现连接不同记忆；这些连接直接参与排序，但不再返回独立的 typed relation 图。

需要特别注意版本变化：Mem0 新算法采用 ADD-only，不再让抽取阶段执行 UPDATE/DELETE。新旧事实都保留，当前性主要由时间信号与检索排序解决；新版 OSS 也移除了 Neo4j 等外部图存储。这个设计适合“不丢历史、依赖排序找当前事实”的通用助手，但不适合作为本项目 `active-only`、明确撤回和剧情状态机的唯一事实源。

### 4. Letta

Letta 的 Memory Blocks 是最值得借鉴的常驻记忆设计。`persona`、`human`、策略和当前工作状态可以始终放在上下文中，block 可以只读，也可以让 Agent 通过工具自我整理；大量内容则进入 archival memory 或外部 RAG。

它与本项目的主要区别是权威边界。Letta 默认鼓励 Agent 管理自己的 block，本项目则把结构化值、版本状态和安全边界交给服务端裁决。角色陪聊可以借鉴 Letta 的 block 分层和按需挂载，但亲密度、边界、必须规则、剧情资格不应只由主模型自由改写。

### 5. LangGraph

LangGraph 把短期记忆定义为 thread state + checkpointer，把跨会话长期记忆定义为 namespace + Store。它还明确区分 semantic、episodic、procedural memory，以及“回复热路径写入”和“后台异步写入”。

它是成熟的编排和持久化框架，不是现成的角色记忆语义层。采用 LangGraph 能提升检查点、中断恢复、持久化 Store 生态和分布式工作流，但不会自动解决旧事实失效、角色-用户故事隔离、图谱证据或剧情触发。

### 6. Hindsight

Hindsight 将记忆划分为世界事实、Agent 经历、实体总结和持续变化的信念，并提供 `retain / recall / reflect` 三种操作。`reflect` 与普通搜索不同，它会基于多个记忆形成综合判断，适合“Agent 从长期经历中学到什么”的问题。

这对陪聊角色的成长、关系反思和长期主题总结有价值，但反思结论应是低信任的派生层，必须保留证据并允许重算，不能直接覆盖用户明确声明或管理员硬规则。Hindsight 是较新的快速演进项目，基准结果、资源成本和版本兼容仍应在自己的数据集上复验。

## 二、公开热度与市场信号

下表为 `2026-08-16` 通过 GitHub API 读取的快照。Star 只反映公开仓库的社区关注度，不等于安装量、活跃用户、付费规模、生产成熟度或记忆效果；编码 Agent 的数字还是整个产品仓库热度，与单独的记忆模块不能直接横向排名。

| 方案 | GitHub Star | Fork | 统计对象与口径说明 |
| --- | ---: | ---: | --- |
| **Open Character Memory** | 0 | 0 | `GuanZhuiGuo/open-character-memory`；刚发布的早期项目 |
| **TencentDB Agent Memory** | 22,003 | 2,015 | `TencentCloud/TencentDB-Agent-Memory`；开源记忆框架主仓库 |
| **Mem0** | 63,335 | 7,393 | `mem0ai/mem0`；开源记忆层主仓库 |
| **Graphiti** | 29,956 | 3,031 | `getzep/graphiti`；Zep 的开源时序图引擎，不代表 Zep Cloud 客户规模 |
| **Letta** | 24,260 | 2,581 | `letta-ai/letta`；状态化 Agent 平台主仓库 |
| **LangGraph** | 39,754 | 6,684 | `langchain-ai/langgraph`；完整 Agent 编排框架，不是独立记忆产品 |
| **Hindsight** | 20,008 | 1,412 | `vectorize-io/hindsight`；开源 Agent Memory 主仓库 |
| **Codex** | 106,139 | 16,115 | `openai/codex`；完整编码 Agent 仓库，不是 Codex Memories 子模块 |
| **Claude Code** | 141,578 | 22,728 | `anthropics/claude-code`；完整编码 Agent 仓库，不是 Auto Memory 子模块 |
| **Cursor** | 33,113 | 2,283 | `cursor/cursor` 主要用于产品入口与反馈，不是 Cursor 核心源码。公司在 2025-11 官方披露年化收入超过 10 亿美元、用户为数百万开发者、投后估值 293 亿美元 |

因此，若只看开源记忆相关仓库，Mem0 的公开社区规模最大，Graphiti、Letta、TencentDB Agent Memory 和 Hindsight 已形成两万级以上关注；Open Character Memory 仍处于“领域方案已成形、开源社区尚未建立”的阶段。这个差距主要意味着生态、案例、贡献者和生产验证不足，不自动说明角色陪聊语义更弱。

## 三、Codex、Claude Code、Cursor 的记忆

这三类产品解决的是“一个编码 Agent 下一次进入仓库时，怎样少走弯路”，不是“一个角色怎样维护数年的关系世界”。它们的共同结构是：

```text
人工维护的强指导文件
  + Agent 自动生成的少量项目经验
  + 当前会话上下文与按需读取的代码/文件
```

### 对比矩阵

| 方案 | 人工维护层 | 自动记忆 | 生成时机 | 范围与存储 | 如何进入上下文 | 对旧信息的处理 | 是否是硬约束 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Codex** | 全局/项目/目录级 `AGENTS.md`，越靠近工作目录优先级越高 | 本地 Memories，从符合条件的历史任务生成摘要、持久条目和证据 | 后台生成；等待任务空闲，不保证聊天结束后立即更新 | 本机 `~/.codex/memories/`，可按任务控制是否读取/贡献 | 召回层按需提供；`AGENTS.md` 在运行开始时形成指令链 | 生成记忆可后台整理，但官方要求“必须遵守”的内容放 `AGENTS.md` 或仓库文档 | 记忆不是；`AGENTS.md` 仍是模型指令，不等于数据库或权限网关强制 |
| **Claude Code** | `CLAUDE.md`、`CLAUDE.local.md`、`.claude/rules/`，支持目录与路径 scope | 每仓库 Auto Memory，`MEMORY.md` 作为索引，详细内容拆到 topic 文件 | Claude 在会话中自行写入，不要求每个会话都写 | 本机 `~/.claude/projects/<project>/memory/`，同仓库 worktree 共享 | 每次启动载入索引前 200 行或 25KB；topic 文件按需读取 | 接近容量时提示合并、移动或删除过期条目；仍依赖模型维护文本一致性 | 否。官方明确 CLAUDE.md 是行为指导；真正强制需 settings、permissions、sandbox 或 hooks |
| **Cursor** | `.cursor/rules`、User Rules，可按 glob 自动挂载或手动使用 | Memories 是从 Chat 自动生成的 repository-scoped rules | sidecar 后台观察或 Agent tool call；后台建议需用户批准后保存 | 按 Git 仓库隔离，在 Settings > Rules 查看和删除 | 作为 prompt-level rule 注入 Agent/Cmd-K | 用户可审查删除；公开文档未给出双时态或版本冲突合同 | 否，本质是可复用 Prompt 规则 |
| **Open Character Memory** | 管理员人设、场景记忆 schema、角色固定属性与服务端硬规则 | 结构化字段、事件、实体、Claim、关系和 shared story | 明确规则当轮同步；一般长期记忆每 X 轮或跨对话边界更新 | 数据库按 `user + agent + story + branch` 隔离 | 固定控制常驻；事件经混合召回和 Planner 门控后注入 | 服务端闭合旧版本区间，默认硬过滤 superseded/retracted | **部分是**。数据库状态、权限和能力网关可强制；自然语言风格仍需输出检查 |

### 三个关键差异

#### 差异一：编码记忆偏“项目规则”，角色记忆偏“世界状态”

“总是运行 npm test”适合写进 `AGENTS.md` 或 `CLAUDE.md`；“用户上周取消了周五约会，但角色当时并不知道”需要事件、视角、有效时间、认知时间和证据。平面 Markdown 无法稳定回答后者。

#### 差异二：编码 Agent 可以接受延迟，陪聊硬规则不能

Codex 明确采用任务空闲后的后台记忆生成。这个策略很适合调试经验，因为下一秒不一定需要使用；但用户说“以后不要叫我小王”时，必须当轮写入并从下一次生成开始固定注入。本项目保留同步快速通道是必要的。

#### 差异三：文本指导不是服务端强制

Claude Code 官方文档明确区分 CLAUDE.md 行为指导与 settings/permissions/sandbox/hooks 强制执行。本项目同样不能只在 Prompt 里写“不要调用未解锁工具”，而必须由能力网关决定工具是否暴露、是否需要确认以及能访问哪些主机或命令。

## 值得吸收的设计

| 来源 | 建议吸收 | 在本项目中的正确落点 |
| --- | --- | --- |
| TencentDB Agent Memory | L0-L3 渐进披露、Memory Assets、ACL/loadout、Wiki/CodeGraph 和跨 Agent 可移植性 | 保留双时态角色账本为权威层，在其上增加团队知识、Skill 和代码/文档资产层 |
| Codex | 强规则与自动记忆分层；自动记忆延迟到任务空闲 | 继续让明确规则同步写；将普通事件抽取迁移到持久化后台队列 |
| Claude Code | `MEMORY.md` 索引 + topic 文件按需展开 | 生成非权威 `memory_digest`，只做轻量目录，详情仍回查双时态账本 |
| Claude Code | 路径 scope 与强制 hooks 分开 | 对应场景/角色 scope；关键状态变更与工具调用走服务端校验器 |
| Cursor | 后台记忆建议先给用户审查 | 增加“待确认记忆”收件箱，允许接受、修正、拒绝和查看证据 |
| Letta | 常驻 Memory Blocks 与按需 archival 分层 | 将固定属性、用户硬规则、当前关系状态保持为小型常驻块 |
| Graphiti | episode 溯源、typed ontology、历史时间图查询 | 扩展 Neo4j 历史投影和领域类型，不改变 SQLite 权威账本 |
| Hindsight | recall 与 reflect 分离 | 新增低信任“关系反思/主题总结”层，必须可重算且不得覆盖事实 |
| LangGraph | checkpointer、Store 和 durable workflow | 生产版把轮后抽取、图投影和触发器放入可恢复任务工作流 |

## 不建议直接照搬

- 不用一份自动维护的 Markdown 替代结构化状态和双时态账本。
- 不采用纯 ADD-only 作为可变关系、剧情状态和明确撤回的唯一更新策略。
- 不让主回复模型直接修改亲密度、边界、用户硬规则或工具资格。
- 不把所有历史都做成常驻 Prompt，也不让低相似度 TopK 自动进入回答。
- 不因接入 Neo4j 就把图投影升级为事实源；版本裁决仍应在事务主库完成。

## 产品选择建议

| 目标 | 更合适的起点 |
| --- | --- |
| 团队内多个 Agent 共享对话经验、Skill、文档和代码资产 | TencentDB Agent Memory |
| 几行 API 为客服或助手增加偏好记忆 | Mem0 |
| 企业数据与对话形成可演化时序图 | Zep；需要自托管图引擎时看 Graphiti |
| 构建会自我整理上下文的长期 Agent | Letta |
| 构建可恢复、多节点、可编排的 Agent Runtime | LangGraph，再叠加专用记忆层 |
| 让 Agent 从历史经验中 recall 与 reflect | Hindsight |
| 给编码 Agent 保存项目规则和调试经验 | Codex、Claude Code、Cursor 自带机制 |
| 角色陪聊、AI 教育中的角色-用户双向记忆、剧情和条件能力 | Open Character Memory；生产化时补 PostgreSQL/pgvector 与 durable workflow |

## 对当前项目的最终判断

Open Character Memory 已经不是“向量召回 Demo”，也不是 Codex/Claude Code 式的记忆文件集合。它是一个有明确领域模型、状态裁决和 Agent 能力网关的角色记忆运行层。

当前相对市场的结论是：

- **领域完整性领先**：角色-用户双向记忆、shared story、剧情分支、固定规则和条件能力组合较少见。
- **状态正确性较强**：双时态、active-only 和证据版本比单纯 ADD-only 或 TopK 更适合可更正剧情。
- **团队资产中枢明显落后于腾讯**：尚无成熟的跨 Agent Memory Asset、ACL/loadout、Wiki/CodeGraph、SDK 和服务化生态。
- **通用图能力中等**：已经有真实 Neo4j 投影与图召回，但历史图遍历、ontology 和大图运行能力弱于 Graphiti/Zep。
- **Agent 自我学习中等**：有事件抽取和 Planner，但还没有 Hindsight 式独立 reflection，也不让 Agent 自主管理权威记忆。
- **生产基础设施偏弱**：单机 SQLite、同步阈值轮抽取、进程内锁和应用层向量扫描仍是主要差距。
- **编码 Agent 记忆不是竞品替代关系**：Codex/Claude/Cursor 的分层规则设计值得借鉴，但不能替代角色世界状态、用户隔离和剧情触发。

下一阶段最值得做的不是更换记忆框架，而是把现有领域优势迁移到生产底座：PostgreSQL + pgvector、持久化抽取队列、历史 Neo4j 投影、记忆审核收件箱，以及覆盖更正、噪声、跨分支和双向承诺的长期评测集。

## English summary

Open Character Memory is not positioned as another generic vector-memory API. Its differentiation is the governed combination of bidirectional role-user memory, bitemporal active-state versioning, shared narrative events, graph-backed evidence, conditional plot/tool unlocking, and a controlled ReAct capability gateway.

TencentDB Agent Memory is stronger as a team-level Memory Hub with portable Chat Memory, Skills, Wiki, CodeGraph, ACLs, and progressive L0-L3 disclosure. Open Character Memory remains more specialized for bitemporal role-user facts, narrative branches, perspective-aware claims, shared-story state, and controlled plot/tool eligibility. Zep/Graphiti is stronger as a general temporal graph substrate; Mem0 is easier as a managed personalization API; Letta is stronger at agent-managed in-context memory; LangGraph is stronger at durable workflow composition; Hindsight is stronger at explicit recall/reflect learning patterns. Codex, Claude Code, and Cursor primarily persist coding instructions and repository learnings, so their file/rule-based memory is complementary rather than a replacement for narrative state management.

## 官方资料

- Open Character Memory repository: https://github.com/GuanZhuiGuo/open-character-memory
- OpenAI Codex repository: https://github.com/openai/codex
- OpenAI Codex Memories: https://learn.chatgpt.com/docs/customization/memories
- OpenAI Codex `AGENTS.md`: https://learn.chatgpt.com/docs/agent-configuration/agents-md
- Claude Code repository: https://github.com/anthropics/claude-code
- Claude Code memory: https://code.claude.com/docs/en/memory
- Cursor repository/product feedback entry: https://github.com/cursor/cursor
- Cursor Memories: https://docs.cursor.com/en/context/memories
- Cursor Rules: https://docs.cursor.com/context/rules
- Cursor Series D and scale disclosure: https://cursor.com/blog/series-d
- TencentDB Agent Memory: https://github.com/TencentCloud/TencentDB-Agent-Memory
- TencentDB Agent Memory v2.0.0: https://github.com/TencentCloud/TencentDB-Agent-Memory/releases/tag/v2.0.0
- Tencent Cloud Memory API: https://cloud.tencent.com/document/product/1813/132001
- Mem0 repository: https://github.com/mem0ai/mem0
- Mem0 Platform Graph Memory: https://docs.mem0.ai/platform/features/graph-memory
- Mem0 Platform v3 migration: https://docs.mem0.ai/migration/platform-v2-to-v3
- Zep graph model: https://help.getzep.com/v2/understanding-the-graph
- Zep Memory API: https://help.getzep.com/v2/memory
- Graphiti: https://github.com/getzep/graphiti
- Letta repository: https://github.com/letta-ai/letta
- Letta context hierarchy: https://docs.letta.com/guides/core-concepts/memory/context-hierarchy
- Letta memory blocks: https://docs.letta.com/guides/core-concepts/memory/memory-blocks
- LangGraph memory concepts: https://docs.langchain.com/oss/python/concepts/memory
- LangGraph persistence: https://docs.langchain.com/oss/python/langgraph/persistence
- LangGraph repository: https://github.com/langchain-ai/langgraph
- Hindsight: https://github.com/vectorize-io/hindsight
- Hindsight paper: https://arxiv.org/abs/2512.12818
