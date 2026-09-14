/**
 * One message per turn that lists tool activity, the Telegram equivalent of
 * the Web conversation's tool cards: a title line per call that its result
 * settles in place.
 */

/** Settlement state of one tool call. */
export type ToolBoardStatus = 'running' | 'done' | 'failed'

/** One line of the tool activity board. */
export interface ToolBoardLine {
  /** Provider-issued call id, used to settle the line. */
  readonly callId: string
  /** Human title, e.g. `Bash · Clean typing lifecycle`. */
  readonly title: string
  /** Current settlement state. */
  readonly status: ToolBoardStatus
}

/** Status marker per settlement state. */
const MARKERS: Record<ToolBoardStatus, string> = {
  running: '⏳',
  done: '✅',
  failed: '❌',
}

/** Maximum characters of one board line's title. */
const TITLE_CHARS = 96

/** Collapse a multi-line title into one bounded line. */
export function boardTitle(text: string): string {
  const collapsed = text.replace(/\s+/gu, ' ').trim()
  return collapsed.length <= TITLE_CHARS ? collapsed : `${collapsed.slice(0, TITLE_CHARS - 1)}…`
}

/**
 * Render the whole board as one message body.
 * @param lines - activity in call order.
 * @param maxChars - message ceiling; the oldest settled lines are dropped first.
 * @returns the message text.
 */
export function renderToolBoard(lines: readonly ToolBoardLine[], maxChars: number): string {
  const render = (window: readonly ToolBoardLine[], omitted: number): string => [
    ...omitted === 0 ? [] : [`… 更早的 ${omitted} 条已完成`],
    ...window.map(line => `${MARKERS[line.status]} ${line.title}`),
  ].join('\n')
  if (lines.length === 0) return ''
  let start = 0
  let text = render(lines, 0)
  while (text.length > maxChars && start < lines.length - 1) {
    start += 1
    text = render(lines.slice(start), start)
  }
  return text.length <= maxChars ? text : text.slice(0, maxChars)
}
