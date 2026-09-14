/** Telegram export reuses the Host ZIP producer and enforces the upload ceiling. */

import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_SESSION_LOG_COMPRESSION_LEVEL,
  flushLiveSessionLog,
  readSessionLogText,
  sessionLogExportDeps,
  sessionLogZipFilename,
  streamSessionLogZip,
  type SessionLogExportDeps,
} from '@deepseek-ai/dsh-session-log-export'
import { exportTelegramSessionLog, TELEGRAM_DOCUMENT_MAX_BYTES } from '../src/export-command.ts'

vi.mock('@deepseek-ai/dsh-session-log-export', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-session-log-export')>()
  return {
    ...actual,
    sessionLogExportDeps: vi.fn(),
    flushLiveSessionLog: vi.fn(),
    readSessionLogText: vi.fn(),
    streamSessionLogZip: vi.fn(),
  }
})

const id = SessionId('telegram-export-session')
const ctx = new Context()
// The mocked owner APIs consume these opaque service identities; this suite never calls their methods.
const ready = {
  sessionQuery: {}, sessionPersistence: {}, attachments: {}, sessions: undefined,
} as unknown as SessionLogExportDeps

function archiveStream(chunks: Uint8Array[]): void {
  vi.mocked(streamSessionLogZip).mockReturnValue(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  }))
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(sessionLogExportDeps).mockReturnValue(ready)
  vi.mocked(flushLiveSessionLog).mockResolvedValue(undefined)
  vi.mocked(readSessionLogText).mockResolvedValue('session log')
})

describe('exportTelegramSessionLog', () => {
  it('flushes before reading and returns the shared ZIP bytes and filename', async () => {
    const signal = new AbortController().signal
    const bytes = new TextEncoder().encode('ZIP 中文')
    archiveStream([bytes.subarray(0, 3), bytes.subarray(3)])
    const archive = await exportTelegramSessionLog(ctx, id, signal)
    expect(archive).toEqual({ bytes: Buffer.from(bytes), filename: sessionLogZipFilename(id) })
    expect(sessionLogExportDeps).toHaveBeenCalledWith(ctx)
    expect(flushLiveSessionLog).toHaveBeenCalledWith(ready, id, signal)
    expect(readSessionLogText).toHaveBeenCalledWith(ready.sessionPersistence, id, signal)
    expect(vi.mocked(flushLiveSessionLog).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(readSessionLogText).mock.invocationCallOrder[0]!)
    expect(streamSessionLogZip).toHaveBeenCalledWith(
      ready, 'session log', id, false, DEFAULT_SESSION_LOG_COMPRESSION_LEVEL, signal,
    )
  })

  it.each(['sessionQuery', 'sessionPersistence', 'attachments'] as const)(
    'returns unavailable without %s and performs no reads', async (service) => {
      vi.mocked(sessionLogExportDeps).mockReturnValue({ ...ready, [service]: undefined })
      expect(await exportTelegramSessionLog(ctx, id, new AbortController().signal)).toBeUndefined()
      expect(flushLiveSessionLog).not.toHaveBeenCalled()
      expect(streamSessionLogZip).not.toHaveBeenCalled()
    },
  )

  it('accepts an archive exactly at the document byte limit', async () => {
    archiveStream([new Uint8Array(TELEGRAM_DOCUMENT_MAX_BYTES)])
    const archive = await exportTelegramSessionLog(ctx, id, new AbortController().signal)
    expect(archive?.bytes.byteLength).toBe(TELEGRAM_DOCUMENT_MAX_BYTES)
  })

  it.each([false, true])('rejects oversized complete output and cancels producer (single chunk: %s)', async (single) => {
    const cancel = vi.fn()
    const chunks = single
      ? [new Uint8Array(TELEGRAM_DOCUMENT_MAX_BYTES + 1)]
      : [new Uint8Array(TELEGRAM_DOCUMENT_MAX_BYTES), new TextEncoder().encode('中')]
    vi.mocked(streamSessionLogZip).mockReturnValue(new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
      },
      cancel,
    }))
    await expect(exportTelegramSessionLog(ctx, id, new AbortController().signal)).rejects.toThrow('50 MB')
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('does not turn a missing stored log into an unavailable-service response', async () => {
    vi.mocked(readSessionLogText).mockResolvedValue(undefined)
    await expect(exportTelegramSessionLog(ctx, id, new AbortController().signal)).rejects.toThrow('export failed')
    expect(streamSessionLogZip).not.toHaveBeenCalled()
  })

  it('does not expose persistence paths in the Telegram error', async () => {
    vi.mocked(flushLiveSessionLog).mockRejectedValue(new Error('/private/secret-session-path'))
    await expect(exportTelegramSessionLog(ctx, id, new AbortController().signal)).rejects.toThrow(
      'Session archive export failed. Check the stored session log and attachments.',
    )
  })

  it('propagates prior cancellation without touching export services', async () => {
    const controller = new AbortController()
    const reason = new Error('operation disposed')
    controller.abort(reason)
    await expect(exportTelegramSessionLog(ctx, id, controller.signal)).rejects.toBe(reason)
    expect(sessionLogExportDeps).not.toHaveBeenCalled()
  })

  it('cancels and unlocks the ZIP stream when cancellation arrives during a read', async () => {
    const controller = new AbortController()
    const reason = new Error('operation disposed')
    const cancel = vi.fn()
    // The default queue holds one chunk, so the first pull fills it and the
    // abort lands with the second pull — after the loop has already read.
    let pulls = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(producer) {
        pulls += 1
        producer.enqueue(new Uint8Array([1]))
        if (pulls === 2) controller.abort(reason)
      },
      cancel,
    })
    vi.mocked(streamSessionLogZip).mockReturnValue(stream)
    await expect(exportTelegramSessionLog(ctx, id, controller.signal)).rejects.toBe(reason)
    expect(cancel).toHaveBeenCalledOnce()
    expect(stream.locked).toBe(false)
  })

  it('sanitizes producer failures and releases the reader', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.error(new Error('/private/attachment')) },
    })
    vi.mocked(streamSessionLogZip).mockReturnValue(stream)
    await expect(exportTelegramSessionLog(ctx, id, new AbortController().signal)).rejects.toThrow('export failed')
    expect(stream.locked).toBe(false)
  })
})
