import { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { describe, expect, it, vi } from 'vitest'
import { telegramModelCommand } from '../src/model-command.ts'
import { telegramRenameCommand } from '../src/rename-command.ts'

function fixture() {
  const ctx = new Context()
  const modelCatalog = vi.fn(async () => ({
    default: { provider: 'provider', model: 'default' },
    routableProviders: ['provider'],
    groups: [{ id: 'provider', name: 'Provider', models: [
      { id: 'test/model', name: 'Test', reasoning: { efforts: [{ id: 'low', name: 'Low' }] } },
    ] }],
    failures: [{ id: 'offline', name: 'Offline', message: 'Catalog failed' }],
  }))
  const selectModel = vi.fn(async (request: { provider: string; model: string; reasoningEffort?: string }) => ({ selected: request }))
  ctx.provide('sessionController', { modelCatalog, selectModel } as never)
  const invoke = async (rawInput: string, signal = new AbortController().signal): Promise<CommandResult> =>
    await telegramModelCommand(ctx).handler({
      rawInput,
      signal,
      agent: {
        id: 'session',
        options: { provider: 'initial', model: 'initial-model' },
        session: { requestHeader: () => undefined },
      },
    } as unknown as CommandInvocation)
  return { ctx, invoke, modelCatalog, selectModel }
}

describe('Telegram model command', () => {
  it('lists exact provider/model command lines, reasoning and catalog failures', async () => {
    const test = fixture()
    const result = await test.invoke('')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('Last used / initial model: initial initial-model')
    expect(result.text).toContain('/model provider test/model — reasoning: low')
    expect(result.text).toContain('Catalog unavailable for offline: Catalog failed')
    expect(test.selectModel).not.toHaveBeenCalled()
  })

  it('uses the existing validated Session selection operation', async () => {
    const test = fixture()
    await expect(test.invoke(' provider test/model low')).resolves.toEqual({ kind: 'success', text: 'Next request: provider test/model (low).' })
    expect(test.selectModel).toHaveBeenCalledWith({ sessionId: 'session', provider: 'provider', model: 'test/model', reasoningEffort: 'low' })
    await test.invoke(' provider test/model')
    expect(test.selectModel).toHaveBeenLastCalledWith({ sessionId: 'session', provider: 'provider', model: 'test/model' })
  })

  it('rejects incomplete and extra arguments without mutating selection', async () => {
    const test = fixture()
    for (const rawInput of ['provider', 'provider model low extra']) {
      const result = await test.invoke(rawInput)
      expect(result.kind).toBe('error')
      expect(result.text).toContain('Usage:')
    }
    expect(test.selectModel).not.toHaveBeenCalled()
  })

  it('preserves controller errors for command lifecycle normalization', async () => {
    const test = fixture()
    test.selectModel.mockRejectedValueOnce(new Error('model unavailable'))
    await expect(test.invoke(' provider unknown')).rejects.toThrow('model unavailable')
  })

  it('does not start model reads or changes for cancelled invocations', async () => {
    const test = fixture()
    const cancellation = new AbortController()
    cancellation.abort(new Error('cancelled'))
    await expect(test.invoke('', cancellation.signal)).rejects.toThrow('cancelled')
    await expect(test.invoke(' provider model', cancellation.signal)).rejects.toThrow('cancelled')
    expect(test.modelCatalog).not.toHaveBeenCalled()
    expect(test.selectModel).not.toHaveBeenCalled()
  })

  it('reports missing optional Session controller instead of pretending to select', async () => {
    const command = telegramModelCommand(new Context())
    const result = await command.handler({ rawInput: '', signal: new AbortController().signal } as CommandInvocation)
    expect(result.kind).toBe('error')
    expect(result.text).toContain('no Session controller')
  })
})

describe('Telegram rename command', () => {
  it('pins the title through the Session controller', async () => {
    const ctx = new Context()
    const rename = vi.fn(async (request: { title: string }) => ({ title: request.title, seq: 7 }))
    ctx.provide('sessionController', { rename } as never)
    const result = await telegramRenameCommand(ctx).handler({
      rawInput: '  Release notes  ', signal: new AbortController().signal, agent: { id: 'session' },
    } as unknown as CommandInvocation)
    expect(result).toEqual({ kind: 'success', text: 'Renamed to Release notes.' })
    expect(rename).toHaveBeenCalledWith({ sessionId: 'session', title: 'Release notes' })
  })

  it('rejects an empty title and reports a missing controller', async () => {
    const ctx = new Context()
    ctx.provide('sessionController', { rename: vi.fn() } as never)
    await expect(telegramRenameCommand(ctx).handler({
      rawInput: '   ', signal: new AbortController().signal, agent: { id: 'session' },
    } as unknown as CommandInvocation)).resolves.toEqual({ kind: 'error', text: 'Usage: /rename <title>' })
    await expect(telegramRenameCommand(new Context()).handler({
      rawInput: 'x', signal: new AbortController().signal, agent: { id: 'session' },
    } as unknown as CommandInvocation)).resolves.toMatchObject({ kind: 'error' })
  })
})
