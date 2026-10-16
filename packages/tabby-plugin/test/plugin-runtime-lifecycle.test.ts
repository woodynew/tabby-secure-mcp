import { describe, expect, it, vi } from 'vitest'

import { PluginRuntimeLifecycle } from '../src/runtime/plugin-runtime-lifecycle'
import type { PluginRuntimeService } from '../src/runtime/plugin-runtime-service'

describe('PluginRuntimeLifecycle', () => {
  it('starts runtime on construction and destroys on ngOnDestroy', () => {
    const runtime = {
      start: vi.fn(),
      destroy: vi.fn(),
    } satisfies Pick<PluginRuntimeService, 'start' | 'destroy'>

    const lifecycle = new PluginRuntimeLifecycle(runtime as PluginRuntimeService)
    expect(runtime.start).toHaveBeenCalledTimes(1)

    lifecycle.ngOnDestroy()
    expect(runtime.destroy).toHaveBeenCalledTimes(1)
  })
})
