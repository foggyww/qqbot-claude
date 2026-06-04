/**
 * /schedule 指令 —— 定时任务管理
 *
 * 对应 Python: src/qqbot/commands/builtin/schedule_cmd.py
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Command, MessageContext, ScheduledTask } from "../../core/types.js";
import type { Plugin } from "../../core/types.js";
import { askClaude, TimeoutError } from "../../ai/claude-code.js";
import { getScheduler } from "../../scheduler/index.js";

// ---------------------------------------------------------------------------
// System prompt (matching Python's schedule SYSTEM_PROMPT)
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `你是定时任务管理助手。用户想设置、删除或查看定时任务。

后台有一个内置 cron 调度器在运行，你通过 schedule CLI 写入 .schedules.json 后，调度器会自动加载并在到点时真正触发执行。到点后会向 AI 发送触发消息，AI 再决定具体做什么。

你必须用 Bash 执行 schedule 命令完成用户要求，不能只给建议，不能让用户手动一条条添加。
本命令的返回值会由 bot 自动回复给用户，严禁调用 send_message 或 delete_message。
如果需要理解上下文，可以调用只读 QQ MCP 工具，例如 get_group_msg_history、get_private_msg_history、get_group_members、get_user_info、get_user_mapping、get_my_info。
如果用户要求批量添加多个提醒，就连续执行多条 schedule add，每个时间点一条。

可用命令（通过 Bash 执行）：
  schedule list <session_dir>                    — 查看所有任务
  schedule add <session_dir> <名称> <cron> <触发消息>  — 添加一条任务
  schedule remove <session_dir> <名称>          — 删除
  schedule enable/disable <session_dir> <名称>  — 启用/禁用

session_dir 必须使用下面用户消息里提供的绝对路径。Claude 子进程 cwd 也是该目录，但仍要显式传 session_dir 参数。

重要：cron 表达式和触发消息包含空格，执行 Bash 时必须加引号，避免空格拆参和 * 被 glob 展开。
正确示例：
  schedule add /path/to/session "major-0602-1820" "20 10 2 6 *" "现在18:20了，群友们准备看比赛啦，请艾特所有人"

cron 格式：分 时 日 月 周 (五字段，空格分隔)，时区 UTC。
例如 UTC 每天 0 点 = 0 0 * * *
例如 UTC 每周一中午 12 点 = 0 12 * * 1

注意：服务器使用 UTC 时间，用户的"早上8点"需要换算成 UTC。
添加任务时告诉用户触发时间（换算回用户时区）。任务名用英文简写。
完成后 stdout 输出确认。`;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handle(
  msg: string,
  sessionDir: string,
  ctx: MessageContext,
): Promise<string> {
  const store = ctx.sessionStore;

  // No args: show current tasks
  if (!msg.trim()) {
    const p = path.join(sessionDir, ".schedules.json");
    if (fs.existsSync(p)) {
      try {
        const tasks: ScheduledTask[] = JSON.parse(fs.readFileSync(p, "utf-8"));
        if (!tasks.length) {
          return "暂无定时任务。\n用法: /schedule 每天早上8点提醒主人吃早饭";
        }
        const lines = ["当前定时任务："];
        for (const t of tasks) {
          const s = t.enabled !== false ? "启用" : "禁用";
          lines.push(`  [${s}] ${t.name} | cron=${t.cron} | ${t.msg}`);
        }
        return lines.join("\n");
      } catch {
        return "定时任务文件损坏，请重置。";
      }
    }
    return "暂无定时任务。\n用法: /schedule 每天早上8点提醒主人吃早饭";
  }

  // With args: delegate to Claude
  const model = store.loadModel(sessionDir);
  const effort = store.loadEffort(sessionDir);
  // Use a fresh Claude Code invocation for schedule management. Reusing the
  // normal chat session leaks conversational/persona context into this command
  // and makes Claude reply via QQ tools instead of executing schedule CLI.
  const sessionId = null;

  const p = path.join(sessionDir, ".schedules.json");
  let existing = "";
  if (fs.existsSync(p)) {
    try {
      existing = JSON.stringify(JSON.parse(fs.readFileSync(p, "utf-8")), null, 2);
    } catch {
      existing = "(文件损坏)";
    }
  }

  const now = new Date();
  const nowUtc = now.toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const bjTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const nowBj = bjTime.toISOString().replace("T", " ").slice(0, 16) + " 北京时间";

  const fullMsg = [
    `当前时间: ${nowUtc} / ${nowBj}`,
    `用户消息: ${msg}`,
    "",
    `当前已有定时任务(session_dir=${sessionDir}):\n${existing || "(无)"}`,
    "",
    "请根据用户意图，用 Bash 执行 schedule 命令来管理定时任务。批量任务必须逐条执行 schedule add。",
    "可以用只读 QQ MCP 工具获取聊天上下文，但不要调用 send_message/delete_message，不要让用户手动添加。",
    "完成后用 stdout 输出确认（换算回用户时区显示触发时间）。",
  ].join("\n");

  try {
    const reply = await askClaude(fullMsg, sessionDir, sessionId, SYSTEM_PROMPT, model, effort);

    // Reload scheduler (notify via file change or explicit call)
    triggerSchedulerReload(sessionDir);

    return reply;
  } catch (err) {
    if (err instanceof TimeoutError) {
      return "Claude Code 处理超时";
    }
    throw err;
  }
}

/**
 * Signal the scheduler to reload tasks for a session.
 * Mirrors Python: remove_all_for(session_dir) + reload_from(session_dir)
 */
function triggerSchedulerReload(sessionDir: string): void {
  getScheduler().removeAllFor(sessionDir);
  getScheduler().reloadFrom(sessionDir);
}

// ---------------------------------------------------------------------------
// Plugin registration
// ---------------------------------------------------------------------------

export const COMMANDS: Command[] = [
  {
    name: "schedule",
    description: "定时任务管理",
    prefix: "/schedule",
    minLevel: 2,
    handler: handle,
  },
];

export default class SchedulePlugin implements Plugin {
  name = "schedule";
  version = "1.0.0";
  description = "/schedule 指令 —— 定时任务管理";
  commands = COMMANDS;
}
