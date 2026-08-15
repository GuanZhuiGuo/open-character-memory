# 稳定前缀缓存设计

## 目标

降低每轮重复发送角色人设与固定属性的成本，同时保证动态记忆不因缓存而过期。缓存是模型输入的传输优化，不是新的记忆库。

## Input 分层

稳定前缀包括角色人设、运行时通用硬规则和角色固定属性。动态部分包括当前用户/角色/故事/分支命名空间、常驻结构化记忆、已解锁剧情、两阶段召回结果和最近 16 条对话消息。

稳定前缀由 `lib/agent.js` 编译，Provider 只负责如何向上游表达缓存。SQLite 中的 `model_prefix_caches` 只保存 Ark Context ID、版本键、过期时间和命中统计，不保存另一份业务状态。

## 缓存键与失效

逻辑键由以下字段组成：

```text
provider + model + agent_id + profile_version + scene_config_version + stable_prompt_hash
```

管理员修改人设或固定属性时 `profile_version` 增长，因此旧上下文自然失效。场景配置更新时间变化也会生成新键。TTL 到期、上游返回无效 Context、模型切换或 Prompt Hash 变化都会触发重建。

## Provider 行为

- Ark：使用 `common_prefix` 创建 Context；后续请求只发送动态系统段和短期对话。Context 调用失败时使本地记录失效，并以完整 Responses 请求降级完成本轮。
- OpenAI：保持稳定内容位于输入开头，由 Provider 管理缓存；从 usage 读取 cached tokens。
- Anthropic：稳定系统块携带 `cache_control`，动态系统块不缓存。
- Mock：不创建缓存，用于离线开发和 CI。

## Trace

`model_response` Span 返回 `provider / usage / cache`。界面显示输入 Token、缓存 Token、缓存状态和命中率；原始 Span 仍保留完整输入组成，便于确认动态记忆没有被错误放进稳定前缀。
