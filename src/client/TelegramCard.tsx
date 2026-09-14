/** Telegram plugin configuration card. */

import { useEffect, useRef, useState } from 'react'
import { IconChevronDownOutline14, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TelegramCardFace, TelegramCardState, TelegramField } from './form.ts'
import type { TelegramLocaleKey } from './locales.ts'
import { css } from './styles.ts'

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
    <div className={css.field}>
      <div className={css.fieldHead}>
        <label className={css.label} htmlFor={props.id}>{props.label}</label>
        {props.state.overridden
          ? (
            <span className={css.badges}>
              <Tag tone="neutral">{props.t('overridden')}</Tag>
              <button type="button" className={css.reset} disabled={props.disabled} onClick={props.onReset}>{props.t('reset')}</button>
            </span>
          )
          : null}
      </div>
      <input className={css.input} id={props.id} value={props.state.text} disabled={props.disabled} onChange={event => { props.onEdit(event.target.value) }} />
      <p className={css.hint}>{props.hint}</p>
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
    <li className={`${css.card}${open ? ` ${css.cardOpen}` : ''}`}>
      <button
        type="button"
        className={css.header}
        aria-expanded={open}
        aria-label={`${t(open ? 'collapse' : 'expand')}: ${t('title')}`}
        onClick={() => { setOpen(!open) }}
      >
        <span className={css.headText}>
          <span className={css.name}>{t('title')}</span>
          <span className={css.description}>{t('description')}</span>
        </span>
        {state.dirty ? <Tag tone="neutral" className={css.pending}>{t('unsaved')}</Tag> : null}
        <IconChevronDownOutline14 className={`${css.chevron}${open ? ` ${css.chevronOpen}` : ''}`} />
      </button>
      {open
        ? (
          <div className={css.body}>
            {!state.writable ? <p className={css.readOnly} role="status">{t('readOnly')}</p> : null}
            {field('token', 'token', 'tokenHint')}
            {field('chatId', 'chatId', 'chatIdHint')}
            {field('workspacePath', 'workspacePath', 'workspacePathHint')}
            {field('agentPreset', 'agentPreset', 'agentPresetHint')}
            <div className={css.footer}>
              {state.failed ? <p className={css.failed} role="status">{t('saveFailed')}</p> : null}
              <button type="button" className={css.discard} disabled={!state.dirty || state.saving} onClick={props.discard}>{t('discard')}</button>
              <button type="button" className={css.save} disabled={blocked} onClick={props.save}>{t(state.saving ? 'saving' : 'save')}</button>
            </div>
          </div>
        )
        : null}
    </li>
  )
}
