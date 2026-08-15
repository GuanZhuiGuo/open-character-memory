# Security Policy

## Supported version

安全修复目前只维护最新的 `0.2.x` 版本。该项目仍处于预发布阶段，生产使用者应固定经过审查的 commit，而不是自动跟随主分支。

## Reporting a vulnerability

请使用 GitHub 仓库的 **Security > Report a vulnerability** 私下提交报告，不要创建公开 Issue。报告应包含受影响版本、攻击前提、复现步骤和影响范围，并删除真实用户对话与凭据。

我们会尽快确认是否收到报告；确认漏洞后，将在修复可用前限制公开细节。

## Deployment baseline

- `NODE_ENV=production` 时必须设置至少 12 位且非示例值的 `ADMIN_PASSWORD`，否则进程拒绝启动。
- `.env.local`、SQLite 数据、Trace 导出和会话 Cookie 不得进入 Git 或容器镜像。
- 公网部署应在反向代理处启用 HTTPS、请求体限制、速率限制和可信代理头配置。
- 多租户生产环境应使用企业身份系统、细粒度 RBAC、Secret Manager/KMS 和集中审计，不应把本项目的单管理员密码当成最终权限系统。
- 模型输出和召回内容均视为不可信数据；结构化写入必须经过服务端白名单与边界校验。

## Scope boundary

本仓库提供的是可运行的记忆系统参考实现，不承诺当前 SQLite、进程内锁和同步抽取模式可直接满足高并发、多副本或强合规生产要求。相关迁移边界见 `docs/postgresql-pgvector-migration.md`。
