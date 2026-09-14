/** Locale dictionary for the Telegram plugin configuration card. */

/** Every user-visible string the card owns. */
export type TelegramLocaleKey =
  | 'title' | 'description'
  | 'token' | 'tokenHint'
  | 'chatId' | 'chatIdHint'
  | 'workspacePath' | 'workspacePathHint'
  | 'agentPreset' | 'agentPresetHint'
  | 'overridden' | 'reset' | 'save' | 'discard' | 'saving' | 'saveFailed' | 'unavailable'
  | 'expand' | 'collapse' | 'unsaved' | 'readOnly'

/** English copy. */
export const en: Record<TelegramLocaleKey, string> = {
  title: 'Telegram',
  description: 'Private Telegram chat routing for DSH.',
  token: 'Bot token',
  tokenHint: 'BotFather token. Saving it takes effect after a DSH restart.',
  chatId: 'Authorized chat ID',
  chatIdHint: 'Only this private Telegram chat can control DSH.',
  workspacePath: 'Workspace path',
  workspacePathHint: 'Absolute workspace for sessions created from Telegram.',
  agentPreset: 'Agent preset',
  agentPresetHint: 'Preset used for sessions created from Telegram.',
  overridden: 'overridden',
  reset: 'Reset',
  save: 'Save',
  discard: 'Discard',
  saving: 'Saving…',
  saveFailed: 'Save failed',
  unavailable: 'Telegram settings are unavailable in this browser.',
  expand: 'Expand',
  collapse: 'Collapse',
  unsaved: 'Unsaved',
  readOnly: 'This settings document is read-only in this browser.',
}

/** Chinese copy. */
export const zh: Record<TelegramLocaleKey, string> = {
  title: 'Telegram',
  description: '为 DSH 配置私聊 Telegram 路由。',
  token: '机器人 Token',
  tokenHint: '来自 BotFather；保存后重启 DSH 生效。',
  chatId: '授权 Chat ID',
  chatIdHint: '仅此 Telegram 私聊可以控制 DSH。',
  workspacePath: '工作目录',
  workspacePathHint: '从 Telegram 创建会话时使用的绝对工作目录。',
  agentPreset: 'Agent Preset',
  agentPresetHint: '从 Telegram 创建会话时使用的 preset。',
  overridden: '已覆盖',
  reset: '重置',
  save: '保存',
  discard: '放弃',
  saving: '保存中…',
  saveFailed: '保存失败',
  unavailable: '当前浏览器无法使用 Telegram 设置。',
  expand: '展开',
  collapse: '收起',
  unsaved: '有未保存改动',
  readOnly: '当前浏览器中的设置文档为只读。',
}
