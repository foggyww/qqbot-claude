import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { Plugin, BotContext, MessageContext } from "../core/types.js";
import { registerCommand, unregisterCommand, unregisterDefaultCommand } from "../core/router.js";

// ---------------------------------------------------------------------------
// PluginSystem
// ---------------------------------------------------------------------------

export class PluginSystem {
  private plugins = new Map<string, Plugin>();
  private ccPluginDirs: string[] = [];
  private ctx: BotContext;

  constructor(ctx: BotContext) {
    this.ctx = ctx;
  }

  /** 手动注册单个插件 */
  async register(plugin: Plugin, pluginDir?: string): Promise<void> {
    if (this.plugins.has(plugin.name)) {
      this.ctx.logger.warn(`插件 "${plugin.name}" 已注册，跳过重复注册`);
      return;
    }

    // 注册命令
    if (plugin.commands) {
      for (const cmd of plugin.commands) {
        registerCommand(cmd);
        this.ctx.logger.debug(
          `注册命令: ${cmd.prefix ?? "(默认)"} → ${cmd.name}`,
        );
      }
    }

    // 记录 CC 原生插件目录
    if (plugin.ccPluginDir) {
      const absPath = pluginDir
        ? path.resolve(pluginDir, plugin.ccPluginDir)
        : path.resolve(plugin.ccPluginDir);
      if (fs.existsSync(absPath)) {
        this.ccPluginDirs.push(absPath);
        this.ctx.logger.info(`CC 原生插件: ${absPath}`);
      } else {
        this.ctx.logger.warn(`CC 原生插件目录不存在: ${absPath}`);
      }
    }

    // 调用 onLoad 钩子
    if (plugin.onLoad) {
      await plugin.onLoad(this.ctx);
    }

    this.plugins.set(plugin.name, plugin);
    this.ctx.logger.info(`插件 "${plugin.name}" v${plugin.version} 已加载`);
  }

  /** 卸载插件 */
  async unregister(name: string): Promise<void> {
    const plugin = this.plugins.get(name);
    if (!plugin) {
      this.ctx.logger.warn(`插件 "${name}" 不存在，无法卸载`);
      return;
    }

    // 注销命令
    if (plugin.commands) {
      for (const cmd of plugin.commands) {
        if (cmd.prefix !== undefined && cmd.prefix !== "") {
          unregisterCommand(cmd.prefix);
        }
        if (cmd.isDefault) {
          unregisterDefaultCommand(cmd);
        }
      }
    }

    // 移除 CC 原生插件目录
    if (plugin.ccPluginDir) {
      this.ccPluginDirs = this.ccPluginDirs.filter(d => !d.endsWith(plugin.ccPluginDir!));
    }

    try {
      if (plugin.onUnload) await plugin.onUnload(this.ctx);
    } finally {
      this.plugins.delete(name);
    }
    this.ctx.logger.info(`插件 "${name}" 已卸载`);
  }

  async unregisterAll(): Promise<void> {
    const names = [...this.plugins.keys()].reverse();
    for (const name of names) {
      try {
        await this.unregister(name);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.ctx.logger.error(`卸载插件 "${name}" 失败: ${message}`);
      }
    }
  }

  /**
   * 扫描并加载所有插件。
   * 加载顺序：内置插件 → 本地目录插件。
   */
  async loadPlugins(): Promise<void> {
    // 1. 内置插件目录
    const moduleDir = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);
    const builtinDir = path.resolve(moduleDir, "../plugin/builtin");
    const isBuiltRuntime = moduleDir.includes(`${path.sep}dist${path.sep}src${path.sep}`);
    await this.scanDirectory(builtinDir);

    // 2. 本地插件目录（开发模式加载源码；构建后优先加载 dist/plugins）
    const compiledLocalDir = path.join(process.cwd(), "dist", "plugins");
    const localDir = path.join(process.cwd(), "plugins");
    if (isBuiltRuntime && fs.existsSync(compiledLocalDir)) {
      await this.scanDirectory(compiledLocalDir);
    }
    if (fs.existsSync(localDir)) {
      await this.scanDirectory(localDir, false, isBuiltRuntime);
    }

    // 3. 项目配置目录下的 plugins（构建后同样优先 dist/plugins）
    const compiledProjectPluginDir = path.join(
      this.ctx.config.paths.projectDir,
      "dist",
      "plugins",
    );
    const projectPluginDir = path.join(
      this.ctx.config.paths.projectDir,
      "plugins",
    );
    if (
      isBuiltRuntime &&
      fs.existsSync(compiledProjectPluginDir) &&
      compiledProjectPluginDir !== compiledLocalDir
    ) {
      await this.scanDirectory(compiledProjectPluginDir);
    }
    if (fs.existsSync(projectPluginDir) && projectPluginDir !== localDir) {
      await this.scanDirectory(projectPluginDir, false, isBuiltRuntime);
    }
  }

  /**
   * 扫描目录中的插件文件并加载。
   * 支持：
   *  - index.ts / index.js（视为一个插件包）
   *  - <name>.plugin.ts / <name>.plugin.js
   *  - <name>.ts / <name>.js（兜底）
   */
  private async scanDirectory(
    dir: string,
    loadAllFiles = false,
    skipTypeScript = false,
  ): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      // 目录不存在或不可读
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        // 目录作为一个插件包：加载 <dir>/index.ts 或 <dir>/index.js
        const pkgPath = this.resolveModuleFile(path.join(dir, entry.name, "index"), skipTypeScript);
        if (pkgPath) {
          await this.loadPluginFile(pkgPath);
        }
        continue;
      }

      if (!entry.isFile()) continue;

      const ext = path.extname(entry.name);
      if (ext !== ".ts" && ext !== ".js" && ext !== ".mjs" && ext !== ".cjs") {
        continue;
      }
      if (skipTypeScript && ext === ".ts") continue;

      // 跳过非入口文件（如 helper、types、base 等）
      const stem = path.basename(entry.name, ext);
      if (stem.endsWith(".d")) continue;
      const lower = stem.toLowerCase();
      if (loadAllFiles ||
        lower === "index" ||
        lower.endsWith(".plugin") ||
        lower.endsWith("-plugin") ||
        lower.endsWith("_plugin")
      ) {
        await this.loadPluginFile(path.join(dir, entry.name));
      }
    }
  }

  /**
   * 解析模块文件的完整路径（自动补全扩展名）。
   */
  private resolveModuleFile(basePath: string, skipTypeScript = false): string | null {
    const extensions = skipTypeScript
      ? [".js", ".mjs", ".cjs"]
      : [".js", ".ts", ".mjs", ".cjs"];
    for (const ext of extensions) {
      const full = basePath + ext;
      if (fs.existsSync(full)) return full;
    }
    // 如果 basePath 已经是完整路径
    if (fs.existsSync(basePath)) return basePath;
    return null;
  }

  /**
   * 加载单个插件模块文件。
   */
  private async loadPluginFile(filePath: string): Promise<void> {
    const logger = this.ctx.logger;
    try {
      // tsx / ts-node 环境可直接 import .ts 文件
      // 纯 Node 环境需要 .js
      const mod: unknown = await import(pathToFileURL(filePath).href);

      // 模块导出
      const exports = mod as Record<string, unknown>;

      // 查找默认导出或命名导出 PluginClass / plugin
      const PluginCtor = exports.default ?? exports.Plugin ?? exports.plugin;

      if (typeof PluginCtor !== "function") {
        logger.warn(`跳过 ${filePath}：未找到插件导出`);
        return;
      }

      // 实例化
      const instance = new (PluginCtor as new () => Plugin)();

      if (!instance.name || !instance.version) {
        logger.warn(`跳过 ${filePath}：缺少 name 或 version`);
        return;
      }

      await this.register(instance, path.dirname(filePath));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`加载插件失败 ${filePath}: ${msg}`);
    }
  }

  /** 获取已注册的插件 */
  get(name: string): Plugin | undefined {
    return this.plugins.get(name);
  }

  /** 列出所有已注册的插件 */
  list(): Plugin[] {
    return [...this.plugins.values()];
  }

  /**
   * 调用所有插件的 onMessage 钩子（被动监听）。
   */
  async onMessage(msgCtx: MessageContext): Promise<void> {
    for (const plugin of this.plugins.values()) {
      if (plugin.onMessage) {
        try {
          await plugin.onMessage(msgCtx);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.ctx.logger.error(`插件 "${plugin.name}" onMessage 错误: ${msg}`);
        }
      }
    }
  }

  /** 获取所有插件提供的 MCP 服务器 */
  getAllMcpServers(): { plugin: string; server: import("../core/types.js").McpServer }[] {
    const result: { plugin: string; server: import("../core/types.js").McpServer }[] = [];
    for (const plugin of this.plugins.values()) {
      if (plugin.mcpServers) {
        for (const srv of plugin.mcpServers) {
          result.push({ plugin: plugin.name, server: srv });
        }
      }
    }
    return result;
  }

  /** 获取所有 CC 原生插件目录，用于传递给 Claude Code --plugin-dir */
  getCcPluginDirs(): string[] {
    return [...this.ccPluginDirs];
  }
}
