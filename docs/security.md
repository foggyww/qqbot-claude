# Security

## 禁止提交

永远不要提交：

- `.qqbotrc.toml`
- `.env`
- `runtime/`
- `data.migrated-*/`
- QQ 登录态、cookie、token、API key、session 文件
- 真实群消息、私聊内容、用户隐私数据

## 密钥来源

- qqbot 运行配置通过 `.qqbotrc.toml` 的 `[env]` 或进程环境变量注入。
- Docker Compose / NapCat 编排变量通过 `.env` 注入。
- 公开模板只能使用空字符串或占位符。
- 不依赖宿主机 `.bashrc` 提供插件运行所需密钥。

## 日志和错误

- 不打印完整 API key、token、cookie。
- 不打印 `.qqbotrc.toml` 的 `[env]` 内容。
- 错误消息可以说明“缺少 key”，不能输出 key 本身。
- 第三方 API 错误响应可能包含敏感信息，记录前应截断或过滤。
- 包含群号、Steam ID、游戏行为等隐私数据的 runtime 目录应使用 `0700`，状态文件应使用 `0600`。

## 提交前检查

提交前必须检查暂存区：

```bash
git diff --cached
```

重点搜索：

- `sk-`
- `token`
- `api_key`
- `STEAM_WEB_API_KEY`
- `ANTHROPIC_AUTH_TOKEN`
- `DEEPSEEK_API_KEY`
- `cookie`
