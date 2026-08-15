# Contributing

感谢你改进 Memory Agent Studio。这个项目把“记得什么、何时更新、为何召回”视为可审计的产品行为，因此记忆正确性和用户隔离优先于增加更多自动化。

## Development setup

要求 Node.js 24 或更高版本。项目当前没有第三方运行时依赖。

```bash
npm run start:mock
```

Mock 模式只使用本地确定性向量与模拟文本回复，适合界面和数据流开发。接入真实 Provider 时，从 `.env.example` 创建 `.env.local`，不要提交任何密钥、SQLite 数据或 Trace 导出。

## Before opening a pull request

```bash
npm test
npm run eval
npm run check:open-source
```

涉及界面时，请同时验证普通用户只读视图、管理员编辑视图和窄屏布局。涉及模型调用时，测试必须提供本地 HTTP Mock，不能依赖外部配额。

## Memory invariants

- 每条业务查询必须硬过滤 `user_id / agent_id / story_id / branch_id`。
- 默认回答只使用 `active` 声明；`superseded / retracted` 只供审计。
- 称呼、长期回复规则、关系边界等固定控制不能依赖向量召回。
- 模型只能提出记忆操作，服务端负责字段白名单、边界、版本和写入顺序。
- 角色单方生成的故事不能静默升级为双方已发生的事实。
- 新的缓存、队列或数据库适配器不能成为第二个事实源。

## Change scope

提交尽量聚焦一个行为边界。数据库结构变更需包含向前迁移、已有数据兼容和回归用例；公开 API 或配置项变更需同步中英文 README 与 `.env.example`。

请勿在 Issue、PR、截图或测试夹具中粘贴真实陪聊内容、密码、Cookie、API Key 或未脱敏 Trace。
