import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: ['test/**/*.integration.test.ts'],
    include: ['test/**/*.test.ts'],
    passWithNoTests: true,
  },
})
