/** Telegram plugin configuration card. */

import { Button, Input, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TelegramCardFace, TelegramCardState, TelegramField } from './form.ts'
import type { TelegramLocaleKey } from './locales.ts'

/** Props the settings slot provides for this card. */
export interface TelegramCardProps extends Omit<TelegramCardFace, 'hooks'> {
  /** Observable card state bound from the inject face's `hooks` compartment. */
  useTelegramCard: <S>(selector: (state: TelegramCardState) => S) => S
}

/** One labelled field row. */
function Field(props: {
  readonly id: string
  readonly label: string
  readonly hint: string
  readonly state: { text: string; overridden: boolean }
  readonly disabled: boolean
  readonly t: (key: TelegramLocaleKey) => string
  readonly onEdit: (text: string) => void
  readonly onReset: () => void
}) {
  return (
    <div style={{ display: 'grid', gap: 4, marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <label htmlFor={props.id} style={{ fontSize: 13, fontWeight: 600 }}>{props.label}</label>
        {props.state.overridden
          ? (
            <>
              <Tag tone="neutral">{props.t('overridden')}</Tag>
              <Button variant="ghost" disabled={props.disabled} onClick={props.onReset}>{props.t('reset')}</Button>
            </>
          )
          : null}
      </div>
      <Input id={props.id} value={props.state.text} disabled={props.disabled} onChange={event => { props.onEdit(event.target.value) }} />
      <span style={{ fontSize: 12, opacity: 0.7 }}>{props.hint}</span>
    </div>
  )
}

/**
 * Render settings stored by the Telegram Host plugin.
 * @param props - card copy, staged state, and its edit actions.
 * @returns the settings card.
 */
export function TelegramCard(props: TelegramCardProps) {
  const state = props.useTelegramCard(snapshot => snapshot)
  const { t } = props
  const disabled = !state.writable
  if (!state.available) return <p style={{ fontSize: 13, opacity: 0.7 }}>{t('unavailable')}</p>
  const field = (key: TelegramField, label: TelegramLocaleKey, hint: TelegramLocaleKey) => (
    <Field
      id={`plugin-config-telegram-${key}`}
      label={t(label)}
      hint={t(hint)}
      state={state[key]}
      disabled={disabled}
      t={t}
      onEdit={text => { props.edit(key, text) }}
      onReset={() => { props.resetField(key) }}
    />
  )
  return (
    <section style={{ padding: '12px 0' }}>
      <h3 style={{ margin: '0 0 4px', fontSize: 15 }}>{t('title')}</h3>
      <p style={{ margin: '0 0 12px', fontSize: 13, opacity: 0.75 }}>{t('description')}</p>
      {field('token', 'token', 'tokenHint')}
      {field('chatId', 'chatId', 'chatIdHint')}
      {field('workspacePath', 'workspacePath', 'workspacePathHint')}
      {field('agentPreset', 'agentPreset', 'agentPresetHint')}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Button variant="primary" disabled={disabled || !state.dirty || state.saving} onClick={props.save}>
          {state.saving ? t('saving') : t('save')}
        </Button>
        <Button variant="ghost" disabled={!state.dirty || state.saving} onClick={props.discard}>{t('discard')}</Button>
        {state.failed ? <Tag tone="danger">{t('saveFailed')}</Tag> : null}
      </div>
    </section>
  )
}
