/**
 * Pure card builders for the Telegram interactive pickers. Each builder returns
 * the message text plus its inline keyboard; the transport owns sending,
 * editing, and the callback payloads.
 */

import type { ModelCatalog, ModelProviderGroup } from '@deepseek-ai/dsh-api-session-controller'

/** One inline keyboard row of callback buttons. */
export type CardKeyboard = readonly (readonly { readonly text: string; readonly callback_data: string }[])[]

/** One rendered card: message text and the buttons below it. */
export interface Card {
  readonly text: string
  readonly keyboard: CardKeyboard
}

/** Maximum characters of a button label, well inside Telegram's own limit. */
const LABEL_CHARS = 28

/** Callback payload for the provider list. */
export const MODEL_PROVIDERS = 'dsh:m:p'
/** Callback payload returning from a model list to the provider list. */
export const MODEL_BACK = 'dsh:m:b'

/** Shorten one label for an inline button. */
function label(text: string): string {
  return text.length <= LABEL_CHARS ? text : `${text.slice(0, LABEL_CHARS - 1)}…`
}

/** Read one provider group by its position in the catalog. */
export function providerAt(catalog: ModelCatalog, index: number): ModelProviderGroup | undefined {
  return catalog.groups[index]
}

/** Read one model of a provider group by position. */
export function modelAt(
  catalog: ModelCatalog,
  providerIndex: number,
  modelIndex: number,
): ModelProviderGroup['models'][number] | undefined {
  return providerAt(catalog, providerIndex)?.models[modelIndex]
}

/**
 * Build the current provider card.
 * @param catalog - host model catalog snapshot.
 * @param current - the session's current provider and model, when known.
 * @returns the provider card.
 */
export function providerCard(catalog: ModelCatalog, current: { provider?: string; model?: string }): Card {
  const rows: { text: string; callback_data: string }[][] = []
  catalog.groups.forEach((group, index) => {
    const models = group.models.length === 1 ? ` · ${label(group.models[0]?.name ?? '')}` : ''
    // A single-model provider selects directly; the label already names it.
    rows.push([{ text: `${label(group.name)}${models}`, callback_data: `${MODEL_PROVIDERS}:${index}` }])
  })
  const failures = catalog.failures.map(failure => `⚠️ ${failure.name}: ${failure.message}`)
  return {
    text: [
      current.provider === undefined || current.model === undefined
        ? `当前模型：${catalog.default.provider} ${catalog.default.model}`
        : `当前模型：${current.provider} ${current.model}`,
      '选择 provider：',
      ...failures,
    ].join('\n'),
    keyboard: rows,
  }
}

/**
 * Build one provider's model card.
 * @param catalog - host model catalog snapshot.
 * @param providerIndex - position of the provider in the catalog.
 * @returns the model card, or `undefined` when the provider is unknown.
 */
export function modelCard(catalog: ModelCatalog, providerIndex: number): Card | undefined {
  const group = providerAt(catalog, providerIndex)
  if (group === undefined) return undefined
  const rows = group.models.map((model, index) => [{
    text: `${label(model.name)}${model.reasoning === undefined ? '' : ' ⚙'}`,
    callback_data: `dsh:m:i:${providerIndex}:${index}`,
  }])
  rows.push([{ text: '« provider', callback_data: MODEL_BACK }])
  return {
    text: [
      `${group.name} · 选择模型：`,
      '⚙ 表示可选推理强度。',
      ...group.models.length === 0 ? ['该 provider 当前没有可用模型。'] : [],
    ].join('\n'),
    keyboard: rows,
  }
}

/**
 * Build the reasoning-effort step for one model.
 * @param catalog - host model catalog snapshot.
 * @param providerIndex - position of the provider in the catalog.
 * @param modelIndex - position of the model inside the provider.
 * @returns the effort card, or `undefined` when the model is unknown or has no efforts.
 */
export function effortCard(catalog: ModelCatalog, providerIndex: number, modelIndex: number): Card | undefined {
  const model = modelAt(catalog, providerIndex, modelIndex)
  const reasoning = model?.reasoning
  if (model === undefined || reasoning === undefined) return undefined
  const rows = reasoning.efforts.map((effort, index) => [{
    text: `${label(effort.name)}${effort.id === reasoning.defaultEffort ? ' · 适配器默认' : ''}`,
    callback_data: `dsh:m:e:${providerIndex}:${modelIndex}:${index}`,
  }])
  rows.push([{ text: '不指定（由适配器决定）', callback_data: `dsh:m:d:${providerIndex}:${modelIndex}` }])
  rows.push([{ text: '« 模型', callback_data: `${MODEL_PROVIDERS}:${providerIndex}` }])
  return {
    text: `${model.name} · 选择推理强度：`,
    keyboard: rows,
  }
}

/** Callback payload opening a fresh session from the session card. */
export const SESSION_NEW = 'dsh:s:n'
/** Callback payloads for the quick-action row under `/status`. */
export const QUICK_SESSIONS = 'dsh:s:l'
export const QUICK_MODEL = 'dsh:m:o'
/** The three quick actions every status reply carries. */
export const QUICK_ACTIONS: CardKeyboard = [[
  { text: '会话', callback_data: QUICK_SESSIONS },
  { text: '模型', callback_data: QUICK_MODEL },
  { text: '新建', callback_data: SESSION_NEW },
]]

/**
 * Build the live-session card.
 * @param sessions - live root sessions in list order.
 * @param selectedId - the chat's selected session, marked in the text.
 * @returns the session card.
 */
export function sessionCard(
  sessions: readonly { readonly id: string; readonly title: string; readonly status: string }[],
  selectedId: string | undefined,
): Card {
  const rows = sessions.map((session, index) => [{
    text: `${session.id === selectedId ? '✅ ' : ''}${label(session.title)}`,
    callback_data: `dsh:s:${index}`,
  }])
  rows.push([{ text: '＋ 新会话', callback_data: SESSION_NEW }])
  return {
    text: [`会话（${sessions.length}）：`, '点一下切换；✅ 是当前会话。'].join('\n'),
    keyboard: rows,
  }
}
