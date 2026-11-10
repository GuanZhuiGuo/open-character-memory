# Memory Agent Studio 协作规则

本仓库是 Memory 服务的权威源码。任务开始读取 README.md、CHANGELOG.md、platform.integration.json 和平台协作契约，核对 Git HEAD、未提交改动及目标环境。

平台协作契约位于 `/Users/bytedance/work/项目/demo-platform/docs/platform-contract.md`，当前使用 `contract_version=1`。统一身份、中央模型配置、用户额度、服务委托、个人数据归属及发布门禁按该契约执行。平台文档不可读时，保留改动并报告缺失项。

## 开发与数据

- 业务代码和平台适配均在本仓库修改并提交。平台发布目录与 overlay 只保存经审查的交付快照。
- 统一平台部署保持 `PLATFORM_ENABLED=true`，通过共享 SDK 核验身份并调用中央模型配置。中央服务失败时拒绝请求，后台任务显式捕获和恢复原用户委托。
- 账户、访客历史绑定和租户/用户/角色/故事/分支隔离由服务端核验。浏览器期望用户字段仅用于切号一致性检查。
- 保留原有未提交内容。`data/`、运行数据库、委托数据库、上传、环境文件、凭据及运行日志不进入源码提交或发布包。
- Studio 使用 server.js，外部任务使用 scripts/deep-agent-worker.js，同一部署使用同一源码版本。`apps/headless-memory/` 是独立进程，接入须单独声明部署、身份和数据库。

## 验证与发布

运行环境为 Node.js 24。执行 `npm test`、`npm run eval` 和 `npm run check:open-source`。平台回归还需设置 `PLATFORM_TEST_SDK_PATH` 为平台仓库的 `deploy/service-sdk/node-platform.cjs`，缺少 SDK 时被跳过的平台测试不能记为平台验收通过。

交付声明为 platform.integration.json，记录测试 argv、必需跟踪文件、持久目录和迁移入口。新增运行文件必须纳入 Git 和声明。平台门禁从已提交源码导出隔离候选，完成源码、契约与集成验证。

统一平台目标使用以下入口，参数和激活步骤以平台契约为准。

```bash
python3 /Users/bytedance/work/项目/demo-platform/scripts/release_service.py prepare \
  --service memory --source . --node /absolute/path/to/node24 \
  --output /absolute/path/to/memory-candidate.tar.gz
```

候选准备、服务器激活、真实上游和公网验收分别记录状态。发布只处理 Memory 及其 worker，保留既有环境、数据和恢复点。独立开源发行按 docs/open-source-release-checklist.md 执行。

Release Note 对每项能力记录对应 Bad Case、复现输入、旧结果、新结果和评测状态。没有当前验证证据的结果标记为待验证。架构与发布文档同步反映实际入口、授权、任务及数据边界。
