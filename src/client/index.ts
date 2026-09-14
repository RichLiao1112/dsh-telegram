/**
 * Browser half of the Telegram plugin: the settings card for the `telegram`
 * namespace the Host plugin registers.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from './contract.ts'
import { TelegramCard } from './TelegramCard.tsx'
import { TELEGRAM_NS, TelegramCardController, type TelegramSettings } from './form.ts'
import { en, zh } from './locales.ts'
import { styleText } from './styles.ts'

/** Locale namespace this card's copy lives in. */
export const LOCALE_NS = 'telegram.settings'

/** Client services this plugin contributes through. */
export const inject = ['slots', 'locale', 'settingsScope']

/**
 * Register the Telegram settings card.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(LOCALE_NS, { en, zh }), 'telegram: settings dictionaries')
  ctx.effect(() => {
    if (typeof document === 'undefined') return () => {}
    const selector = 'style[data-plugin-css="@richliao1112/dsh-telegram/settings-card"]'
    if (document.querySelector(selector) !== null) return () => {}
    const tag = document.createElement('style')
    tag.dataset.plugin = '@richliao1112/dsh-telegram'
    tag.dataset.pluginCss = 'settings-card'
    tag.textContent = styleText
    document.head.append(tag)
    return () => { tag.remove() }
  }, 'telegram: settings card styles')
  const t = ctx.locale.bind(LOCALE_NS)
  const controller = new TelegramCardController(ctx.settingsScope.bind<TelegramSettings>({ namespace: TELEGRAM_NS }))
  ctx.effect(() => () => { controller.dispose() }, 'telegram: settings card state')
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: TELEGRAM_NS,
    locale: LOCALE_NS,
    inject: () => controller.inject(t),
  }, TelegramCard))
}
