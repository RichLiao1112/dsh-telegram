/** Telegram plugin configuration card. */

import { useEffect, useRef, useState } from 'react'
import { Button, IconChevronDownOutline14, Input, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
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
 * Render settings stored by the Telegram Host plugin. The header follows the
 * same disclosure contract as Shell and Agent Loop: cards start collapsed,
 * unsaved drafts survive collapsing, and a confirmed save closes the card.
 * @param props - card copy, staged state, and its edit actions.
 * @returns the settings card.
 */
export function TelegramCard(props: TelegramCardProps) {
  const state = props.useTelegramCard(snapshot => snapshot)
  const [open, setOpen] = useState(false)
  const saveStarted = useRef(false)
  const { t } = props
  useEffect(() => {
    if (state.saving) {
      saveStarted.current = true
      return
    }
    if (!saveStarted.current) return
    saveStarted.current = false
    if (!state.dirty && !state.failed) setOpen(false)
  }, [state.dirty, state.failed, state.saving])
  if (!state.available) return null
  const disabled = !state.writable
  const blocked = disabled || !state.dirty || state.saving
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
    <li style={{ borderBottom: '1px solid var(--dsw-border, rgba(127, 127, 127, 0.22))' }}>
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${t(open ? 'collapse' : 'expand')}: ${t('title')}`}
        onClick={() => { setOpen(!open) }}
        style={{
          display: 'flex', width: '100%', alignItems: 'center', gap: 10,
          padding: '12px 0', border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', textAlign: 'left',
        }}
      >
        <span style={{ display: 'grid', gap: 2, flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>{t('title')}</span>
          <span style={{ fontSize: 13, opacity: 0.72 }}>{t('description')}</span>
        </span>
        {state.dirty ? <Tag tone="neutral">{t('unsaved')}</Tag> : null}
        <span style={{ display: 'inline-flex', transform: open ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 150ms ease' }}>
          <IconChevronDownOutline14 />
        </span>
      </button>
      {open
        ? (
          <div style={{ padding: '4px 0 16px' }}>
            {!state.writable ? <p role="status" style={{ fontSize: 13, opacity: 0.72 }}>{t('readOnly')}</p> : null}
            {field('token', 'token', 'tokenHint')}
            {field('chatId', 'chatId', 'chatIdHint')}
            {field('workspacePath', 'workspacePath', 'workspacePathHint')}
            {field('agentPreset', 'agentPreset', 'agentPresetHint')}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Button variant="ghost" disabled={!state.dirty || state.saving} onClick={props.discard}>{t('discard')}</Button>
              <Button variant="primary" disabled={blocked} onClick={props.save}>
                {state.saving ? t('saving') : t('save')}
              </Button>
              {state.failed ? <Tag tone="danger">{t('saveFailed')}</Tag> : null}
            </div>
          </div>
        )
        : null}
    </li>
  )
}
