#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { main } from './pack-check-core.mjs'

const modulePath = fileURLToPath(import.meta.url)
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''

if (invokedPath === modulePath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
