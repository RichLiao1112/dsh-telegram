/**
 * The Telegram command menu published through `setMyCommands`: the adapter's
 * own chat commands in the order Telegram lists them. Commands from the Host
 * registry stay out, because their set follows the selected agent's scope while
 * one bot-wide menu cannot; `/help` lists them for the selected session.
 */

/** One menu row, following the Bot API `BotCommand` fields. */
export interface TelegramCommandMenuEntry {
  /** Command name without the leading slash; Telegram accepts `[a-z0-9_]{1,32}`. */
  readonly command: string
  /** Menu description; Telegram rejects one above 256 characters. */
  readonly description: string
}

/** The adapter's own commands, ordered for Telegram's client-side list. */
export const TELEGRAM_COMMAND_MENU: readonly TelegramCommandMenuEntry[] = [
  { command: 'new', description: '新建并选中一个会话' },
  { command: 'sessions', description: '列出并切换存活会话' },
  { command: 'model', description: '选择 provider、模型与推理强度' },
  { command: 'status', description: '当前会话的标题、id 与状态' },
  { command: 'rename', description: '改当前会话标题：/rename <标题>' },
  { command: 'cancel', description: '取消当前工作与运行中的命令' },
  { command: 'answer', description: '回答待处理问题：/answer <文本>' },
  { command: 'use', description: '按 id 切换会话：/use <sessionId>' },
  { command: 'help', description: '命令列表与用法' },
  { command: 'commands', description: '/help 的别名' },
  { command: 'start', description: '打开命令列表' },
]
