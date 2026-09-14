/**
 * Declarations this card contributes to the browser client's slot and locale
 * maps. The `settings.plugin.item` slot itself is declared by the plugin
 * configuration package — importing its client entry brings that declaration
 * in, because keying the card on its own settings namespace is exactly the
 * extension point that lets a plugin outside the harness repository ship one.
 */

import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type { TelegramLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy owned by the Telegram plugin's settings card. */
    'telegram.settings': TelegramLocaleKey
  }
}
