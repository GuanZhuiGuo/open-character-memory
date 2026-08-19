# Headless Memory Runtime 与 SDK

## 目标

Open Character Memory 的新公共边界只负责四件事：

1. 接收不可变对话或工具证据。
2. 将经过策略校验的提案写入双时态记忆账本。
3. 在服务端锁定作用域后返回结构化 `ContextPack`。
4. 为 Agent Runtime 提供可选的只读二次召回工具。

角色聊天、剧情、道具、注册、反馈和 Studio UI 都不是记忆内核。现有产品保留原路由，新接入方使用 `/v1/memory/*`。

## 代码分层

```text
packages/memory-core        纯契约、作用域、请求校验和 ContextPack
lib/memory-service.js       服务编排、幂等、证据账本、持久化任务
packages/sdk                Fetch 型 TypeScript/JavaScript SDK 与类型声明
packages/adapters/generic   beforeModel / afterModel 通用钩子
packages/adapters/pi        Pi Agent 的 prepareTurn / commitTurn 适配器
packages/mcp-server         作用域锁定的只读 MCP stdio Server
openapi/memory-v1.yaml      版本化 HTTP 契约
apps / public               现有 Studio 产品层
```

## 五个原子操作

| 操作 | HTTP | 语义 |
| --- | --- | --- |
| `observe` | `POST /v1/memory/observe` | 追加原始证据，快速规则同步生效，普通抽取可入队 |
| `recall` | `POST /v1/memory/recall` | 只返回当前作用域的 active 记忆与来源证据 |
| `expand` | `POST /v1/memory/expand` | 按事件 ID 或实体名展开声明和图谱邻居 |
| `mutate` | `POST /v1/memory/mutate` | 受信应用/管理员的确定性写入 |
| `forget` | `DELETE /v1/memory` | 撤回或物理删除单条结构化记忆/事件 |

`observe`、`mutate` 与 `forget` 必须带 `idempotencyKey`。同一 tenant 下使用相同 key 重试完全相同的请求时，只返回原回执，不重复写入；如果该 key 被复用到不同 payload 或作用域，服务返回 `409 MEMORY_IDEMPOTENCY_*_CONFLICT`。

## 作用域

```json
{
  "tenantId": "default",
  "subjectId": "user_xiaoyu",
  "agentId": "agent_linwan",
  "spaceId": "main_story",
  "branchId": "main"
}
```

`subjectId` 是被记忆的主体，可以是用户、学生、客户或角色。当前 SQLite 兼容适配器仍将 `subjectId` 映射为现有 `users.id`，`agentId` 映射为 `agents.id`；公共契约不暴露这一产品层命名。

用户会话只能访问自己的 `subjectId`。`MEMORY_SERVICE_API_KEY` 可访问当前 tenant 的记忆 API，但被硬限制为 `/v1/memory/*`，不能操作 Studio 管理 API。

## 快速接入

服务端设置：

```bash
MEMORY_TENANT_ID=default
MEMORY_SERVICE_API_KEY=replace-with-a-long-random-service-key
npm start
```

Agent 侧：

```js
import { MemoryClient } from '@open-character-memory/sdk';

const memory = new MemoryClient({
  baseUrl: 'http://127.0.0.1:4173',
  apiKey: process.env.MEMORY_SERVICE_API_KEY
}).scope({
  tenantId: 'default',
  subjectId: userId,
  agentId,
  spaceId: storyId,
  branchId: 'main'
});

const pack = await memory.recall({ query: userText });
const result = await agent.run({
  messages,
  context: pack.blocks,
  tools: [...businessTools, ...memory.readTools()]
});

await memory.observe({
  idempotencyKey: turnId,
  threadId,
  extractionMode: 'async',
  messages: [
    { role: 'user', content: userText },
    { role: 'assistant', content: result.text }
  ]
});
```

## 写入与任务语义

- `extractionMode=none`：只保留证据并执行显式控制快速通道。
- `extractionMode=sync`：证据落账后在请求内完成抽取，适合测试或强一致轮次。
- `extractionMode=async`：返回 `202 + job id`，持久化 worker 重试抽取，显式称呼/风格/禁止项仍同步生效。

当前 worker 面向单机 SQLite，具备持久化任务、幂等 observation、指数退避和最大尝试次数。任务是 at-least-once attempts，并不承诺 exactly-once commit；它也不等同于多副本分布式队列。

## MCP

MCP 只暴露 `memory_search` 和 `memory_expand`，不暴露任何写工具。作用域由启动进程注入，模型参数中没有 user/agent/story/branch。

```bash
export MEMORY_SERVICE_URL=http://127.0.0.1:4173
export MEMORY_SERVICE_API_KEY=replace-with-a-long-random-service-key
export MEMORY_SCOPE_JSON='{"tenantId":"default","subjectId":"user_xiaoyu","agentId":"agent_linwan","spaceId":"main_story","branchId":"main"}'
npm run mcp:memory
```

## 兼容与当前限制

- 现有 `/api/chat`、每 X 轮抽取、剧情触发、Trace 和 Studio 数据表不变。
- 新表仅包含 observation、observation message、job 和 operation receipt，历史记忆数据无需迁移。
- v1 语义召回只返回 active 状态。现有图谱/事件 API 继续提供 `valid_at + known_at` 历史回放；v1 的历史语义召回尚未开放。
- SDK 当前是 alpha 且随仓库发布，已有类型声明、错误码、超时、幂等和 HTTP 契约测试，尚未独立发布 npm/PyPI。
- PostgreSQL/pgvector、多 tenant 行级权限、分布式 worker 和 Python SDK 仍是下一阶段。
