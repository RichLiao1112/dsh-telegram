/** Telegram chat command dispatch: registry execution, titles, fallback /model, /export delivery. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import TelegramService, { type Config } from '../src/index.ts'

vi.mock('../src/export-command.ts', () => ({
  exportTelegramSessionLog: vi.fn(async () => ({ bytes: Buffer.from('ZIP'), filename: 'session.zip' })),
}))

const CHAT_ID = '4242'
const SESSION_ID = SessionId('telegram-session-1')

interface SentMessage {
  readonly chatId: string
  readonly text: string
  readonly buttons?: readonly (readonly { text: string; callback_data: string }[])[]
}

/** Failure injection for one Bot API method, so a rejected call can be tested. */
interface HarnessOptions {
  /** Method names answered with the Bot API's `ok: false` envelope. */
  readonly failMethods?: readonly string[]
  /** Session already persisted for this chat, as a restart would find it. */
  readonly savedSessionId?: string
}

/** Drive the plugin's real Bot API poll loop with a scripted update queue. */
function harness(overrides: Partial<Config> = {}, options: HarnessOptions = {}) {
  const ctx = new Context()
  const sent: SentMessage[] = []
  const documents: string[] = []
  const downloads: string[] = []
  const markup: { messageId: number; labels: string[][] }[] = []
  const edits: { messageId: number; text: string }[] = []
  const markupEdits: { text: string; buttons: readonly (readonly { text: string; callback_data: string }[])[] }[] = []
  const deleted: number[] = []
  const actions: string[] = []
  const admittedFiles: string[] = []
  const stagedFiles: string[] = []
  const menu: unknown[] = []
  const definitions = new Map<string, CommandDefinition>()
  let updates: unknown[] = []
  let offsetSeen: number | undefined
  let parked: (() => void) | undefined

  const session = { id: SESSION_ID, requestHeader: () => undefined }
  const followup = vi.fn()
  const cancel = vi.fn()
  // The agent's own scope injects nothing, exactly as the real Agent scope does:
  // reading `agent.ctx.commands` there must stay impossible.
  let agentCtx: Context = ctx
  const agent = {
    id: SESSION_ID,
    status: 'idle',
    session,
    options: { provider: 'initial-provider', model: 'initial-model' },
    get ctx() { return agentCtx },
    followup,
    cancel,
  } as unknown as Agent

  const json = (value: unknown): Response => new Response(JSON.stringify(value), { status: 200 })
  const bodyOf = (init?: RequestInit): Record<string, unknown> =>
    typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
  const requests: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const method = String(input).split('/').pop() ?? ''
    requests.push(method)
    if (options.failMethods?.includes(method) === true) {
      return json({ ok: false, description: `stub rejected ${method}` })
    }
    if (method === 'setMyCommands') {
      menu.push((bodyOf(init) as unknown as { commands: unknown }).commands)
      return json({ ok: true, result: true })
    }
    if (method === 'getUpdates') {
      const body = bodyOf(init) as { offset?: number }
      if (body.offset !== undefined) offsetSeen = body.offset
      const batch = updates
      updates = []
      if (batch.length > 0) return json({ ok: true, result: batch })
      // Park the poll until the next scripted update instead of spinning.
      return await new Promise<Response>((resolve, reject) => {
        parked = () => { resolve(json({ ok: true, result: [] })) }
        init?.signal?.addEventListener('abort', () => { reject(new Error('poll disposed')) }, { once: true })
      })
    }
    if (String(input).includes('/file/bot')) {
      downloads.push(String(input))
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 })
    }
    if (method === 'getFile') {
      return json({ ok: true, result: { file_path: 'photos/file_1.jpg' } })
    }
    if (method === 'editMessageText') {
      const body = bodyOf(init) as unknown as {
        chat_id: string
        message_id: number
        text: string
        reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] }
      }
      edits.push({ messageId: body.message_id, text: body.text })
      if (body.reply_markup !== undefined) markupEdits.push({ text: body.text, buttons: body.reply_markup.inline_keyboard })
      return json({ ok: true, result: {} })
    }
    if (method === 'sendChatAction') {
      actions.push((bodyOf(init) as unknown as { action: string }).action)
      return json({ ok: true, result: {} })
    }
    if (method === 'deleteMessage') {
      deleted.push((bodyOf(init) as unknown as { message_id: number }).message_id)
      return json({ ok: true, result: {} })
    }
    if (method === 'editMessageReplyMarkup') {
      const body = bodyOf(init) as unknown as { message_id: number; reply_markup: { inline_keyboard: { text: string }[][] } }
      markup.push({ messageId: body.message_id, labels: body.reply_markup.inline_keyboard.map(row => row.map(button => button.text)) })
      return json({ ok: true, result: {} })
    }
    if (method === 'sendMessage') {
      const body = bodyOf(init) as unknown as {
        chat_id: string
        text: string
        reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] }
      }
      sent.push({
        chatId: body.chat_id,
        text: body.text,
        ...body.reply_markup === undefined ? {} : { buttons: body.reply_markup.inline_keyboard },
      })
      return json({ ok: true, result: { message_id: sent.length } })
    }
    if (method === 'sendDocument') {
      const form = init?.body as FormData
      const upload = form.get('document')
      documents.push(upload instanceof File ? upload.name : '')
      return json({ ok: true, result: {} })
    }
    return json({ ok: true, result: {} })
  }))

  ctx.provide('tools', { get: () => undefined } as never)
  const commandRuntime = {
    register: (definition: CommandDefinition) => {
      definitions.set(definition.name, definition)
      return () => { definitions.delete(definition.name) }
    },
    find: (_agent: Agent, name: string) => definitions.get(name),
    list: () => [...definitions.values()].map(definition => ({
      name: definition.name,
      description: definition.description,
      ...definition.input === undefined ? {} : { input: definition.input },
    })),
    execute: async (_agent: Agent, line: string, _attachments: readonly unknown[], signal: AbortSignal) => {
      const parsed = parseCommand(line)
      const definition = parsed === undefined ? undefined : definitions.get(parsed.name)
      if (parsed === undefined || definition === undefined) return undefined
      const result = await definition.handler({
        commandId: 'cmd-1', agent, rawInput: parsed.rawInput, attachments: [], signal,
      } as never)
      return { commandId: 'cmd-1', result }
    },
  }

  const savedSettings: Record<string, unknown> = {}
  if (options.savedSessionId !== undefined) savedSettings.sessionId = options.savedSessionId
  const resumedAgents: { id: string; followup: ReturnType<typeof vi.fn> }[] = []
  const resumeAgent = vi.fn(async (options: { resumeSessionId: string }) => {
    const followup = vi.fn()
    const resumed = {
      id: options.resumeSessionId,
      status: 'idle',
      session: { id: options.resumeSessionId, requestHeader: () => undefined },
      options: { provider: 'resumed-provider', model: 'resumed-model' },
      get ctx() { return agentCtx },
      followup,
      cancel: vi.fn(),
    } as unknown as Agent
    resumedAgents.push({ id: options.resumeSessionId, followup })
    return { agent: resumed }
  })
  const createdAgents: { id: string; followup: ReturnType<typeof vi.fn> }[] = []
  const createAgent = vi.fn(async (options: { sessionId: string }) => {
    const followup = vi.fn()
    const created = {
      id: options.sessionId,
      status: 'idle',
      session: { id: options.sessionId, requestHeader: () => undefined },
      options: { provider: 'initial-provider', model: 'initial-model' },
      get ctx() { return agentCtx },
      followup,
      cancel: vi.fn(),
    } as unknown as Agent
    createdAgents.push({ id: options.sessionId, followup })
    return { agent: created }
  })
  ctx.provide('settings', {
    register: () => ({
      get: () => ({ ...savedSettings }),
      update: async (patch: object) => { Object.assign(savedSettings, patch) },
    }),
  } as never)
  ctx.provide('agents', {
    get: (id: string) => id === SESSION_ID ? agent : undefined,
    roots: () => [agent],
    create: createAgent,
    resume: resumeAgent,
  } as never)
  ctx.provide('agentPresets', {
    resolve: vi.fn(async (id: string) => ({ id })),
    standingKeyFor: vi.fn(async () => 'standing-key'),
    mount: vi.fn(async () => undefined),
  } as never)
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'initial-provider', model: 'initial-model' }) } as never)
  ctx.provide('sessionTitle', { get: () => ({ title: 'Release notes draft', source: 'auto' }) } as never)
  const selectModel = vi.fn(async (request: unknown) => ({ selected: request }))
  ctx.provide('sessionController', {
    modelCatalog: async () => ({
      default: { provider: 'initial-provider', model: 'initial-model' },
      routableProviders: ['deepseek-official', 'openai-codex'],
      groups: [
        { id: 'deepseek-official', name: 'DeepSeek', models: [
          { id: 'deepseek-flash', name: 'Flash' },
          { id: 'deepseek-reasoner', name: 'Reasoner', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' } },
        ] },
        { id: 'openai-codex', name: 'Codex', models: [] },
      ],
      failures: [{ id: 'offline', name: 'Offline', message: 'catalog failed' }],
    }),
    selectModel,
  } as never)
  ctx.provide('attachments', {
    admitEncodedFile: async ({ name }: { name?: string }) => {
      admittedFiles.push(name ?? 'unnamed')
      return { attachmentId: `file-${admittedFiles.length}`, name: name ?? 'unnamed', bytes: 3 }
    },
    admitPromptContent: async (parts: readonly { type: string; mediaType?: string }[]) => parts.map((part, index) =>
      part.type === 'image'
        ? { type: 'image', attachment: { attachmentId: `image-${index}`, mediaType: part.mediaType, bytes: 3, width: 1, height: 1 } }
        : part),
  } as never)
  ctx.provide('fileUploads', {
    upload: async (_agent: Agent, request: { name?: string }) => {
      stagedFiles.push(request.name ?? 'unnamed')
      return { receiptId: 'receipt-1', file: { attachmentId: 'file-1', name: request.name ?? 'unnamed', bytes: 3 } }
    },
  } as never)
  ctx.provide('commands', commandRuntime as never)

  const config: Config = {
    token: 'test-token',
    chats: [{ chatId: CHAT_ID, agentId: String(SESSION_ID), workspacePath: '/workspace', agentPreset: 'standard' }],
    pollTimeoutSeconds: 1,
    maxMessageChars: 4096,
    toolProgress: true,
    streamReplies: true,
    streamEditIntervalSeconds: 0.5,
    typingIndicator: true,
    ...overrides,
  }

  const deliver = (text: string): void => {
    updates.push({ update_id: 1, message: { chat: { id: Number(CHAT_ID), type: 'private' }, text } })
    const resume = parked
    parked = undefined
    resume?.()
  }
  // Cordis dispatches an emitted event to listeners on the emitting context and
  // its ancestors, so tests emit from the plugin's own fiber to reach its listeners.
  let emitFrom: Context = ctx
  const start = async () => {
    const scope = await ctx.plugin((_inner: Context) => { /* the stub agent's own scope */ })
    agentCtx = scope.ctx
    const fiber = await ctx.plugin(TelegramService, config)
    emitFrom = fiber.ctx
    return fiber
  }
  const waitFor = async (predicate: () => boolean): Promise<void> => {
    await vi.waitFor(() => { expect(predicate()).toBe(true) }, { timeout: 2000 })
  }
  const texts = (): string[] => sent.map(message => message.text)
  const deliverMedia = (message: Record<string, unknown>): void => {
    updates.push({ update_id: 1, message: { chat: { id: Number(CHAT_ID), type: 'private' }, ...message } })
    const resume = parked
    parked = undefined
    resume?.()
  }
  const callback = (data: string): void => {
    updates.push({ update_id: 1, callback_query: { id: 'cb-1', data: `dsh:${data}`, message: { message_id: 1, chat: { id: Number(CHAT_ID), type: 'private' } } } })
    const resume = parked
    parked = undefined
    resume?.()
  }
  return {
    ctx, agent, start, deliver, deliverMedia, callback, waitFor, texts, sent, documents, definitions, requests, followup,
    downloads, markup, edits, markupEdits, deleted, admittedFiles, stagedFiles, menu, commandRuntime, selectModel, actions,
    resumeAgent, resumedAgents, createAgent, createdAgents, savedSettings,
    emit: (name: string, ...args: unknown[]) => { emitFrom.emit(name, ...args) },
    offset: () => offsetSeen, register: (definition: CommandDefinition) => { definitions.set(definition.name, definition) },
  }
}

const mounted: { dispose: () => Promise<void> }[] = []
afterEach(async () => {
  for (const fiber of mounted.splice(0)) await fiber.dispose()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function boot(overrides: Partial<Config> = {}, options: HarnessOptions = {}) {
  const test = harness(overrides, options)
  mounted.push(await test.start())
  // The first poll proves the fiber's effect ran, so its event listeners exist.
  await test.waitFor(() => test.requests.includes('getUpdates'))
  return test
}

describe('Telegram command surfaces', () => {
  it('opens a session card that marks the selected session and offers a new one', async () => {
    const test = await boot()
    test.deliver('/sessions')
    await test.waitFor(() => test.texts().length === 1)
    expect(test.sent[0]?.text).toBe('会话（1）：\n点一下切换；✅ 是当前会话。')
    expect(test.sent[0]?.buttons?.map(row => row.map(button => button.text))).toEqual([
      ['✅ Release notes draft'],
      ['＋ 新会话'],
    ])
  })

  it('switches sessions from the card and re-marks it in place', async () => {
    const test = await boot()
    test.deliver('/sessions')
    await test.waitFor(() => test.texts().length === 1)
    test.callback('s:0')
    await test.waitFor(() => test.edits.length === 1)
    expect(test.edits[0]?.text).toContain('会话（1）')
  })

  it('reports the selected session and its quick actions in /status', async () => {
    const test = await boot()
    test.deliver('/status')
    await test.waitFor(() => test.texts().length === 1)
    expect(test.texts()[0]).toBe(`Release notes draft\n${SESSION_ID} (idle)\n\n快捷操作：`)
    expect(test.sent[0]?.buttons?.map(row => row.map(button => button.text))).toEqual([['会话', '模型', '新建']])
  })

  it('opens the session and model cards from the status quick actions', async () => {
    const test = await boot()
    test.deliver('/status')
    await test.waitFor(() => test.texts().length === 1)
    test.callback('s:l')
    await test.waitFor(() => test.texts().length === 2)
    expect(test.texts()[1]).toContain('会话（1）')
    test.callback('m:o')
    await test.waitFor(() => test.texts().length === 3)
    expect(test.texts()[2]).toContain('选择 provider')
  })

  it('runs registered host commands with their arguments and replies with the result', async () => {
    const test = await boot()
    test.register({
      name: 'compact', description: 'Compact the transcript', handler: ({ rawInput }) => ({ kind: 'success', text: `compacted${rawInput}` }),
    })
    test.deliver('/compact now')
    await test.waitFor(() => test.texts().length === 1)
    expect(test.texts()[0]).toBe('compacted now')
    expect(test.followup).not.toHaveBeenCalled()
  })

  it('never sends an unknown slash command to the model', async () => {
    const test = await boot()
    test.deliver('/definitely-not-a-command')
    await test.waitFor(() => test.texts().length === 1)
    expect(test.texts()[0]).toContain('Unknown or malformed command')
    expect(test.followup).not.toHaveBeenCalled()
  })

  it('installs the text /model fallback and selects through the Session controller', async () => {
    const test = await boot()
    test.deliver('/help')
    await test.waitFor(() => test.texts().length === 1)
    expect(test.definitions.has('model')).toBe(true)
    expect(test.texts()[0]).toContain('/model')
    test.deliver('/model deepseek-official deepseek-flash')
    await test.waitFor(() => test.texts().length === 2)
    expect(test.texts()[1]).toBe('Next request: deepseek-official deepseek-flash.')
  })

  it('leaves a host-registered model command in place instead of shadowing it', async () => {
    const test = await boot()
    test.register({ name: 'model', description: 'Host picker', handler: () => ({ kind: 'success', text: 'host model' }) })
    test.deliver('/model')
    await test.waitFor(() => test.texts().length === 1)
    expect(test.texts()[0]).toBe('host model')
  })

  it('sends the session archive as a document after a successful /export', async () => {
    const test = await boot()
    test.register({ name: 'export', description: 'Download this Session log as a ZIP archive', handler: () => ({ kind: 'success', text: 'Session log download requested.' }) })
    test.deliver('/export')
    await test.waitFor(() => test.documents.length === 1)
    expect(test.documents[0]).toBe('session.zip')
    expect(test.texts()[0]).toBe('Session log download requested.')
  })

  it('submits ordinary chat text as a user message instead of a command', async () => {
    const test = await boot()
    test.deliver('please summarise the diff')
    await test.waitFor(() => test.followup.mock.calls.length === 1)
    expect(test.followup).toHaveBeenCalledOnce()
  })

  it('advances the update offset only after handling each update', async () => {
    const test = await boot()
    test.deliver('/status')
    await test.waitFor(() => test.texts().length === 1)
    expect(test.requests).toContain('getUpdates')
  })

  it('publishes the adapter’s own commands as the Telegram command menu', async () => {
    const test = await boot()
    await test.waitFor(() => test.menu.length === 1)
    const entries = test.menu[0] as readonly { command: string; description: string }[]
    expect(entries.map(entry => entry.command)).toEqual([
      'new', 'sessions', 'model', 'status', 'rename', 'cancel', 'answer', 'use', 'help', 'commands', 'start',
    ])
    // The Bot API rejects a name outside its own charset and a description over 256 characters.
    for (const entry of entries) {
      expect(entry.command).toMatch(/^[a-z0-9_]{1,32}$/u)
      expect(entry.description.length).toBeLessThanOrEqual(256)
    }
  })

  it('keeps the chat serving when Telegram rejects the command menu', async () => {
    const test = await boot({}, { failMethods: ['setMyCommands'] })
    test.deliver('/status')
    await test.waitFor(() => test.texts().length === 1)
    expect(test.texts()[0]).toContain('Release notes draft')
  })
})

describe('Telegram attachment intake', () => {
  it('submits a photo as admitted image content on the next turn', async () => {
    const test = await boot()
    test.deliverMedia({ photo: [{ file_id: 'photo-1', file_size: 1024 }], caption: 'what is this' })
    await test.waitFor(() => test.followup.mock.calls.length === 1)
    const message = test.followup.mock.calls[0]?.[0] as { content: { type: string; attachment?: unknown }[] }
    expect(message.content[0]).toEqual({ type: 'text', text: 'what is this' })
    expect(message.content[1]).toEqual({
      type: 'image',
      attachment: { attachmentId: 'image-0', mediaType: 'image/jpeg', bytes: 3, width: 1, height: 1 },
    })
    expect(test.downloads[0]).toContain('/file/bot')
  })

  it('admits a document as a durable file reference', async () => {
    const test = await boot()
    test.deliverMedia({ document: { file_id: 'doc-1', file_name: 'notes.md', mime_type: 'text/markdown', file_size: 2048 } })
    await test.waitFor(() => test.followup.mock.calls.length === 1)
    const message = test.followup.mock.calls[0]?.[0] as { content: { type: string }[] }
    expect(message.content).toEqual([{ type: 'file', attachment: { attachmentId: 'file-1', name: 'notes.md', bytes: 3 } }])
    expect(test.admittedFiles).toEqual(['notes.md'])
  })

  it('runs a caption command with its attachment as a submission', async () => {
    const test = await boot()
    test.register({ name: 'compact', description: 'Compact', handler: () => ({ kind: 'success', text: 'ok' }) })
    test.deliverMedia({ document: { file_id: 'doc-1', file_name: 'notes.md', mime_type: 'text/markdown' }, caption: '/compact' })
    await test.waitFor(() => test.texts().length === 1)
    expect(test.stagedFiles).toEqual(['notes.md'])
    expect(test.texts()[0]).toBe('ok')
  })

  it('refuses a file above the Bot API download ceiling without downloading it', async () => {
    const test = await boot()
    test.deliverMedia({ document: { file_id: 'doc-1', file_name: 'huge.bin', file_size: 21_000_000 } })
    await test.waitFor(() => test.texts().length === 1)
    expect(test.texts()[0]).toContain('exceeds')
    expect(test.downloads).toEqual([])
  })
})

describe('Telegram questionnaires', () => {
  it('asks every question in order and settles all answers', async () => {
    const test = await boot()
    const controller = new AbortController()
    const answers = test.ctx.waterfall(
      'user-questions/request',
      { questions: [
        { id: 'q1', question: 'First?', options: [{ label: 'A' }, { label: 'B' }] },
        { id: 'q2', question: 'Second?', options: [{ label: 'C' }, { label: 'D' }] },
      ], agent: test.agent, signal: controller.signal },
      async () => ({ answers: [] }),
    )
    await test.waitFor(() => test.texts().length === 1)
    expect(test.texts()[0]).toContain('First?')
    test.callback('q:s:1')
    await test.waitFor(() => test.texts().length === 2)
    expect(test.texts()[1]).toContain('Second?')
    test.callback('q:s:0')
    await expect(answers).resolves.toEqual({ answers: [
      { id: 'q1', selected: ['B'] },
      { id: 'q2', selected: ['C'] },
    ] })
  })

  it('toggles multi-select options and confirms with Done', async () => {
    const test = await boot()
    const pending = test.ctx.waterfall(
      'user-questions/request',
      { questions: [{ id: 'q1', question: 'Pick', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] }], agent: test.agent },
      async () => ({ answers: [] }),
    )
    await test.waitFor(() => test.texts().length === 1)
    test.callback('q:t:0')
    await test.waitFor(() => test.markup.length === 1)
    expect(test.markup[0]?.labels).toEqual([['☑ A'], ['☐ B'], ['Done']])
    test.callback('q:t:1')
    test.callback('q:d:0')
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: ['A', 'B'] }] })
  })

  it('accepts chat text as the custom answer', async () => {
    const test = await boot()
    const pending = test.ctx.waterfall(
      'user-questions/request',
      { questions: [{ id: 'q1', question: 'Which?', options: [{ label: 'A' }] }], agent: test.agent },
      async () => ({ answers: [] }),
    )
    await test.waitFor(() => test.texts().length === 1)
    test.deliver('something else')
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: [], custom: 'something else' }] })
  })
})

describe('Telegram live progress', () => {
  const session = { id: SESSION_ID, header: { cwd: undefined } } as never

  it('merges every tool call of a turn into one message that settles in place', async () => {
    const test = await boot()
    test.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } })
    test.emit('session/event', session, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{"command":"ls"}' } })
    await test.waitFor(() => test.texts().length === 1)
    expect(test.texts()[0]).toBe('⏳ Bash')
    test.emit('session/event', session, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-2', name: 'edit', arguments: '' } })
    await test.waitFor(() => test.edits.length === 1)
    expect(test.edits[0]?.text).toBe('⏳ Bash\n⏳ Edit')
    test.emit('session/event', session, { type: 'tool/result', data: { turn: 1, step: 1, message: { content: [{ type: 'tool-result', toolCallId: 'call-1', content: [], isError: false }] } } })
    await test.waitFor(() => test.edits.length === 2)
    expect(test.edits[1]?.text).toBe('✅ Bash\n⏳ Edit')
    // One message for the whole turn: every update after the first is an edit.
    expect(test.texts()).toEqual(['⏳ Bash'])
  })

  it('marks a failed tool result in place and starts a new message for the next turn', async () => {
    const test = await boot()
    test.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } })
    test.emit('session/event', session, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-2', name: 'edit', arguments: '' } })
    await test.waitFor(() => test.texts().length === 1)
    test.emit('session/event', session, { type: 'tool/result', data: { turn: 1, step: 1, message: { content: [{ type: 'tool-result', toolCallId: 'call-2', content: [], isError: true }] } } })
    await test.waitFor(() => test.edits.length === 1)
    expect(test.edits[0]?.text).toBe('❌ Edit')
    test.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'stop' } } })
    test.emit('session/event', session, { type: 'turn/start', data: { turn: 2 } })
    test.emit('session/event', session, { type: 'tool/call', data: { turn: 2, step: 1, callId: 'call-3', name: 'bash', arguments: '{}' } })
    await test.waitFor(() => test.texts().length === 2)
    expect(test.texts()[1]).toBe('⏳ Bash')
  })

  it('streams the reply into one message and replaces it with the committed text', async () => {
    const test = await boot()
    test.emit('agent/assistant-stream', { agent: test.agent, frame: { type: 'start' } })
    test.emit('agent/assistant-stream', { agent: test.agent, frame: { type: 'chunk', chunk: { type: 'text-delta', index: 0, text: 'Hel' } } })
    await test.waitFor(() => test.texts().length === 1)
    expect(test.texts()[0]).toBe('Hel')
    test.emit('session/event', session, { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'Hello there' }] } } })
    await test.waitFor(() => test.edits.length === 1)
    expect(test.edits[0]?.text).toBe('Hello there')
    expect(test.texts()).toEqual(['Hel'])
  })

  it('delivers a Web-presented small video through Telegram', async () => {
    const test = await boot()
    const root = await mkdtemp('/tmp/dsh-telegram-present-')
    await writeFile(join(root, 'clip.mp4'), Buffer.from('video'))
    try {
      test.emit('session/event', { id: SESSION_ID, header: { cwd: root } } as never, {
        type: 'deliverables/presented', data: { files: [{ path: 'clip.mp4', description: 'Downloaded clip' }] },
      })
      await test.waitFor(() => test.requests.includes('sendVideo'))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('splits a Web-presented file above Telegram’s upload ceiling', async () => {
    const test = await boot()
    const root = await mkdtemp('/tmp/dsh-telegram-present-large-')
    await writeFile(join(root, 'large.bin'), Buffer.alloc(50_000_001))
    try {
      test.emit('session/event', { id: SESSION_ID, header: { cwd: root } } as never, {
        type: 'deliverables/presented', data: { files: [{ path: 'large.bin' }] },
      })
      await test.waitFor(() => test.requests.filter(method => method === 'sendDocument').length === 2)
      expect(test.texts().some(text => text.includes('拆分为 2 个分片'))).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('Telegram update failures', () => {
  it('reports a failed update back to the chat instead of failing silently', async () => {
    const test = await boot()
    test.followup.mockImplementationOnce(() => { throw new Error('boom') })
    test.deliver('please answer')
    await test.waitFor(() => test.texts().some(text => text.includes('Telegram update failed')))
    expect(test.texts()[0]).toContain('boom')
  })
})

describe('Telegram model card', () => {
  it('opens provider buttons for a bare /model, then model buttons for the provider', async () => {
    const test = await boot()
    test.deliver('/model')
    await test.waitFor(() => test.sent.length === 1)
    expect(test.sent[0]?.text).toContain('选择 provider')
    expect(test.sent[0]?.buttons?.map(row => row.map(button => button.text))).toEqual([['DeepSeek'], ['Codex']])
    test.callback('m:p:0')
    await test.waitFor(() => test.markupEdits.length === 1)
    expect(test.markupEdits[0]?.text).toContain('DeepSeek · 选择模型')
    expect(test.markupEdits[0]?.buttons?.map(row => row.map(button => button.text))).toEqual([
      ['Flash'],
      ['Reasoner ⚙'],
      ['« provider'],
    ])
  })

  it('selects a model that has no reasoning step straight from the model card', async () => {
    const test = await boot()
    test.deliver('/model')
    await test.waitFor(() => test.sent.length === 1)
    test.callback('m:p:0')
    await test.waitFor(() => test.markupEdits.length === 1)
    test.callback('m:i:0:0')
    await test.waitFor(() => test.selectModel.mock.calls.length === 1)
    expect(test.selectModel).toHaveBeenCalledWith({ sessionId: SESSION_ID, provider: 'deepseek-official', model: 'deepseek-flash' })
    await test.waitFor(() => test.texts().some(text => text.includes('Next request')))
    expect(test.deleted.length).toBe(1)
  })

  it('asks for reasoning effort and applies the tapped one', async () => {
    const test = await boot()
    test.deliver('/model')
    await test.waitFor(() => test.sent.length === 1)
    test.callback('m:p:0')
    await test.waitFor(() => test.markupEdits.length === 1)
    test.callback('m:i:0:1')
    await test.waitFor(() => test.markupEdits.length === 2)
    expect(test.markupEdits[1]?.text).toContain('Reasoner · 选择推理强度')
    expect(test.markupEdits[1]?.buttons?.map(row => row.map(button => button.text))).toEqual([
      ['Low · 适配器默认'],
      ['High'],
      ['不指定（由适配器决定）'],
      ['« 模型'],
    ])
    test.callback('m:e:0:1:1')
    await test.waitFor(() => test.selectModel.mock.calls.length === 1)
    expect(test.selectModel).toHaveBeenCalledWith({
      sessionId: SESSION_ID, provider: 'deepseek-official', model: 'deepseek-reasoner', reasoningEffort: 'high',
    })
  })

  it('keeps the manual form working and reports an expired card', async () => {
    const test = await boot()
    test.deliver('/model deepseek-official deepseek-flash high')
    await test.waitFor(() => test.selectModel.mock.calls.length === 1)
    expect(test.selectModel).toHaveBeenCalledWith({
      sessionId: SESSION_ID, provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high',
    })
    test.callback('m:p:0')
    await test.waitFor(() => test.texts().some(text => text.includes('已过期')))
  })
})

describe('Telegram typing indicator', () => {
  const session = { id: SESSION_ID } as never

  it('shows typing for the whole turn and stops when it ends', async () => {
    vi.useFakeTimers()
    try {
      const test = await boot()
      test.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } })
      await vi.advanceTimersByTimeAsync(0)
      expect(test.actions).toEqual(['typing'])
      await vi.advanceTimersByTimeAsync(8_000)
      expect(test.actions.length).toBe(3)
      test.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'stop' } } })
      await vi.advanceTimersByTimeAsync(20_000)
      expect(test.actions.length).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('asks before typing when the deployment turns the indicator off', async () => {
    const test = await boot({ typingIndicator: false })
    test.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(test.actions).toEqual([])
  })
})

describe('Telegram session inheritance', () => {
  it('resumes the chat’s persisted session instead of starting a new one', async () => {
    // A restarted process has no live selection, only the persisted session id.
    const test = await boot(
      { chats: [{ chatId: CHAT_ID, workspacePath: '/workspace', agentPreset: 'standard' }] },
      { savedSessionId: 'session-from-before-restart' },
    )
    test.deliver('继续之前的话题')
    await test.waitFor(() => test.resumeAgent.mock.calls.length === 1)
    expect(test.resumeAgent).toHaveBeenCalledWith(expect.objectContaining({ resumeSessionId: 'session-from-before-restart' }))
    await test.waitFor(() => (test.resumedAgents[0]?.followup.mock.calls.length ?? 0) === 1)
    expect(test.createAgent).not.toHaveBeenCalled()
  })

  it('records the selected session so the next process resumes it', async () => {
    const test = await boot()
    test.deliver('/new')
    await test.waitFor(() => test.createAgent.mock.calls.length === 1)
    await test.waitFor(() => test.savedSettings['sessionId'] !== undefined)
    expect(test.savedSettings['sessionId']).toBeDefined()
  })
})
