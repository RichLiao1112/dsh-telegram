import { defineConfig } from 'tsdown'

/** Module-table specifiers the browser shell seeds for every client bundle. */
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

/**
 * Host half: `tsc` emits JavaScript to `lib/types`, and tsdown inlines the
 * relative modules into the single `lib/index.js` the profile row imports.
 */
const host = {
  name: 'host',
  entry: ['lib/types/index.js'],
  outDir: 'lib',
  format: ['esm'] as const,
  platform: 'node' as const,
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
}

/**
 * Browser half: the dynamic plugin bundle the modules node half serves through
 * `exports["./client"]`. It is CommonJS inside the loader's closure factory, so
 * every platform module resolves through the injected `require` and everything
 * else inlines.
 */
const client = {
  name: 'client',
  entry: { client: 'lib/types/client/index.js' },
  outDir: 'lib',
  format: 'cjs' as const,
  platform: 'browser' as const,
  // Pin the artifact name: the package export and the loader both address
  // `lib/client.js`, while tsdown would otherwise emit `client.cjs` for an
  // ESM-typed package.
  outExtensions: () => ({ js: '.js' }),
  target: 'es2022',
  dts: false,
  clean: false,
  sourcemap: true,
  deps: {
    neverBundle: (specifier: string) => PLATFORM_MODULES.includes(specifier),
    alwaysBundle: (specifier: string) => !PLATFORM_MODULES.includes(specifier),
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  outputOptions: {
    banner: 'window.__ModuleLoader__.load({ id: "@richliao1112/dsh-telegram", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default defineConfig([host, client])
