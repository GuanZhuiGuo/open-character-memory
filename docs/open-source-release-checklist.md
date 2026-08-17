# GitHub 发布前检查清单

## P0 阻断项

- [ ] 从 Git 历史和待提交文件中清除 API Key、密码、Cookie、真实 Trace 与真实用户对话。
- [ ] 确认公开地址为 `https://github.com/GuanZhuiGuo/open-character-memory`。
- [ ] 确认 `LICENSE`、`SECURITY.md`、`CONTRIBUTING.md` 和中英文 README 的发布主体与联系方式。
- [ ] 使用 Node.js 24 运行 `npm test`、`npm run eval`、`npm run check:open-source`。
- [ ] 构建 Docker 镜像，并以 Mock 模式完成注册、聊天、记忆查询、Trace 和管理员配置烟测。
- [ ] 生产模式不提供 `ADMIN_PASSWORD` 或使用示例值时，确认进程拒绝启动。

## 代码与接口

- [ ] 固定版本为 `v0.5.0`，创建 annotated tag，不把工作区未提交内容混入发布。
- [ ] Ark、OpenAI、Anthropic 和 Mock 的配置项均有说明；无密钥测试不会发起真实请求。
- [ ] 缓存失败可回退完整请求；缓存键随角色版本、场景版本、模型和 Prompt 变化。
- [ ] Trace 能看到 Provider、输入 Token、缓存 Token、状态与命中率，但不泄露凭据。
- [ ] 数据库新增列和表可从已有 `0.2.4` SQLite 数据原地迁移。

## 记忆质量

- [ ] 旧结论更正后只召回 active 版本。
- [ ] 无关梦境不会被纸条、诗等当前话题误召回。
- [ ] 用户之间以及角色/故事/分支之间无数据串联。
- [ ] 角色承诺可进入 `shared_story` 并带来源证据。
- [ ] 性别更正后旧剧情支线保留审计，但不再注入主模型。
- [ ] 零候选 Planner 改写可跳出首轮候选池，且主模型记忆工具不能更换 scope 或读取非 active 版本。

## GitHub 发布动作

```bash
git status --short
git diff --check
npm test
npm run eval
npm run check:open-source
docker build -t open-character-memory:0.5.0 .
git add <reviewed-files>
git commit -m "Release v0.5.0 Open Character Memory"
git tag -a v0.5.0 -m "Open Character Memory v0.5.0"
git push origin <branch>
git push origin v0.5.0
```

首次发布前先创建空远程仓库并配置分支保护、私密漏洞报告和 Actions 权限。不要在运行中的服务器目录直接逐文件覆盖；部署应拉取已验证 commit 或镜像 digest，健康检查成功后再切换流量。
