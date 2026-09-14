/** Session ZIP preparation for Telegram's multipart sendDocument transport. */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  DEFAULT_SESSION_LOG_COMPRESSION_LEVEL,
  flushLiveSessionLog,
  readSessionLogText,
  sessionLogExportDeps,
  sessionLogZipFilename,
  streamSessionLogZip,
} from '@deepseek-ai/dsh-session-log-export'

/** Conservative byte ceiling for the cloud Bot API's 50 MB document upload limit. */
export const TELEGRAM_DOCUMENT_MAX_BYTES = 50_000_000

/** A complete ZIP ready for a multipart document upload, not a browser download URL. */
export interface TelegramSessionArchive {
  readonly bytes: Buffer
  readonly filename: string
}

/**
 * Prepare the selected session and referenced attachments after `/export` succeeds.
 * Uses Host export services directly; no browser credentials or HTTP route are needed.
 * Rejects missing logs, archive failures, and archives exceeding Telegram's upload
 * limit. Cancels the ZIP producer on failure and never returns a truncated archive.
 * @param ctx - the authorized chat's Host context.
 * @param sessionId - the selected session authorized by the command dispatcher.
 * @param signal - cancellation owned by the Telegram command operation.
 * @returns ZIP bytes and filename, or undefined if required export services are absent.
 */
export async function exportTelegramSessionLog(
  ctx: Context,
  sessionId: SessionId,
  signal: AbortSignal,
): Promise<TelegramSessionArchive | undefined> {
  signal.throwIfAborted()
  const deps = sessionLogExportDeps(ctx)
  if (deps.sessionQuery === undefined || deps.sessionPersistence === undefined || deps.attachments === undefined) {
    return undefined
  }
  let oversized = false
  try {
    await flushLiveSessionLog(deps, sessionId, signal)
    const root = await readSessionLogText(deps.sessionPersistence, sessionId, signal)
    signal.throwIfAborted()
    if (root === undefined) throw new Error('Session log unavailable')
    const stream = streamSessionLogZip({
      sessionQuery: deps.sessionQuery,
      sessionPersistence: deps.sessionPersistence,
      attachments: deps.attachments,
      sessions: deps.sessions,
    }, root, sessionId, false, DEFAULT_SESSION_LOG_COMPRESSION_LEVEL, signal)
    const reader = stream.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    let complete = false
    try {
      while (true) {
        signal.throwIfAborted()
        const { value, done } = await reader.read()
        signal.throwIfAborted()
        if (done) {
          complete = true
          break
        }
        if (value.byteLength > TELEGRAM_DOCUMENT_MAX_BYTES - size) {
          oversized = true
          throw new Error('Document exceeds upload limit')
        }
        size += value.byteLength
        chunks.push(value)
      }
      return { bytes: Buffer.concat(chunks, size), filename: sessionLogZipFilename(sessionId) }
    } finally {
      try {
        if (!complete) await reader.cancel()
      } finally {
        reader.releaseLock()
      }
    }
  } catch {
    signal.throwIfAborted()
    // Persistence and attachment errors can contain host paths; do not expose them in Telegram.
    throw new Error(oversized
      ? 'Session archive exceeds Telegram’s 50 MB document upload limit.'
      : 'Session archive export failed. Check the stored session log and attachments.')
  }
}
