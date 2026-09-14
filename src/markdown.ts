/**
 * Markdown to Telegram HTML for chat output. Telegram renders a small HTML
 * subset, so model output is converted rather than passed through raw; a
 * rejected parse falls back to the plain-text projection.
 */

/** Escape the three characters Telegram's HTML parser treats as markup. */
function escapeHtml(text: string): string {
  return text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
}

/** Inline formatting applied to text that is not a code span. */
function formatPlain(escaped: string): string {
  return escaped
    .replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/gu, '<a href="$2">$1</a>')
    .replace(/\*\*([^*\n]+)\*\*/gu, '<b>$1</b>')
    .replace(/__([^_\n]+)__/gu, '<b>$1</b>')
    .replace(/~~([^~\n]+)~~/gu, '<s>$1</s>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*/gu, '$1<i>$2</i>')
}

/** Render one line of escaped markdown, protecting inline code from later rules. */
function formatLine(escaped: string): string {
  const heading = /^#{1,6}\s+(.*)$/u.exec(escaped)
  const body = heading === null ? escaped : `<b>${heading[1] ?? ''}</b>`
  return body.split(/(`[^`\n]+`)/u).map(part =>
    part.length > 2 && part.startsWith('`') && part.endsWith('`')
      ? `<code>${part.slice(1, -1)}</code>`
      : formatPlain(part)).join('')
}

/**
 * Convert a Markdown message into Telegram's supported HTML subset.
 * @param markdown - model or command output.
 * @returns HTML safe to send with `parse_mode: 'HTML'`.
 */
export function toTelegramHtml(markdown: string): string {
  const lines = markdown.split('\n')
  const output: string[] = []
  let fence: string[] | undefined
  for (const line of lines) {
    if (/^\s*```/u.test(line)) {
      if (fence === undefined) {
        fence = []
        continue
      }
      output.push(`<pre>${escapeHtml(fence.join('\n'))}</pre>`)
      fence = undefined
      continue
    }
    if (fence !== undefined) {
      fence.push(line)
      continue
    }
    const bullet = /^\s*[-*+]\s+(.*)$/u.exec(line)
    const ordered = /^\s*(\d+)[.)]\s+(.*)$/u.exec(line)
    const quote = /^\s*>\s?(.*)$/u.exec(line)
    if (bullet !== null) output.push(`• ${formatLine(escapeHtml(bullet[1] ?? ''))}`)
    else if (ordered !== null) output.push(`${ordered[1] ?? ''}. ${formatLine(escapeHtml(ordered[2] ?? ''))}`)
    else if (quote !== null) output.push(`▏ ${formatLine(escapeHtml(quote[1] ?? ''))}`)
    else if (/^\s*(---|\*\*\*|___)\s*$/u.test(line)) output.push('————')
    else output.push(formatLine(escapeHtml(line)))
  }
  if (fence !== undefined) output.push(`<pre>${escapeHtml(fence.join('\n'))}</pre>`)
  return output.join('\n')
}

/**
 * Reduce Telegram HTML back to readable plain text for the fallback send.
 * @param html - output of {@link toTelegramHtml} or raw text.
 * @returns text with markup removed and entities decoded.
 */
export function stripMarkup(html: string): string {
  return html
    .replace(/<a href="([^"]+)">([^<]*)<\/a>/gu, '$2 ($1)')
    .replace(/<\/?(?:b|i|s|u|code|pre|blockquote)>/gu, '')
    .replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&amp;/gu, '&')
}

/**
 * Split one Markdown message into sendable chunks without cutting a fenced
 * code block, so each chunk converts to balanced HTML.
 * @param markdown - the complete message.
 * @param maxChars - per-message ceiling.
 * @returns chunks in order; never empty.
 */
export function splitMarkdown(markdown: string, maxChars: number): string[] {
  const chunks: string[] = []
  let current: string[] = []
  let size = 0
  let inFence = false
  const flush = (): void => {
    if (current.length === 0) return
    const text = current.join('\n')
    // An oversized fenced block is hard-split rather than dropped.
    for (let index = 0; index < text.length; index += maxChars) {
      chunks.push(text.slice(index, index + maxChars))
    }
    current = []
    size = 0
  }
  for (const line of markdown.split('\n')) {
    const lineSize = line.length + 1
    if (!inFence && size + lineSize > maxChars && current.length > 0) flush()
    current.push(line)
    size += lineSize
    if (/^\s*```/u.test(line)) inFence = !inFence
  }
  flush()
  return chunks.length === 0 ? [''] : chunks
}
