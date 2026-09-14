/** CSS classes and browser-injected stylesheet for the Telegram settings card. */

/** Stable class names isolate this plugin's card from the shell's CSS modules. */
export const css = {
  card: 'dshTelegramCard',
  cardOpen: 'dshTelegramCardOpen',
  header: 'dshTelegramCardHeader',
  headText: 'dshTelegramCardHeadText',
  name: 'dshTelegramCardName',
  description: 'dshTelegramCardDescription',
  chevron: 'dshTelegramCardChevron',
  chevronOpen: 'dshTelegramCardChevronOpen',
  body: 'dshTelegramCardBody',
  readOnly: 'dshTelegramCardReadOnly',
  pending: 'dshTelegramCardPending',
  field: 'dshTelegramCardField',
  fieldHead: 'dshTelegramCardFieldHead',
  label: 'dshTelegramCardLabel',
  badges: 'dshTelegramCardBadges',
  reset: 'dshTelegramCardReset',
  input: 'dshTelegramCardInput',
  hint: 'dshTelegramCardHint',
  footer: 'dshTelegramCardFooter',
  failed: 'dshTelegramCardFailed',
  discard: 'dshTelegramCardDiscard',
  save: 'dshTelegramCardSave',
} as const

/**
 * Visual contract copied from DSH's Shell and Agent Loop `PluginCard` and
 * `ValueField`: card geometry, disclosure header, form rows, and footer use
 * the same semantic tokens without importing another feature plugin's private
 * runtime values.
 */
export const styleText = `
.${css.card}{list-style:none;border:.5px solid var(--dsw-alias-border-l4);border-radius:16px;background:var(--dsw-alias-bg-layer-3);transition:border-color .16s,background .16s}
.${css.card}:hover{border-color:var(--dsw-alias-label-dimmed)}
.${css.cardOpen}{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.${css.header}{width:100%;appearance:none;border:0;background:none;font:inherit;color:inherit;text-align:left;cursor:pointer;display:flex;align-items:center;gap:12px;padding:14px 16px;border-radius:12px}
.${css.header}:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.${css.headText}{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}
.${css.name}{font-size:15px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary)}
.${css.description}{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.${css.chevron}{flex:none;color:var(--dsw-alias-label-tertiary);transition:transform .16s}
.${css.chevronOpen}{transform:rotate(180deg)}
.${css.body}{border-top:.5px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}
.${css.readOnly}{margin:12px 0 0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.${css.pending}{flex:none}
.${css.field}{display:flex;flex-direction:column;gap:6px;padding:12px 0}
.${css.field}+.${css.field}{border-top:.5px solid var(--dsw-alias-border-l2)}
.${css.fieldHead}{display:flex;align-items:center;gap:8px}
.${css.label}{flex:1;min-width:0;font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}
.${css.badges}{display:inline-flex;align-items:center;gap:8px}
.${css.reset}{border:none;background:none;padding:0;font:inherit;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);cursor:pointer}
.${css.reset}:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.${css.reset}:disabled{cursor:default}
.${css.input}{height:34px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;background:var(--dsw-alias-bg-layer-3);font:inherit;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary)}
.${css.input}:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary)}
.${css.input}:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
.${css.hint}{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.${css.footer}{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:12px 0 4px;border-top:.5px solid var(--dsw-alias-border-l2)}
.${css.failed}{flex:1;min-width:0;margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-error)}
.${css.discard},.${css.save}{appearance:none;border:1px solid transparent;border-radius:8px;padding:5px 14px;font:inherit;font-size:13px;line-height:1.5;cursor:pointer}
.${css.discard}{border-color:var(--dsw-alias-border-l2);background:none;color:var(--dsw-alias-label-secondary)}
.${css.discard}:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.${css.save}{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.${css.discard}:disabled,.${css.save}:disabled{opacity:.4;cursor:default}
.${css.discard}:focus-visible,.${css.save}:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
`
