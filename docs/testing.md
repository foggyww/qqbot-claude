# Testing

## 默认验证

代码修改至少执行：

```bash
npm run typecheck
npm test -- --run
```

提交前建议执行：

```bash
npm run lint
```

涉及构建、CLI、Docker、发布流程时还应执行：

```bash
npm run build
docker compose config --quiet
```

涉及 shell 脚本时执行：

```bash
bash -n scripts/setup-docker.sh
```

## 测试分层

- `core/config`：配置加载、runtime 路径、环境变量覆盖。
- `core/context`：CQ 码清理、session key、消息上下文。
- `core/permission`：角色等级、群白名单、动态授权。
- `core/router`：命令解析、群聊 @、默认对话、权限分发。
- `plugin-system`：插件加载、命令注册、生命周期和 MCP 聚合。
- `mcp`：JSON-RPC、工具参数、结构化错误。
- `ai`：Claude 参数构造、路径绝对化、session 和 MCP config。
- `plugins/steam`：user mapping、API key、非 JSON 响应、缺失 Steam ID。

## 新增测试规则

- 修 bug 时优先新增能复现 bug 的测试。
- 修改权限、路由、配置、MCP、AI backend、插件 API 时必须考虑新增或更新测试。
- 测试不得依赖真实 QQ、真实 Steam API、真实 Claude CLI。
- 外部 API、WebSocket、子进程需要 mock 或 fake。
- 测试 fixture 不得包含真实密钥、QQ 登录态或隐私数据。
