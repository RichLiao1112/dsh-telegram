/**
 * Staged form over the Host `telegram` settings namespace.
 *
 * A card stages what the user types and writes only on save: each settings
 * write is a durable document mutation, so committing per keystroke would store
 * edits the user never confirmed. A field shows its effective value and whether
 * the user layer carries it — presence, not a value comparison, is what marks a
 * field overridden.
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { TelegramLocaleKey } from './locales.ts'

/** Namespace served by the Telegram Host plugin. */
export const TELEGRAM_NS = 'telegram'

/** Settings fields the card writes. */
export interface TelegramSettings {
  token?: string
  chatId?: string
  workspacePath?: string
  agentPreset?: string
}

/** One field as the card renders it. */
export interface TelegramFieldState {
  /** Draft text the control shows. */
  text: string
  /** Whether saving would leave a user-layer entry for this field. */
  overridden: boolean
}

/** Render state of the Telegram settings card. */
export interface TelegramCardState {
  /** False while the namespace is not served to this client. */
  available: boolean
  /** Whether the Host document accepts writes. */
  writable: boolean
  /** Whether the form holds edits a save would write. */
  dirty: boolean
  /** Whether a save is crossing the wire. */
  saving: boolean
  /** Whether the last save did not land as staged. */
  failed: boolean
  token: TelegramFieldState
  chatId: TelegramFieldState
  workspacePath: TelegramFieldState
  agentPreset: TelegramFieldState
}

/** Controls and observable state the card's slot entry injects. */
export interface TelegramCardFace {
  /** Translate one card string. */
  t: (key: TelegramLocaleKey) => string
  hooks: { telegramCard: SnapshotStore<TelegramCardState> }
  edit: (field: TelegramField, text: string) => void
  resetField: (field: TelegramField) => void
  save: () => void
  discard: () => void
}

/** Fields the card edits. */
export type TelegramField = 'token' | 'chatId' | 'workspacePath' | 'agentPreset'

/** Every field in render order. */
const FIELDS: readonly TelegramField[] = ['token', 'chatId', 'workspacePath', 'agentPreset']

/** Whether the stored user layer carries this field. */
function carries(user: unknown, field: string): boolean {
  return typeof user === 'object' && user !== null && field in user
}

/** Read one stored string field. */
function textOf(value: unknown, field: string): string {
  if (typeof value !== 'object' || value === null) return ''
  const raw = (value as Record<string, unknown>)[field]
  return typeof raw === 'string' ? raw : ''
}

/** Binds the served Telegram namespace to a staged settings form. */
export class TelegramCardController {
  /** Current render state. */
  readonly store: SnapshotStore<TelegramCardState>

  /** Draft text per field; absent while the field mirrors the Host value. */
  private readonly drafts = new Map<TelegramField, string | undefined>()
  private readonly unsubscribe: () => void
  private saving = false
  private failed = false
  private disposed = false

  /** @param scope - the bound `telegram` namespace of this client's settings document. */
  constructor(private readonly scope: SettingsScope<TelegramSettings>) {
    this.store = createSnapshotStore(this.derive())
    this.unsubscribe = scope.subscribe(() => { this.publish() })
  }

  /** Disposers for the plugin fiber. */
  dispose(): void {
    this.disposed = true
    this.unsubscribe()
  }

  /**
   * Build the slot entry's injected face.
   * @param t - translate bound to this card's locale namespace.
   * @returns the card's controls and observable state.
   */
  inject(t: (key: TelegramLocaleKey) => string): TelegramCardFace {
    return {
      t,
      hooks: { telegramCard: this.store },
      edit: (field, text) => {
        this.drafts.set(field, text)
        this.failed = false
        this.publish()
      },
      resetField: (field) => {
        this.drafts.set(field, undefined)
        this.failed = false
        this.publish()
      },
      save: () => { void this.save() },
      discard: () => {
        this.drafts.clear()
        this.failed = false
        this.publish()
      },
    }
  }

  /** Write every staged edit, then re-seed from what the Host accepted. */
  private async save(): Promise<void> {
    if (this.saving) return
    this.saving = true
    this.publish()
    const staged = [...this.drafts]
    let accepted = true
    for (const [field, draft] of staged) {
      try {
        if (draft === undefined) await this.scope.unset(field)
        else await this.scope.set(field, draft)
      } catch {
        accepted = false
      }
    }
    if (accepted) this.drafts.clear()
    this.saving = false
    this.failed = !accepted
    this.publish()
  }

  /** Recompute the published state from the scope snapshot and the drafts. */
  private publish(): void {
    if (this.disposed) return
    this.store.set(this.derive())
  }

  /** Derive the render state. */
  private derive(): TelegramCardState {
    const snapshot = this.scope.getSnapshot()
    const value = snapshot.value
    const fields = {} as Record<TelegramField, TelegramFieldState>
    for (const field of FIELDS) {
      const draft = this.drafts.get(field)
      fields[field] = {
        text: this.drafts.has(field) ? draft ?? '' : textOf(value, field),
        overridden: this.drafts.has(field) ? draft !== undefined : carries(snapshot.user, field),
      }
    }
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      dirty: this.drafts.size > 0,
      saving: this.saving,
      failed: this.failed,
      ...fields,
    }
  }
}
