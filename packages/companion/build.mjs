import { copyFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const packageRoot = fileURLToPath(new URL('.', import.meta.url))
await rm(new URL('dist/', import.meta.url), { recursive: true, force: true })
await build({
  absWorkingDir: packageRoot,
  entryPoints: ['src/plugin.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  outfile: 'dist/plugin.cjs',
})
await copyFile(new URL('src/plugin-api.d.ts', import.meta.url), new URL('dist/plugin.d.ts', import.meta.url))
