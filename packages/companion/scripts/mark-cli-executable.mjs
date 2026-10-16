import { chmod } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
await chmod(path.join(packageRoot, 'dist', 'cli.js'), 0o755)
