# Code Style

## TypeScript

- 使用 TypeScript strict，不引入隐式 `any`。
- ESM import/export，不使用 CommonJS。
- 公共接口优先放在 `src/core/types.ts`；插件内部私有类型可留在插件目录。
- 外部 JSON、OneBot event、MCP payload 等边界数据可以先用宽类型接收，但必须尽快收窄和校验。
- 异步函数必须明确处理 Promise；禁止无意 fire-and-forget。

## 命名

- 类型、接口、类：`PascalCase`。
- 函数、变量：`camelCase`。
- 真正常量：`UPPER_SNAKE_CASE`。
- 文件名遵循现有风格，优先 kebab-case；不要无理由混用命名风格。

## 模块边界

- `src/core/`：框架核心、配置、路由、权限、上下文。
- `src/adapter/`：协议适配，不写业务权限逻辑。
- `src/ai/`：Claude Code backend，不写 QQ 业务逻辑。
- `src/mcp/`：MCP Host 和内置 MCP server。
- `src/plugin/`：插件系统和内置插件。
- `plugins/`：自包含外部插件。

## 代码组织

- 不在 `router.ts` 中堆叠复杂业务；复杂命令应放入内置命令模块或插件。
- 不在 `config.ts` 中写插件逻辑。
- 不在 adapter 中做权限判断。
- 单文件过大时按职责拆分，而不是继续增加分支。
- 保持函数单一职责；跨模块行为要有 spec 支撑。
