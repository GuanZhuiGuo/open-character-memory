# 平台陪聊角色记忆

Voice 与 Companion 使用 `companion_memory` 平台委托调用 `/v1/memory/bind`、`observe`、`recall` 和 `library`。服务端据真实 tenant、user 和稳定 roleId 派生角色空间；相同角色在语音和数字人模式共享记忆，浏览器不能选择其他账户。

`library` 返回长期记忆、共同经历、关系和对话观察的只读投影，不开放编辑、遗忘或 Studio 管理操作。核心 schema 中用户范围的偏好与安全约束按同一真实用户共享，角色经历按角色空间保存。

业务后端将真实完成的对话轮次交给 `observe`，使用稳定轮次键和异步抽取。模型请求前调用 `recall`，将 ContextPack.blocks 作为历史证据注入上下文；这些内容不是新的执行指令。观察记录、后台委托与任务使用现有持久数据库，代码发布保留数据库路径。

`test/platform-companion-memory.test.js` 验证同角色跨模式共享、跨用户和角色空间伪造拒绝、只读库与幂等。平台的 `scripts/test_education_memory_e2e.py --companion-memory` 验证真实 SDK、Python broker 与 Memory HTTP/SQLite。上述夹具的模型输出不作为供应商语义抽取验收。
