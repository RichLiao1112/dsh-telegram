/** Text model picker over the same validated Session API used by the Web picker. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'

/**
 * Build the Telegram text equivalent of the browser's model picker.
 * @param ctx - Telegram plugin context; the Session controller is optional.
 * @returns a command definition whose selection uses the existing admission and persistence rules.
 */
export function telegramModelCommand(ctx: Context): CommandDefinition {
  return {
    name: 'model',
    description: 'Show models or select /model <provider> <model> [reasoning-effort]',
    input: { hint: '[provider model [reasoning-effort]]' },
    handler: async ({ agent, rawInput, signal }) => {
      const controller = ctx.get('sessionController')
      if (controller === undefined) return { kind: 'error', text: 'Model selection is unavailable: this deployment has no Session controller.' }
      signal.throwIfAborted()
      const args = rawInput.trim().split(/\s+/u).filter(Boolean)
      if (args.length === 0) {
        const catalog = await controller.modelCatalog()
        signal.throwIfAborted()
        const header = agent.session.requestHeader()
        const current = header?.config ?? agent.options
        return {
          kind: 'success',
          text: [
            `Last used / initial model: ${current.provider ?? catalog.default.provider} ${current.model ?? catalog.default.model}`,
            'Select: /model <provider> <model> [reasoning-effort]. Selection also updates the deployment default, as in Web.',
            ...catalog.groups.flatMap(group => [
              `${group.name} (${group.id}):`,
              ...group.models.map(model => `  /model ${group.id} ${model.id}${model.reasoning === undefined ? '' : ` — reasoning: ${model.reasoning.efforts.map(effort => effort.id).join(', ')}`}`),
            ]),
            ...catalog.failures.map(failure => `Catalog unavailable for ${failure.id}: ${failure.message}`),
          ].join('\n'),
        }
      }
      const [provider, model, reasoningEffort] = args
      if (provider === undefined || model === undefined || args.length > 3) {
        return { kind: 'error', text: 'Usage: /model [<provider> <model> [reasoning-effort]]' }
      }
      signal.throwIfAborted()
      const { selected } = await controller.selectModel({
        sessionId: agent.id,
        provider,
        model,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      })
      return {
        kind: 'success',
        text: `Next request: ${selected.provider} ${selected.model}${selected.reasoningEffort === undefined ? '' : ` (${selected.reasoningEffort})`}.`,
      }
    },
  }
}
