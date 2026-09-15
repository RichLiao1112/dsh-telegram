/**
 * Telegram Bot API adapter for one or more configured live DSH agents.
 * @module @richliao1112/dsh-telegram
 */

import { randomUUID } from 'node:crypto'
import { openAsBlob } from 'node:fs'
import { lstat, stat } from 'node:fs/promises'
import { basename, extname, resolve as resolvePath } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-settings'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-commands'
import type { CommandSubmitAttachment } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { ApprovalOutcome, ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'
import type { AskUserQuestionAnswer, AskUserQuestionItem, AskUserQuestionRequestEvent } from '@deepseek-ai/dsh-user-questions/types'
import type {} from '@deepseek-ai/dsh-attachment'
import z from '@deepseek-ai/schemastery'
import { TELEGRAM_COMMAND_MENU } from './command-menu.ts'
import { exportTelegramSessionLog } from './export-command.ts'
import { telegramModelCommand } from './model-command.ts'
import {
  effortCard,
  modelAt,
  QUICK_ACTIONS,
  modelCard,
  providerCard,
  providerAt,
  sessionCard,
  type Card,
  type CardKeyboard,
} from './cards.ts'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller'
import { telegramRenameCommand } from './rename-command.ts'
import { clampStreamText, shouldFlushStream, streamTextOf } from './progress.ts'
import { boardTitle, renderToolBoard, type ToolBoardLine } from './tool-board.ts'
import { splitMarkdown, stripMarkup, toTelegramHtml } from './markdown.ts'
import {
  admitTelegramPrompt,
  collectTelegramMedia,
  stageTelegramSubmissions,
  type TelegramMediaInput,
} from './attachments.ts'

/** One Telegram private chat's authorized session routing and creation settings. */
export interface ChatRoute {
  /** Numeric Telegram private-chat id. */
  readonly chatId: string
  /** Optional initially selected live DSH agent/session id. Omit to create on first message. */
  readonly agentId?: string
  /** Absolute workspace directory for sessions created for this chat. */
  readonly workspacePath: string
  /** Agent preset mounted into sessions created for this chat. */
  readonly agentPreset: string
}

/** Configuration for the Telegram Bot API adapter. */
export interface Config {
  /** Bot token issued by @BotFather. Settings may override it at startup. */
  readonly token: string
  /** Explicit allowlist and agent routing table. Group chats are intentionally unsupported. */
  readonly chats: ChatRoute[]
  /** Long-poll hold time in seconds. */
  readonly pollTimeoutSeconds: number
  /** Maximum characters sent in each Telegram message. */
  readonly maxMessageChars: number
  /**
   * Whether tool calls are published to the chat. Off by default: the chat
   * carries the typing indicator, the streamed reply, and the merged tool
   * message only when a deployment asks for it.
   */
  readonly toolProgress: boolean
  /** Whether the reply is streamed into one edited message as it is produced. */
  readonly streamReplies: boolean
  /** Minimum seconds between two edits of the same streamed reply. */
  readonly streamEditIntervalSeconds: number
  /** Whether the bot shows Telegram's typing indicator while a turn runs. */
  readonly typingIndicator: boolean
}

/** Persisted single-chat Telegram configuration edited by the Web Plugins page. */
export interface TelegramSettings {
  token?: string
  chatId?: string
  workspacePath?: string
  agentPreset?: string
  /** Session this chat last selected, resumed after a restart. */
  sessionId?: string
}

/** Settings namespace shared with the Web configuration card. */
export const TELEGRAM_SETTINGS_NAMESPACE = 'telegram'

/** Schema for the user-editable Telegram configuration. */
export const TelegramSettingsSchema: z<TelegramSettings> = z.object({
  token: z.string(),
  chatId: z.string(),
  workspacePath: z.string(),
  agentPreset: z.string(),
  sessionId: z.string(),
})

/** The file identity and size every Telegram media field carries. */
interface TelegramFileFields {
  readonly file_id?: string
  readonly file_size?: number
}

interface TelegramUpdate {
  readonly update_id: number
  readonly message?: {
    readonly chat?: { readonly id?: number | string; readonly type?: string }
    readonly text?: string
    readonly caption?: string
    readonly media_group_id?: string
    readonly photo?: readonly { readonly file_id?: string; readonly file_size?: number }[]
    readonly document?: TelegramFileFields & { readonly file_name?: string; readonly mime_type?: string }
    readonly audio?: TelegramFileFields & { readonly file_name?: string; readonly mime_type?: string }
    readonly video?: TelegramFileFields & { readonly file_name?: string; readonly mime_type?: string }
    readonly voice?: TelegramFileFields & { readonly mime_type?: string }
    readonly sticker?: TelegramFileFields & { readonly is_animated?: boolean; readonly is_video?: boolean }
    readonly animation?: TelegramFileFields & { readonly file_name?: string; readonly mime_type?: string }
    readonly video_note?: { readonly file_id?: string; readonly file_size?: number }
  }
  readonly callback_query?: {
    readonly id?: string
    readonly data?: string
    readonly message?: {
      readonly message_id?: number
      readonly chat?: { readonly id?: number | string; readonly type?: string }
    }
  }
}

/** One chat's live typing indicator. */
interface TypingEntry {
  /** Scheduled refresh, absent once the indicator retires. */
  timer: ReturnType<typeof setTimeout> | undefined
  /** Epoch milliseconds the indicator opened, bounding its lifetime. */
  startedAt: number
}

/** One chat's in-flight streamed reply message. */
interface StreamedReply {
  /** Message id once Telegram accepts the first streamed chunk. */
  messageId: number | undefined
  /** Accumulated assistant text. */
  text: string
  /** Characters already published. */
  published: number
  /** Epoch milliseconds of the last publish. */
  lastFlush: number
  /** In-flight publish, awaited before the committed text replaces the message. */
  pending: Promise<void> | undefined
}

/** One chat's merged tool-activity message. */
interface ToolBoard {
  /** Message id once Telegram accepts the board. */
  messageId: number | undefined
  /** Activity in call order. */
  lines: ToolBoardLine[]
  /** Tail of the serialized publish chain, so edits never race. */
  pending: Promise<void>
}

interface PendingApproval {
  readonly chatId: string
  readonly resolve: (outcome: ApprovalOutcome) => void
}

/** One chat's in-flight questionnaire: remaining questions plus accepted answers. */
interface PendingQuestionnaire {
  readonly chatId: string
  readonly remaining: readonly AskUserQuestionItem[]
  readonly answers: readonly AskUserQuestionAnswer['answers'][number][]
  /** Message id of the question currently awaiting a reply, for multi-select markup edits. */
  messageId: number | undefined
  /** Labels toggled so far on the current multi-select question. */
  selected: string[]
  readonly resolve: (answer: AskUserQuestionAnswer) => void
  readonly reject: (error: Error) => void
  readonly onAbort: () => void
}

const CALLBACK_PREFIX = 'dsh:'

/** Pause between failed long-poll attempts, so a rejected token cannot busy-loop. */
const POLL_RETRY_DELAY_MS = 5_000

/** Telegram expires one chat action after about five seconds, so refresh below that. */
const TYPING_REFRESH_MS = 4_000

/** Ceiling on one typing indicator, so a stuck turn cannot type forever. */
const TYPING_MAX_MS = 10 * 60_000

/** Telegram Bot API cloud upload ceiling for one outbound file. */
const TELEGRAM_UPLOAD_MAX_BYTES = 50_000_000
/** Leave room below the Bot API ceiling for reliable multipart uploads. */
const TELEGRAM_UPLOAD_PART_BYTES = 49_000_000

interface PresentedFile {
  readonly path: string
  readonly description?: string
}

/**
 * Resolve a present-tool path in the owning Session workspace.
 * @param cwd - Session workspace, when the session has one.
 * @param path - validated path recorded by the present event.
 * @returns the host path used by the local Bot API adapter.
 */
function presentedHostPath(cwd: string | undefined, path: string): string {
  return resolvePath(cwd ?? process.cwd(), path)
}

/** Return a conservative MIME type for Telegram's media method selection. */
function mimeTypeFor(filename: string): string {
  const extension = extname(filename).toLowerCase()
  if (extension === '.mp4' || extension === '.m4v') return 'video/mp4'
  if (extension === '.webm') return 'video/webm'
  if (extension === '.mov') return 'video/quicktime'
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg'
  if (extension === '.png') return 'image/png'
  if (extension === '.gif') return 'image/gif'
  return 'application/octet-stream'
}

/**
 * Wait for a delay, resolving early when the caller's signal aborts.
 * @param ms - milliseconds to wait.
 * @param signal - lifetime of the polling that owns the wait.
 * @returns fulfillment after the delay or the abort, whichever comes first.
 */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Render one question as chat text that keeps every option readable: the
 * numbered list carries the descriptions the buttons cannot.
 * @param question - the question to render.
 * @returns the message body.
 */
function questionText(question: AskUserQuestionItem): string {
  const head = `${question.header === undefined ? '' : `${question.header}\n`}${question.question}`
  if (question.options === undefined) {
    return `${head}${question.detail === undefined ? '' : `\n${question.detail}`}\nReply with your answer.`
  }
  const options = question.options.map((option, index) =>
    `${index + 1}. ${option.label}${option.description === undefined ? '' : ` — ${option.description}`}`)
  const tail = question.multiSelect === true ? '可多选：点按切换，选完按 Done。' : '点按按钮选择。'
  return [head, ...question.detail === undefined ? [] : [question.detail], '', ...options, '', tail].join('\n')
}

/** Compose the card-message key for one card kind and chat. */
function cardKey(kind: 'm' | 's', chatId: string): string {
  return `${kind}:${chatId}`
}

/** The configured chat that owns one update, when the update names one. */
function chatIdOf(update: TelegramUpdate): string | undefined {
  const chat = update.callback_query?.message?.chat ?? update.message?.chat
  return chat?.id === undefined ? undefined : String(chat.id)
}

/** Convert arbitrary model message content into Telegram-readable text. */
function textOf(content: readonly ContentBlock[]): string {
  return content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

/** Decode a Telegram response only after checking its documented success wrapper. */
function resultOf(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || !('ok' in value) || (value as { ok?: unknown }).ok !== true) {
    const description = typeof value === 'object' && value !== null && 'description' in value
      ? String((value as { description?: unknown }).description) : 'unknown Telegram API error'
    throw new Error(`telegram: ${description}`)
  }
  return (value as { result?: unknown }).result
}

/** Guard the Bot API result before the polling loop consumes updates. */
function updatesOf(value: unknown): TelegramUpdate[] {
  if (!Array.isArray(value)) throw new Error('telegram: getUpdates returned a non-array result')
  return value.filter((update): update is TelegramUpdate => typeof update === 'object' && update !== null
    && typeof (update as { update_id?: unknown }).update_id === 'number')
}

/**
 * Apply the creation-time selection until the session's first durable request
 * header exists, so the configured reasoning effort reaches the first request.
 * @param agentCtx - the unpublished agent scope.
 * @param selection - the deployment selection snapshotted at creation.
 */
function installInitialModelSelection(agentCtx: Context, selection: ModelSelection): void {
  agentCtx.on('agent/request', async ({ agent }, next): Promise<LlmCallConfig> => {
    const resolved = await next()
    if (agent.session.requestHeader() !== undefined
      || resolved.provider !== selection.provider
      || resolved.model !== selection.model) return resolved
    const { reasoningEffort: _inheritedEffort, ...withoutInheritedEffort } = resolved
    return {
      ...withoutInheritedEffort,
      ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
    }
  })
}

/** DSH service provider and Telegram interaction answerer. */
export class TelegramService extends Service {
  static inject = ['agents', 'agentPresets', 'agentDefaultModel', 'settings', 'commands', 'sessionTitle', 'tools']
  static Config: z<Config> = z.object({
    token: z.string().min(1),
    chats: z.array(z.object({
      chatId: z.string().min(1),
      agentId: z.string(),
      workspacePath: z.string().min(1),
      agentPreset: z.string().min(1),
    })).min(1),
    pollTimeoutSeconds: z.number().step(1).min(1).max(50).default(25),
    maxMessageChars: z.number().step(1).min(128).max(4096).default(4000),
    toolProgress: z.boolean().default(false),
    streamReplies: z.boolean().default(true),
    streamEditIntervalSeconds: z.number().min(0.5).max(30).default(2),
    typingIndicator: z.boolean().default(true),
  })

  private config: Config
  /** Settings scope owning this deployment's persisted chat selection. */
  private readonly settings: SettingsScope<TelegramSettings>
  /** Session restored from settings for the configured primary chat. */
  private savedSessionId: string | undefined
  private readonly routes = new Map<string, ChatRoute>()
  private readonly approvals = new Map<string, PendingApproval>()
  private readonly questionnaires = new Map<string, PendingQuestionnaire>()
  private nextCallback = 0
  private readonly commandRuns = new Map<string, { controller: AbortController; done: Promise<void> }>()
  /** Sessions whose agent scope already received the Telegram text fallbacks. */
  private readonly fallbackCommands = new Set<string>()
  /** One tool-activity board per chat, reset at every turn start. */
  private readonly boards = new Map<string, ToolBoard>()
  /** Live streamed reply state per chat. */
  private readonly streams = new Map<string, StreamedReply>()
  /** Catalog snapshot behind each chat's model card. */
  private readonly modelCatalogs = new Map<string, ModelCatalog>()
  /** Live session snapshot behind each chat's session card. */
  private readonly sessionCards = new Map<string, readonly Agent[]>()
  /** Agents whose `/model` fallback is Telegram's, so the chat can open the card. */
  private readonly telegramModelAgents = new Set<string>()
  /**
   * Message id of each chat's current card, keyed by card kind so an older
   * model card cannot receive a session card's next edit.
   */
  private readonly cardMessages = new Map<string, number>()
  /** Running typing indicator per chat. */
  private readonly typing = new Map<string, TypingEntry>()
  /** Serialized outbound present-file deliveries per chat. */
  private readonly presentedQueues = new Map<string, Promise<void>>()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'telegram')
    this.config = config
    const first = config.chats[0]
    const scope: SettingsScope<TelegramSettings> = ctx.settings.register(TELEGRAM_SETTINGS_NAMESPACE, TelegramSettingsSchema, {
      base: first === undefined ? {} : {
        token: config.token,
        chatId: first.chatId,
        workspacePath: first.workspacePath,
        agentPreset: first.agentPreset,
      },
      applies: 'restart',
    })
    this.settings = scope
    const saved = scope.get()
    this.savedSessionId = saved.sessionId
    if (saved.token !== undefined) this.config = { ...this.config, token: saved.token }
    if (saved.chatId !== undefined && saved.workspacePath !== undefined && saved.agentPreset !== undefined) {
      this.config = {
        ...this.config,
        chats: [{ chatId: saved.chatId, workspacePath: saved.workspacePath, agentPreset: saved.agentPreset }],
      }
    }
    for (const route of this.config.chats) {
      if (this.routes.has(route.chatId)) throw new Error(`telegram: duplicate chat route ${route.chatId}`)
      this.routes.set(route.chatId, route)
    }
    ctx.effect(() => {
      const controller = new AbortController()
      const polling = this.poll(controller.signal)
      const commandMenu = this.publishCommandMenu(controller.signal)
      const disposeEvent = ctx.on('session/event', (session, event) => {
        const chatId = this.chatForAgent(session.id)
        if (chatId === undefined) return
        if (event.type === 'turn/start') {
          this.startTyping(chatId)
          this.boards.delete(chatId)
          return
        }
        if (event.type === 'turn/end') {
          this.stopTyping(chatId)
          this.boards.delete(chatId)
          return
        }
        if (event.type === 'tool/call') {
          this.reportToolCall(chatId, String(event.data.callId), event.data.name, event.data.arguments)
          return
        }
        if (event.type === 'tool/result') {
          const result = event.data.message.content[0]
          this.reportToolResult(chatId, String(result.toolCallId), result.isError === true)
          return
        }
        if ((event as { readonly type: string }).type === 'deliverables/presented') {
          const delivery = event as unknown as { readonly data: { readonly files: readonly PresentedFile[] } }
          this.queuePresentedFiles(chatId, session, delivery.data.files)
          return
        }
        if (event.type !== 'assistant/message') return
        const text = textOf(event.data.message.content).trim()
        if (text === '') return
        void this.publishReply(chatId, text, true).catch((error: unknown) => {
          ctx.logger.warn('telegram: reply delivery failed', error)
        })
      })
      const disposeStream = this.config.streamReplies
        ? ctx.on('agent/assistant-stream', (payload) => { this.consumeStreamFrame(payload) })
        : () => {}
      const disposeApproval = ctx.on('approval/request', (request, next) => this.answerApproval(request, next))
      const disposeQuestion = ctx.on('user-questions/request', (request, next) => this.answerQuestion(request, next))
      return async () => {
        controller.abort()
        for (const chatId of [...this.typing.keys()]) this.stopTyping(chatId)
        disposeQuestion()
        disposeApproval()
        disposeStream()
        disposeEvent()
        for (const run of this.commandRuns.values()) run.controller.abort()
        this.settlePending()
        await polling
        await commandMenu
        await Promise.all([...this.commandRuns.values()].map(run => run.done))
      }
    }, 'telegram: Bot API polling and command menu')
  }

  /** Keep Telegram's typing indicator alive for one chat until the turn ends. */
  private startTyping(chatId: string): void {
    if (!this.config.typingIndicator || this.typing.has(chatId)) return
    const entry: TypingEntry = { timer: undefined, startedAt: Date.now() }
    const tick = (): void => {
      void this.call('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {
        /* a rejected chat action must not disturb the turn; the next tick retries */
      })
      if (Date.now() - entry.startedAt >= TYPING_MAX_MS) {
        this.stopTyping(chatId)
        return
      }
      entry.timer = setTimeout(tick, TYPING_REFRESH_MS)
    }
    this.typing.set(chatId, entry)
    tick()
  }

  /** Retire one chat's typing indicator. */
  private stopTyping(chatId: string): void {
    const entry = this.typing.get(chatId)
    if (entry === undefined) return
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    this.typing.delete(chatId)
  }

  /**
   * Publish the adapter's own chat commands as Telegram's client-side command
   * menu. A Bot API rejection is logged rather than fatal: the commands stay
   * typed-usable and `/help` still lists them.
   * @param signal - lifetime of the polling effect that owns the publication.
   */
  private async publishCommandMenu(signal: AbortSignal): Promise<void> {
    try {
      await this.call('setMyCommands', { commands: TELEGRAM_COMMAND_MENU }, signal)
    } catch (error: unknown) {
      this.ctx.logger.warn('telegram: command menu publication failed', error)
    }
  }

  /** Poll Telegram serially so the update offset advances only after handling. */
  private async poll(signal: AbortSignal): Promise<void> {
    let offset: number | undefined
    while (!signal.aborted) {
      try {
        const result = await this.call('getUpdates', {
          timeout: this.config.pollTimeoutSeconds,
          allowed_updates: ['message', 'callback_query'],
          ...offset === undefined ? {} : { offset },
        }, signal)
        for (const update of updatesOf(result)) {
          offset = update.update_id + 1
          await this.handleUpdate(update)
        }
      } catch (error) {
        // An invalid token fails immediately, so an unthrottled retry would
        // hammer the Bot API; the pause is what keeps the loop polite.
        this.ctx.logger.warn('telegram: polling failed; retrying', error)
        await delay(POLL_RETRY_DELAY_MS, signal)
      }
    }
  }

  /** Route an authorized private-chat text or callback update. */
  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    try {
      await this.routeUpdate(update)
    } catch (error: unknown) {
      // A deployment may mount no console logger, so report the failure to the
      // chat that owns the update as well as to the Host log.
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      this.ctx.logger.warn('telegram: update handling failed', error)
      const chatId = chatIdOf(update)
      if (chatId === undefined || !this.routes.has(chatId)) return
      await this.sendText(chatId, `Telegram update failed: ${detail}`).catch(() => {
        /* the chat also being unreachable leaves the Host log as the only record */
      })
    }
  }

  /** Route one authorized update, letting its failure reach {@link handleUpdate}. */
  private async routeUpdate(update: TelegramUpdate): Promise<void> {
    const callback = update.callback_query
    const message = update.message
    const chat = callback?.message?.chat ?? message?.chat
    const chatId = chat?.id === undefined ? undefined : String(chat.id)
    if (chatId === undefined || chat?.type !== 'private' || !this.routes.has(chatId)) return
    if (callback !== undefined) {
      await this.call('answerCallbackQuery', { callback_query_id: callback.id ?? '' })
      if (callback.data !== undefined) this.handleCallback(chatId, callback.data)
      return
    }
    const text = (message?.text ?? message?.caption ?? '').trim()
    let media: TelegramMediaInput[]
    try {
      media = message === undefined ? [] : collectTelegramMedia(message)
    } catch (error: unknown) {
      await this.sendText(chatId, error instanceof Error ? error.message : String(error))
      return
    }
    const pending = this.questionFor(chatId)
    if (media.length > 0 && pending === undefined) {
      const agent = await this.selectedAgent(chatId)
      const controller = new AbortController()
      try {
        if (text.startsWith('/')) {
          const submissions = await stageTelegramSubmissions(
            this.ctx, agent, media, id => this.loadFile(id, controller.signal), controller.signal,
          )
          this.startCommand(chatId, agent, text, submissions)
        } else {
          const content = await admitTelegramPrompt(this.ctx, media, text, id => this.loadFile(id, controller.signal), controller.signal)
          agent.followup(createUserMessage({ content, source: { kind: 'plugin', plugin: 'telegram' } }))
        }
      } catch (error: unknown) {
        await this.sendText(chatId, `Telegram attachment intake failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      return
    }
    if (text === '') return
    // Slash commands stay controls while a question is pending. /answer is the
    // explicit escape for an answer that itself starts with a slash.
    if (pending !== undefined && (!text.startsWith('/') || text.startsWith('/answer '))) {
      this.answerCurrentQuestion(chatId, pending, [], text.startsWith('/answer ') ? text.slice(8) : text)
      return
    }
    if (text === '/help' || text === '/start' || text === '/commands') {
      const agent = await this.selectedAgent(chatId)
      const reserved = new Set(['new', 'sessions', 'use', 'status', 'cancel', 'help', 'start', 'commands', 'answer'])
      const commands = this.ctx.commands.list(agent).filter(command => !reserved.has(command.name))
        .map(command => `/${command.name}${command.input === undefined ? '' : ` ${command.input.hint}`} — ${command.description}${command.input?.attachments === true ? ' (attachments: Web only)' : ''}`)
      await this.sendText(chatId, [
        '点选类：',
        '/sessions — 卡片列出存活会话，点一下切换，也可点「＋ 新会话」',
        '/model — 卡片选择 provider → 模型 → 推理强度（也可 /model <provider> <model> [effort]）',
        '',
        '其它：',
        '/new — 新建并选中会话',
        '/status — 当前会话标题、id、状态',
        '/rename <title> — 改当前会话标题',
        '/use <id> — 按 id 切换会话',
        '/cancel — 取消当前工作与运行中的命令',
        '/answer <text> — 回答待处理问题（答案本身以 / 开头时用）',
        '/help, /commands — 本列表与全部可用命令',
        ...commands,
        '',
        '直接发文字=对话；发照片/文件=附件（说明文字以 / 开头则携带附件运行该命令）。斜杠命令不会发给模型，未知命令会被拒绝。',
      ].join('\n'))
      return
    }
    if ((text === '/new' || text.startsWith('/use '))
      && (pending !== undefined || this.commandRuns.has(chatId)
        || [...this.approvals.values()].some(pending => pending.chatId === chatId))) {
      await this.sendText(chatId, 'Answer the pending interaction or /cancel before switching sessions.')
      return
    }
    if (text === '/new') {
      const agent = await this.createAgent(chatId)
      await this.sendText(chatId, `Created and selected DSH session ${agent.id}.`)
      return
    }
    if (text === '/sessions') {
      await this.sendSessionCard(chatId)
      return
    }
    if (text.startsWith('/use ')) {
      const sessionId = text.slice('/use '.length).trim()
      const agent = this.ctx.agents.get(SessionId(sessionId))
      if (agent === undefined || !this.ctx.agents.roots().includes(agent)) {
        await this.sendText(chatId, 'That session is not a live root DSH session.')
        return
      }
      this.selectAgent(chatId, agent.id)
      await this.sendText(chatId, `Selected DSH session ${agent.id}.`)
      return
    }
    const agent = await this.selectedAgent(chatId)
    if (text === '/status') {
      await this.sendText(
        chatId,
        `${this.titleOf(agent)}\n${agent.id} (${agent.status})\n\n快捷操作：`,
        QUICK_ACTIONS,
      )
      return
    }
    if (text === '/cancel') {
      this.commandRuns.get(chatId)?.controller.abort()
      agent.cancel({ kind: 'user' })
      await this.sendText(chatId, 'Cancellation requested.')
      return
    }
    if (text.startsWith('/')) {
      if (text === '/answer' || text.startsWith('/answer ')) {
        await this.sendText(chatId, pending === undefined ? 'No question is waiting for an answer.' : 'Usage: /answer <text>')
        return
      }
      if (pending !== undefined) {
        await this.sendText(chatId, 'A question is waiting. Reply with text, /answer <text>, or /cancel; this command was not executed.')
        return
      }
      this.startCommand(chatId, agent, text)
      return
    }
    agent.followup(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'telegram' },
    }))
  }

  /** Run outside the poll loop so /cancel and interaction replies remain reachable. */
  private startCommand(
    chatId: string,
    agent: Agent,
    line: string,
    submitted: readonly CommandSubmitAttachment[] = [],
  ): void {
    // A bare `/model` opens the selectable card; the argument form stays a
    // registered command, so both paths write the Session the same way.
    const parsed = parseCommand(line)
    if (parsed?.name === 'model' && parsed.rawInput.trim() === '' && this.telegramModelAgents.has(agent.id)) {
      void this.sendModelCard(chatId, agent).catch((error: unknown) => {
        this.ctx.logger.warn('telegram: model card delivery failed', error)
      })
      return
    }
    if (this.commandRuns.has(chatId)) {
      void this.sendText(chatId, 'A command is still running. Use /cancel before starting another command.')
        .catch((error: unknown) => { this.ctx.logger.warn('telegram: command notice delivery failed', error) })
      return
    }
    const controller = new AbortController()
    this.startTyping(chatId)
    const done = Promise.resolve().then(async () => {
      try {
        const execution = await this.ctx.commands.execute(agent, line, submitted, controller.signal)
        if (execution === undefined) {
          await this.sendText(chatId, 'Unknown or malformed command. Use /commands to list available commands. Nothing was sent to the model.')
          return
        }
        const result = execution.result
        const detail = result.kind === 'success' && result.sourceEventSeq !== undefined
          ? `\nRich output is recorded at session event ${result.sourceEventSeq}; view it in the Web interface. Telegram does not render that output.` : ''
        await this.sendText(chatId, `${result.kind === 'error' ? 'Command failed: ' : ''}${result.text ?? 'Command completed.'}${detail}`)
        // `/export` records the download intent in the Web; Telegram delivers the archive itself.
        if (result.kind === 'success' && parseCommand(line)?.name === 'export') {
          await this.deliverExport(chatId, agent, controller.signal)
        }
      } catch (error: unknown) {
        await this.sendText(chatId, controller.signal.aborted ? 'Command cancelled.' : `Command failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }).catch((error: unknown) => { this.ctx.logger.warn('telegram: command result delivery failed', error) })
      .finally(() => {
        this.stopTyping(chatId)
        this.commandRuns.delete(chatId)
      })
    this.commandRuns.set(chatId, { controller, done })
  }

  /** Send the selected session's archive as a Telegram document after `/export`. */
  private async deliverExport(chatId: string, agent: Agent, signal: AbortSignal): Promise<void> {
    const archive = await exportTelegramSessionLog(this.ctx, agent.id, signal)
    if (archive === undefined) {
      await this.sendText(chatId, 'Session log export is unavailable: this deployment mounts no session-query, session-persistence, or attachment service.')
      return
    }
    signal.throwIfAborted()
    await this.sendDocument(chatId, archive.filename, archive.bytes)
  }

  /** Resolve a compact button callback; stale or foreign callbacks do nothing. */
  private handleCallback(chatId: string, data: string): void {
    const [prefix, kind, ...rest] = data.split(':')
    if (prefix !== 'dsh') return
    if (kind === 'a') {
      const [id, value] = rest
      if (id === undefined || value === undefined) return
      const pending = this.approvals.get(`a:${id}`)
      if (pending === undefined || pending.chatId !== chatId) return
      this.approvals.delete(`a:${id}`)
      pending.resolve(value === 'allow' ? 'allowed-once' : 'rejected')
      return
    }
    if (kind === 'q') {
      const [action, index] = rest
      if (action !== undefined) this.applyQuestionCallback(chatId, action, Number(index))
      return
    }
    if (kind === 'm') {
      void this.applyModelCallback(chatId, rest).catch((error: unknown) => {
        this.ctx.logger.warn('telegram: model card update failed', error)
      })
      return
    }
    if (kind === 's') {
      const [action] = rest
      if (action !== undefined) void this.applySessionCallback(chatId, action).catch((error: unknown) => {
        this.ctx.logger.warn('telegram: session card update failed', error)
      })
    }
  }

  /** Send a card message and keep its message id for later in-place edits. */
  private async sendCard(chatId: string, card: Card): Promise<number | undefined> {
    return await this.sendText(chatId, card.text, card.keyboard)
  }

  /** Open the provider step of the model card for one chat. */
  private async sendModelCard(chatId: string, agent: Agent): Promise<void> {
    const controller = this.ctx.get('sessionController')
    if (controller === undefined) {
      await this.sendText(chatId, '模型选择不可用：该部署未挂载 Session controller。')
      return
    }
    const catalog = await controller.modelCatalog()
    this.modelCatalogs.set(chatId, catalog)
    const header = agent.session.requestHeader()
    const current = header?.config ?? agent.options
    const messageId = await this.sendCard(chatId, providerCard(catalog, {
      ...current.provider === undefined ? {} : { provider: current.provider },
      ...current.model === undefined ? {} : { model: current.model },
    }))
    if (messageId !== undefined) this.cardMessages.set(cardKey('m', chatId), messageId)
  }

  /**
   * Advance or settle the model card from one callback.
   * @param chatId - chat that owns the card.
   * @param rest - callback payload after `dsh:m`.
   */
  private async applyModelCallback(chatId: string, rest: readonly string[]): Promise<void> {
    const [action = '', first = '', second = '', third = ''] = rest
    // The open action re-reads the catalog, so it survives an expired snapshot.
    if (action === 'o') {
      const agent = this.agentForChat(chatId)
      if (agent !== undefined) await this.sendModelCard(chatId, agent)
      return
    }
    const catalog = this.modelCatalogs.get(chatId)
    if (catalog === undefined) {
      await this.sendText(chatId, '模型列表已过期，请重新发送 /model。')
      return
    }
    if (action === 'p') {
      const group = providerAt(catalog, Number(first))
      if (group === undefined) return
      // A provider with one model is a one-tap selection; its label names it.
      if (group.models.length === 1) {
        const card = effortCard(catalog, Number(first), 0)
        if (card === undefined) {
          await this.selectFromCard(chatId, catalog, Number(first), 0, undefined)
          return
        }
        await this.editCard(chatId, card, 'm')
        return
      }
      const card = modelCard(catalog, Number(first))
      if (card === undefined) return
      await this.editCard(chatId, card, 'm')
      return
    }
    if (action === 'b') {
      const agent = this.agentForChat(chatId)
      const current = agent === undefined ? {} : agent.session.requestHeader()?.config ?? agent.options
      await this.editCard(chatId, providerCard(catalog, current), 'm')
      return
    }
    if (action === 'i') {
      const card = effortCard(catalog, Number(first), Number(second))
      if (card === undefined) {
        await this.selectFromCard(chatId, catalog, Number(first), Number(second), undefined)
        return
      }
      await this.editCard(chatId, card, 'm')
      return
    }
    if (action === 'e') {
      const effort = modelAt(catalog, Number(first), Number(second))?.reasoning?.efforts[Number(third)]?.id
      await this.selectFromCard(chatId, catalog, Number(first), Number(second), effort)
      return
    }
    if (action === 'd') {
      await this.selectFromCard(chatId, catalog, Number(first), Number(second), undefined)
    }
  }

  /** Run the model selection the card resolved, through the command registry. */
  private async selectFromCard(
    chatId: string,
    catalog: ModelCatalog,
    providerIndex: number,
    modelIndex: number,
    reasoningEffort: string | undefined,
  ): Promise<void> {
    const provider = providerAt(catalog, providerIndex)
    const model = modelAt(catalog, providerIndex, modelIndex)
    const agent = this.agentForChat(chatId)
    if (provider === undefined || model === undefined || agent === undefined) {
      await this.sendText(chatId, '该选项已失效，请重新发送 /model。')
      return
    }
    const line = `/model ${provider.id} ${model.id}${reasoningEffort === undefined ? '' : ` ${reasoningEffort}`}`
    // The tapped card has served its purpose; its confirmation arrives as a reply.
    const cardMessage = this.cardMessages.get(cardKey('m', chatId))
    this.cardMessages.delete(cardKey('m', chatId))
    this.modelCatalogs.delete(chatId)
    if (cardMessage !== undefined) {
      void this.call('deleteMessage', { chat_id: chatId, message_id: cardMessage })
        .catch((error: unknown) => { this.ctx.logger.warn('telegram: card cleanup failed', error) })
    }
    this.startCommand(chatId, agent, line)
  }

  /**
   * Edit one card message in place after a step change.
   * @param chatId - chat that owns the card.
   * @param card - the replacement card.
   * @param kind - which card kind the callback came from.
   */
  private async editCard(chatId: string, card: Card, kind: 'm' | 's'): Promise<void> {
    const messageId = this.cardMessages.get(cardKey(kind, chatId))
    if (messageId === undefined) {
      await this.sendCard(chatId, card)
      return
    }
    await this.call('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: card.text,
      reply_markup: { inline_keyboard: card.keyboard },
    })
  }

  /** Send the live-session card for one chat. */
  private async sendSessionCard(chatId: string): Promise<void> {
    const sessions = this.ctx.agents.roots()
    this.sessionCards.set(chatId, sessions)
    if (sessions.length === 0) {
      await this.sendText(chatId, '当前没有存活的 DSH 会话。发送 /new 新建一个。')
      return
    }
    const messageId = await this.sendCard(chatId, sessionCard(
      sessions.map(agent => ({ id: agent.id, title: this.titleOf(agent), status: agent.status })),
      this.agentForChat(chatId)?.id,
    ))
    if (messageId !== undefined) this.cardMessages.set(cardKey('s', chatId), messageId)
  }

  /**
   * Switch the chat's session from one session-card callback.
   * @param chatId - chat that owns the card.
   * @param action - session position, or `n` for a new session.
   */
  private async applySessionCallback(chatId: string, action: string): Promise<void> {
    if (action === 'l') {
      await this.sendSessionCard(chatId)
      return
    }
    if (action === 'n') {
      const agent = await this.createAgent(chatId)
      await this.sendText(chatId, `已新建并切换到会话 ${agent.id}。`)
      return
    }
    const listed = this.sessionCards.get(chatId)
    const live = this.ctx.agents.roots()
    const target = listed?.[Number(action)] ?? live[Number(action)]
    if (target === undefined || !live.includes(target)) {
      await this.sendText(chatId, '该会话已不在存活列表中，请重新发送 /sessions。')
      return
    }
    this.selectAgent(chatId, target.id)
    this.sessionCards.set(chatId, live)
    await this.editCard(chatId, sessionCard(
      live.map(agent => ({ id: agent.id, title: this.titleOf(agent), status: agent.status })),
      target.id,
    ), 's')
  }

  /** Present a tool approval to the chat that owns its live agent. */
  private async answerApproval(request: ApprovalRequestEvent, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> {
    const chatId = this.chatForAgent(request.agent.id)
    if (chatId === undefined) return await next()
    const id = String(++this.nextCallback)
    const key = `a:${id}`
    return await new Promise<ApprovalOutcome>((resolve) => {
      const onAbort = () => {
        this.approvals.delete(key)
        resolve('cancelled')
      }
      request.signal?.addEventListener('abort', onAbort, { once: true })
      this.stopTyping(chatId)
      this.approvals.set(key, { chatId, resolve: (outcome) => {
        request.signal?.removeEventListener('abort', onAbort)
        this.startTyping(chatId)
        resolve(outcome)
      } })
      void this.sendText(chatId, `Approval required for ${request.toolName}${request.reason === undefined ? '' : `: ${request.reason}`}`, [
        [{ text: 'Allow once', callback_data: `${CALLBACK_PREFIX}a:${id}:allow` }, { text: 'Reject', callback_data: `${CALLBACK_PREFIX}a:${id}:reject` }],
      ]).catch((error: unknown) => {
        this.approvals.delete(key)
        request.signal?.removeEventListener('abort', onAbort)
        this.ctx.logger.warn('telegram: approval delivery failed', error)
        resolve('unavailable')
      })
    })
  }

  /** Present every question in order, one message at a time, then settle the answer. */
  private async answerQuestion(
    request: AskUserQuestionRequestEvent,
    next: () => Promise<AskUserQuestionAnswer>,
  ): Promise<AskUserQuestionAnswer> {
    const chatId = request.agent === undefined ? undefined : this.chatForAgent(request.agent.id)
    if (chatId === undefined) return await next()
    const first = request.questions[0]
    if (first === undefined) return await next()
    if (this.questionnaires.has(chatId)) return await next()
    return await new Promise<AskUserQuestionAnswer>((resolve, reject) => {
      const pending: PendingQuestionnaire = {
        chatId,
        remaining: request.questions,
        answers: [],
        messageId: undefined,
        selected: [],
        resolve,
        reject,
        onAbort: () => {
          this.questionnaires.delete(chatId)
          reject(new Error('ask_user_question was aborted before the user answered'))
        },
      }
      request.signal?.addEventListener('abort', pending.onAbort, { once: true })
      this.questionnaires.set(chatId, pending)
      this.stopTyping(chatId)
      void this.askQuestion(pending, first).then(() => {
        this.startTyping(chatId)
      }).catch((error: unknown) => {
        this.questionnaires.delete(chatId)
        request.signal?.removeEventListener('abort', pending.onAbort)
        this.ctx.logger.warn('telegram: question delivery failed', error)
        reject(error instanceof Error ? error : new Error(String(error)))
      })
    })
  }

  /** Send one question, rendering a toggle keyboard when several options may be selected. */
  private async askQuestion(pending: PendingQuestionnaire, question: AskUserQuestionItem): Promise<void> {
    pending.selected = []
    pending.messageId = await this.sendText(
      pending.chatId,
      questionText(question),
      this.questionKeyboard(question, []),
      true,
    )
  }

  /** Render one question's inline keyboard for the current selection. */
  private questionKeyboard(
    question: AskUserQuestionItem,
    selected: readonly string[],
  ): CardKeyboard | undefined {
    if (question.options === undefined) return undefined
    const rows = question.options.map((option, index) => [{
      text: question.multiSelect === true ? `${selected.includes(option.label) ? '☑' : '☐'} ${option.label}` : option.label,
      callback_data: `${CALLBACK_PREFIX}q:${question.multiSelect === true ? 't' : 's'}:${index}`,
    }])
    return question.multiSelect === true
      ? [...rows, [{ text: 'Done', callback_data: `${CALLBACK_PREFIX}q:d:0` }]]
      : rows
  }

  /** The questionnaire awaiting an answer in one chat. */
  private questionFor(chatId: string): PendingQuestionnaire | undefined {
    return this.questionnaires.get(chatId)
  }

  /**
   * Record one answer for the current question and either ask the next one or
   * settle the whole request.
   * @param chatId - chat that owns the questionnaire.
   * @param pending - the in-flight questionnaire.
   * @param selected - chosen option labels; empty for a free-text answer.
   * @param custom - free-text answer or selection comment.
   */
  private answerCurrentQuestion(
    chatId: string,
    pending: PendingQuestionnaire,
    selected: readonly string[],
    custom?: string,
  ): void {
    const question = pending.remaining[0]
    if (question === undefined) return
    const answer = {
      id: question.id,
      selected: [...selected],
      ...custom === undefined || custom === '' ? {} : { custom },
    }
    const answers = [...pending.answers, answer]
    const remaining = pending.remaining.slice(1)
    const next = remaining[0]
    if (next === undefined) {
      this.questionnaires.delete(chatId)
      pending.resolve({ answers })
      return
    }
    this.questionnaires.set(chatId, { ...pending, answers, remaining, selected: [], messageId: undefined })
    void this.askQuestion(this.questionnaires.get(chatId) as PendingQuestionnaire, next).catch((error: unknown) => {
      this.questionnaires.delete(chatId)
      this.ctx.logger.warn('telegram: question delivery failed', error)
      pending.reject(error instanceof Error ? error : new Error(String(error)))
    })
  }

  /** Apply one question callback: toggle or choose an option, or confirm a multi-select. */
  private applyQuestionCallback(chatId: string, action: string, index: number): void {
    const pending = this.questionnaires.get(chatId)
    const question = pending?.remaining[0]
    if (pending === undefined || question?.options === undefined) return
    const option = question.options[index]
    if (action === 'd') {
      this.answerCurrentQuestion(chatId, pending, pending.selected)
      return
    }
    if (option === undefined) return
    if (question.multiSelect !== true) {
      this.answerCurrentQuestion(chatId, pending, [option.label])
      return
    }
    const selected = pending.selected.includes(option.label)
      ? pending.selected.filter(label => label !== option.label)
      : [...pending.selected, option.label]
    pending.selected = selected
    if (pending.messageId !== undefined) {
      void this.call('editMessageReplyMarkup', {
        chat_id: chatId,
        message_id: pending.messageId,
        reply_markup: { inline_keyboard: this.questionKeyboard(question, selected) },
      }).catch((error: unknown) => { this.ctx.logger.warn('telegram: question markup update failed', error) })
    }
  }

  /** Send one or more bounded Telegram messages; the last chunk's message id is returned. */
  private async sendText(
    chatId: string,
    text: string,
    keyboard?: CardKeyboard,
    markdown = false,
  ): Promise<number | undefined> {
    const chunks = splitMarkdown(text, this.config.maxMessageChars)
    let messageId: number | undefined
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index] ?? ''
      const markup = index === chunks.length - 1 && keyboard !== undefined
        ? { reply_markup: { inline_keyboard: keyboard } }
        : {}
      const result = await this.sendChunk(chatId, chunk, markup, markdown)
      const id = (result as { message_id?: unknown } | undefined)?.message_id
      if (typeof id === 'number') messageId = id
    }
    return messageId
  }

  /**
   * Send one bounded chunk, converting Markdown and degrading to plain text when
   * Telegram rejects the resulting entities.
   * @param chatId - destination chat.
   * @param chunk - one bounded message body.
   * @param keyboard - markup fields to attach to this chunk, if any.
   * @param markdown - whether the chunk is Markdown to convert.
   * @returns the Bot API result.
   */
  private async sendChunk(
    chatId: string,
    chunk: string,
    keyboard: Record<string, unknown>,
    markdown: boolean,
  ): Promise<unknown> {
    if (!markdown) return await this.call('sendMessage', { chat_id: chatId, text: chunk, ...keyboard })
    const html = toTelegramHtml(chunk)
    try {
      return await this.call('sendMessage', { chat_id: chatId, text: html, parse_mode: 'HTML', ...keyboard })
    } catch (error: unknown) {
      this.ctx.logger.warn('telegram: HTML send rejected; falling back to plain text', error)
      return await this.call('sendMessage', { chat_id: chatId, text: stripMarkup(html), ...keyboard })
    }
  }

  /** Edit one message, converting Markdown with the same plain-text fallback. */
  private async editText(chatId: string, messageId: number, text: string, markdown: boolean): Promise<void> {
    const chunk = splitMarkdown(text, this.config.maxMessageChars)[0] ?? text
    if (!markdown) {
      await this.call('editMessageText', { chat_id: chatId, message_id: messageId, text: chunk })
      return
    }
    const html = toTelegramHtml(chunk)
    try {
      await this.call('editMessageText', { chat_id: chatId, message_id: messageId, text: html, parse_mode: 'HTML' })
    } catch {
      await this.call('editMessageText', { chat_id: chatId, message_id: messageId, text: stripMarkup(html) })
    }
  }

  /**
   * Append one tool call to the chat's activity board, or skip when progress is
   * off. Tools that own their own interactive prompt are excluded because their
   * prompt IS the UI.
   * @param chatId - chat that owns the running agent.
   * @param callId - provider-issued call id the result settles.
   * @param name - tool name.
   * @param args - raw JSON arguments.
   */
  private reportToolCall(chatId: string, callId: string, name: string, args: string): void {
    if (!this.config.toolProgress || name === 'ask_user_question') return
    const board = this.boardFor(chatId)
    board.lines.push({ callId, title: this.toolTitle(name, args), status: 'running' })
    void this.renderBoard(chatId).catch((error: unknown) => {
      this.ctx.logger.warn('telegram: tool progress delivery failed', error)
    })
  }

  /** Settle one tool call's board line and republish the board. */
  private reportToolResult(chatId: string, callId: string, isError: boolean): void {
    const board = this.boards.get(chatId)
    const line = board?.lines.find(entry => entry.callId === callId)
    if (board === undefined || line === undefined) return
    board.lines[board.lines.indexOf(line)] = { ...line, status: isError ? 'failed' : 'done' }
    void this.renderBoard(chatId).catch((error: unknown) => {
      this.ctx.logger.warn('telegram: tool progress update failed', error)
    })
  }

  /** The chat's current board, created on first use. */
  private boardFor(chatId: string): ToolBoard {
    const existing = this.boards.get(chatId)
    if (existing !== undefined) return existing
    const board: ToolBoard = { messageId: undefined, lines: [], pending: Promise.resolve() }
    this.boards.set(chatId, board)
    return board
  }

  /**
   * Publish the board, sending it once and editing it afterwards. Publishes are
   * chained per chat, so each render reads the newest activity without racing.
   */
  private renderBoard(chatId: string): Promise<void> {
    const board = this.boards.get(chatId)
    if (board === undefined) return Promise.resolve()
    const publish = async (): Promise<void> => {
      const text = renderToolBoard(board.lines, this.config.maxMessageChars)
      if (text === '') return
      if (board.messageId === undefined) {
        board.messageId = await this.sendText(chatId, text)
        return
      }
      await this.call('editMessageText', { chat_id: chatId, message_id: board.messageId, text })
    }
    const next = board.pending.then(publish, publish)
    board.pending = next.catch(() => { /* the caller reports the failure */ })
    return next
  }

  /**
   * Compose one board line from the tool's own presentation intent, falling back
   * to its name when the tool declares none or the arguments do not parse.
   * @param name - tool name.
   * @param args - raw JSON arguments as produced by the model.
   * @returns the display title.
   */
  private toolTitle(name: string, args: string): string {
    const label = name === '' ? 'Tool' : `${name.charAt(0).toUpperCase()}${name.slice(1)}`
    try {
      const parsed: unknown = JSON.parse(args)
      const view = this.ctx.tools.get(name)?.presentCall?.(parsed)
      if (view === undefined) return label
      if (view.card === 'terminal') {
        return boardTitle(view.description === undefined || view.description === '' ? `${label} · ${view.title}` : `${label} · ${view.description}`)
      }
      return boardTitle(view.title === '' ? label : `${label} · ${view.title}`)
    } catch {
      // Unparsable arguments and a throwing presenter both leave the bare name.
      return label
    }
  }

  /** Accumulate one live assistant frame and publish it under the edit interval. */
  private consumeStreamFrame(
    payload: { readonly agent: Agent; readonly frame: { readonly type: string; readonly chunk?: unknown } },
  ): void {
    const chatId = this.chatForAgent(payload.agent.id)
    if (chatId === undefined) return
    if (payload.frame.type === 'start') {
      this.streams.set(chatId, { messageId: undefined, text: '', published: 0, lastFlush: 0, pending: undefined })
      return
    }
    if (payload.frame.type !== 'chunk') return
    const delta = streamTextOf(payload.frame.chunk as Parameters<typeof streamTextOf>[0])
    if (delta === '') return
    const state = this.streams.get(chatId) ?? { messageId: undefined, text: '', published: 0, lastFlush: 0, pending: undefined }
    state.text += delta
    this.streams.set(chatId, state)
    if (!shouldFlushStream({
      intervalMs: this.config.streamEditIntervalSeconds * 1000,
      maxChars: this.config.maxMessageChars,
    }, state, Date.now())) return
    state.pending = this.flushStream(chatId, state).catch((error: unknown) => {
      this.ctx.logger.warn('telegram: streamed reply failed', error)
    })
  }

  /** Publish the accumulated stream text, sending the placeholder or editing it. */
  private async flushStream(chatId: string, state: StreamedReply): Promise<void> {
    const text = clampStreamText(state.text, this.config.maxMessageChars)
    state.lastFlush = Date.now()
    state.published = text.length
    if (state.messageId === undefined) {
      state.messageId = await this.sendText(chatId, text, undefined, true)
      return
    }
    await this.editText(chatId, state.messageId, text, true)
  }

  /**
   * Deliver one committed assistant message, replacing the streamed placeholder
   * when the reply was already streamed into the chat.
   * @param chatId - chat that owns the agent.
   * @param text - committed assistant text.
   */
  private async publishReply(chatId: string, text: string, markdown = false): Promise<void> {
    const state = this.streams.get(chatId)
    this.streams.delete(chatId)
    if (state !== undefined && this.config.streamReplies) {
      await state.pending?.catch(() => { /* a failed publish falls back to a plain reply */ })
    }
    if (state?.messageId !== undefined) {
      await this.editText(chatId, state.messageId, clampStreamText(text, this.config.maxMessageChars), markdown)
      return
    }
    await this.sendText(chatId, text, undefined, markdown)
  }

  /** Queue present-tool files so one chat receives them in declaration order. */
  private queuePresentedFiles(
    chatId: string,
    session: { readonly header: { readonly cwd?: string } },
    files: readonly PresentedFile[],
  ): void {
    const previous = this.presentedQueues.get(chatId) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(async () => {
      for (const file of files) {
        try {
          await this.deliverPresentedFile(chatId, session.header.cwd, file)
        } catch (error: unknown) {
          this.ctx.logger.warn('telegram: present-file delivery failed', error)
          await this.sendText(chatId, `File delivery failed: ${basename(file.path) || 'unnamed file'}`).catch(() => undefined)
        }
      }
    })
    this.presentedQueues.set(chatId, next)
    void next.finally(() => {
      if (this.presentedQueues.get(chatId) === next) this.presentedQueues.delete(chatId)
    })
  }

  /** Send one Web-presented file, splitting files above Telegram's cloud limit. */
  private async deliverPresentedFile(chatId: string, cwd: string | undefined, file: PresentedFile): Promise<void> {
    const filename = basename(file.path) || 'telegram-file'
    const path = presentedHostPath(cwd, file.path)
    const entry = await lstat(path)
    if (!entry.isFile()) throw new Error('presented path is not a regular file')
    const info = await stat(path)
    const size = info.size
    const mimeType = mimeTypeFor(filename)
    const blob = await openAsBlob(path, { type: mimeType })
    const caption = file.description?.trim() === '' ? undefined : file.description?.trim()
    if (size <= TELEGRAM_UPLOAD_MAX_BYTES) {
      if (mimeType.startsWith('video/')) {
        await this.sendVideo(chatId, filename, blob, caption)
      } else {
        await this.sendDocumentBlob(chatId, filename, blob, caption)
      }
      return
    }
    const total = Math.ceil(size / TELEGRAM_UPLOAD_PART_BYTES)
    await this.sendText(chatId, `文件 ${filename} 为 ${(size / 1_000_000).toFixed(1)} MB，超过 Telegram 单文件限制，拆分为 ${total} 个分片发送。`)
    for (let index = 0; index < total; index += 1) {
      const start = index * TELEGRAM_UPLOAD_PART_BYTES
      const partName = `${filename}.part-${String(index + 1).padStart(2, '0')}-of-${String(total).padStart(2, '0')}`
      await this.sendDocumentBlob(
        chatId,
        partName,
        blob.slice(start, Math.min(start + TELEGRAM_UPLOAD_PART_BYTES, size), 'application/octet-stream'),
        `分片 ${index + 1}/${total} · ${filename}`,
      )
    }
  }

  /** Send one file blob as a Telegram document. */
  private async sendDocumentBlob(chatId: string, filename: string, blob: Blob, caption?: string): Promise<void> {
    const form = new FormData()
    form.set('chat_id', chatId)
    if (caption !== undefined) form.set('caption', caption.slice(0, 1024))
    form.set('document', blob, filename)
    const response = await fetch(`https://api.telegram.org/bot${this.config.token}/sendDocument`, {
      method: 'POST', body: form,
    })
    resultOf(await response.json())
  }

  /** Send a small video through Telegram's native video message type. */
  private async sendVideo(chatId: string, filename: string, blob: Blob, caption?: string): Promise<void> {
    const form = new FormData()
    form.set('chat_id', chatId)
    if (caption !== undefined) form.set('caption', caption.slice(0, 1024))
    form.set('supports_streaming', 'true')
    form.set('video', blob, filename)
    const response = await fetch(`https://api.telegram.org/bot${this.config.token}/sendVideo`, {
      method: 'POST', body: form,
    })
    resultOf(await response.json())
  }

  /** Download one Bot API file through the token-scoped file route. */
  private async loadFile(fileId: string, signal: AbortSignal): Promise<Uint8Array> {
    signal.throwIfAborted()
    const file = await this.call('getFile', { file_id: fileId }, signal) as { file_path?: string } | undefined
    if (file?.file_path === undefined) throw new Error('telegram: getFile returned no file path')
    const response = await fetch(`https://api.telegram.org/file/bot${this.config.token}/${file.file_path}`, { signal })
    if (!response.ok) throw new Error(`telegram: file download failed with HTTP ${response.status}`)
    return new Uint8Array(await response.arrayBuffer())
  }

  /** Call one Telegram Bot API method and parse its common response envelope. */
  private async call(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const response = await fetch(`https://api.telegram.org/bot${this.config.token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      ...signal === undefined ? {} : { signal },
    })
    return resultOf(await response.json())
  }

  /** Upload one binary document; the Bot API requires multipart, not JSON. */
  private async sendDocument(chatId: string, filename: string, bytes: Buffer): Promise<void> {
    const form = new FormData()
    form.set('chat_id', chatId)
    form.set('document', new Blob([new Uint8Array(bytes)], { type: 'application/zip' }), filename)
    const response = await fetch(`https://api.telegram.org/bot${this.config.token}/sendDocument`, {
      method: 'POST', body: form,
    })
    resultOf(await response.json())
  }

  /** Resolve the selected live root agent for one authorized chat. */
  private agentForChat(chatId: string): Agent | undefined {
    const agentId = this.routes.get(chatId)?.agentId
    const agent = agentId === undefined ? undefined : this.ctx.agents.get(SessionId(agentId))
    return agent !== undefined && this.ctx.agents.roots().includes(agent) ? agent : undefined
  }

  /** Resolve the chat's selected live agent, creating and selecting one when absent. */
  private async selectedAgent(chatId: string): Promise<Agent> {
    const agent = this.agentForChat(chatId) ?? await this.restoreOrCreateAgent(chatId)
    await this.ensureFallbackCommands(agent)
    return agent
  }

  /**
   * Continue this chat's persisted session when it still exists, because a
   * restart must not silently start a new conversation; otherwise create one.
   * @param chatId - authorized chat whose turn needs an agent.
   * @returns the live agent now selected for the chat.
   */
  private async restoreOrCreateAgent(chatId: string): Promise<Agent> {
    const saved = this.savedSessionId === undefined ? undefined : SessionId(this.savedSessionId)
    if (saved === undefined) return await this.createAgent(chatId)
    const live = this.ctx.agents.get(saved)
    if (live !== undefined && this.ctx.agents.roots().includes(live)) {
      this.selectAgent(chatId, live.id)
      return live
    }
    const route = this.routes.get(chatId)
    if (route === undefined) throw new Error(`telegram: unknown chat route ${chatId}`)
    try {
      const preset = await this.ctx.agentPresets.resolve(route.agentPreset)
      const selection = this.ctx.agentDefaultModel.currentSelection()
      const { agent } = await this.ctx.agents.resume({
        resumeSessionId: saved,
        agentOptions: { provider: selection.provider, model: selection.model },
        setup: async (agentCtx) => {
          await this.ctx.agentPresets.mount(agentCtx, preset.id)
          installInitialModelSelection(agentCtx, { ...selection })
        },
      })
      this.ctx.logger.info(`telegram: resumed session ${agent.id}`)
      this.selectAgent(chatId, agent.id)
      return agent
    } catch {
      // A deleted or unreadable session must not wedge the chat: start a new one.
      return await this.createAgent(chatId)
    }
  }

  /**
   * Give one Telegram-owned agent the text equivalents of the Web pickers when
   * no host command registered those names, so chat reaches the same Session
   * APIs without shadowing a deployment's own command. The registration is
   * mounted under the agent's scope, whose Context must inject `commands`
   * before the property is readable.
   * @param agent - the selected session's agent, whose scope owns the fallbacks.
   */
  private async ensureFallbackCommands(agent: Agent): Promise<void> {
    if (this.fallbackCommands.has(agent.id)) return
    this.fallbackCommands.add(agent.id)
    const definitions = [telegramModelCommand(this.ctx), telegramRenameCommand(this.ctx)]
      .filter(definition => this.ctx.commands.find(agent, definition.name) === undefined)
    if (definitions.length === 0) return
    if (definitions.some(definition => definition.name === 'model')) this.telegramModelAgents.add(agent.id)
    await agent.ctx.plugin(Object.assign((scope: Context) => {
      for (const definition of definitions) scope.commands.register(definition)
    }, { inject: ['commands'] }))
  }

  /** Read one session's current title for chat-facing listings. */
  private titleOf(agent: Agent): string {
    return this.ctx.sessionTitle.get(agent.session)?.title ?? 'Untitled session'
  }

  /** Create and select a root agent using this chat's explicit workspace and preset. */
  private async createAgent(chatId: string): Promise<Agent> {
    const route = this.routes.get(chatId)
    if (route === undefined) throw new Error(`telegram: unknown chat route ${chatId}`)
    const preset = await this.ctx.agentPresets.resolve(route.agentPreset)
    await this.ctx.agentPresets.standingKeyFor(preset.id)
    // The deployment default is resolved here rather than left to the loop: a
    // session's first prompt assembles `{{model}}` from `agent.options.model`,
    // so an agent created without a route fails that assembly.
    const selection = this.ctx.agentDefaultModel.currentSelection()
    const { agent } = await this.ctx.agents.create({
      sessionId: SessionId(randomUUID()),
      meta: { cwd: route.workspacePath, agentPreset: preset.id },
      agentOptions: { provider: selection.provider, model: selection.model },
      setup: async (agentCtx) => {
        await this.ctx.agentPresets.mount(agentCtx, preset.id)
        installInitialModelSelection(agentCtx, { ...selection })
      },
    })
    this.selectAgent(chatId, agent.id)
    return agent
  }

  /** Select one existing live root agent for an authorized chat and persist it. */
  private selectAgent(chatId: string, agentId: Agent['id']): void {
    const route = this.routes.get(chatId)
    if (route === undefined) throw new Error(`telegram: unknown chat route ${chatId}`)
    this.routes.set(chatId, { ...route, agentId })
    if (this.routes.get(chatId) !== undefined && this.primaryChat !== undefined && chatId === this.primaryChat) {
      this.savedSessionId = String(agentId)
      void this.settings.update({ sessionId: String(agentId) }).catch((error: unknown) => {
        this.ctx.logger.warn('telegram: persisting the selected session failed', error)
      })
    }
  }

  /** The configured chat whose selection is persisted in settings. */
  private get primaryChat(): string | undefined {
    const configured = this.settings.get().chatId
    return configured === undefined || configured === '' ? this.config.chats[0]?.chatId : configured
  }

  /** Find the chat currently selected for an agent. */
  private chatForAgent(agentId: Agent['id']): string | undefined {
    return [...this.routes].find(([, route]) => route.agentId === agentId)?.[0]
  }

  private settlePending(): void {
    for (const pending of this.approvals.values()) pending.resolve('cancelled')
    this.approvals.clear()
    for (const pending of this.questionnaires.values()) pending.resolve({ answers: [] })
    this.questionnaires.clear()
  }
}

export default TelegramService
