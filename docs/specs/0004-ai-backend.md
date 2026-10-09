# Spec 0004: Claude Code Backend

## Status
Accepted

## Scope

Claude Code CLI 调用、chat/root 模式、session、MCP config、`--add-dir`、环境变量注入。主要涉及 `src/ai/claude-code.ts` 和调用该 backend 的内置命令。

## Goals

- Claude Code 运行参数稳定、安全、可跨 Docker 和本机工作。
- session、MCP config 和 workspace 路径不受当前工作目录变化影响。

## Rules

- 默认使用当前进程用户直接运行 Claude Code。
- Docker 推荐部署中 Claude Code CLI 由镜像提供，不依赖宿主机安装。
- `[run].use_sudo=true` 仅作为旧式宿主机兼容项，不是默认路径。
- `sessionDir`、MCP config 路径、`--add-dir` 路径必须绝对化。
- `--add-dir` 必须作为多个独立参数传入，不能把多个路径拼成一个参数。
- `CLAUDE_CONFIG_DIR` 默认应从配置的 projects 目录推导。
- Claude 环境变量由 `config.env` 和 `process.env` 合并，不能打印完整密钥。
- 大段 prompt 必须从 `prompts/*.md` 读取，不能硬编码。

## Behavior

- Chat 模式使用会话目录和 Claude session id 支持连续对话。
- Root 模式可加入项目目录和 workspace 作为允许目录。
- MCP config 文件写入当前 session 目录，并以绝对路径传给 Claude Code。
- 普通和 one-shot 调用的非零退出码、signal 退出均为失败，不得向用户返回 stderr 或部分成功输出。
- 全局最多运行 2 个 Claude 子进程；满载时立即返回忙碌错误，不无限堆积等待。
- stdout/stderr 合计最多收集 2 MiB；超限、超时和 Bot 停止时终止 Linux 子进程组（含后代），及时清理计时器和并发额度。
- AI 调用可附加源自真实 MessageContext 的可信请求上下文，供 MCP Host 校验记账身份；不得从模型生成文本恢复身份。

## Error Handling

- Claude Code 超时、退出码异常、MCP config 缺失应返回可诊断错误。
- 子进程 stderr 可记录，但必须避免泄漏密钥。

## Security

- 不通过 shell 字符串拼接执行 Claude Code。
- 不把密钥写入 session 文件以外的公开文件或日志。
- root 模式不能绕过项目权限规则。

## Tests

修改本范围时应考虑新增或更新 AI backend 参数构造测试。现有验证至少执行：

- `npm run typecheck`
- `npm test -- --run`

## Acceptance Checklist

- [ ] 路径绝对化。
- [ ] `--add-dir` 参数拆分正确。
- [ ] Docker 和本机默认用户策略未被破坏。
