/** Text session rename over the same validated Session API the Web title editor uses. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'

/**
 * Build the Telegram text equivalent of the Web session title editor.
 * @param ctx - Telegram plugin context; the Session controller is optional.
 * @returns a command definition that pins the selected session's title.
 */
export function telegramRenameCommand(ctx: Context): CommandDefinition {
  return {
    name: 'rename',
    description: 'Rename this session',
    input: { hint: '<title>' },
    handler: async ({ agent, rawInput, signal }) => {
      const controller = ctx.get('sessionController')
      if (controller === undefined) return { kind: 'error', text: 'Renaming is unavailable: this deployment has no Session controller.' }
      const title = rawInput.trim()
      if (title === '') return { kind: 'error', text: 'Usage: /rename <title>' }
      signal.throwIfAborted()
      const accepted = await controller.rename({ sessionId: agent.id, title })
      return { kind: 'success', text: `Renamed to ${accepted.title}.` }
    },
  }
}
