import { defineConfig } from 'tsdown'

/**
 * The published artifact is the bundle the DSH loader imports: `tsc` emits
 * JavaScript to `lib/types`, and tsdown inlines the relative modules into the
 * single `lib/index.js` entry that the profile row names.
 */
export default defineConfig({
  entry: ['lib/types/index.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
