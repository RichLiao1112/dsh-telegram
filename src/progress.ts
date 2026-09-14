/** Compact chat rendering of live turn progress: tool activity and streamed reply text. */

import type { StreamChunk } from '@deepseek-ai/dsh-llm/types'

/**
 * Extract the assistant text carried by one stream chunk.
 * @param chunk - one model stream chunk.
 * @returns the delta text, or an empty string for chunks that carry none.
 */
export function streamTextOf(chunk: StreamChunk): string {
  return chunk.type === 'text-delta' ? chunk.text : ''
}

/** Flush pacing and text ceiling for one streamed reply message. */
export interface StreamFlushPolicy {
  /** Milliseconds between two edits of the same message. */
  readonly intervalMs: number
  /** Maximum characters published in one streamed message. */
  readonly maxChars: number
}

/**
 * Decide whether accumulated stream text should be published now.
 * @param policy - flush pacing and ceiling.
 * @param state - accumulated text and the last publish time.
 * @param now - current epoch milliseconds.
 * @returns whether the caller should send or edit the streamed message.
 */
export function shouldFlushStream(
  policy: StreamFlushPolicy,
  state: { readonly text: string; readonly published: number; readonly lastFlush: number },
  now: number,
): boolean {
  if (state.text === '' || state.published === state.text.length) return false
  return now - state.lastFlush >= policy.intervalMs
}

/**
 * Bound one streamed message body to the configured ceiling.
 * @param text - accumulated assistant text.
 * @param maxChars - maximum published characters.
 * @returns the published text.
 */
export function clampStreamText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars)
}
