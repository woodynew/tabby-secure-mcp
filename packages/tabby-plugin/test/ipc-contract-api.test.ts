import { describe, expect, it } from 'vitest'

import { encodeFrame } from '../src/runtime/ipc-contract-api'

describe('ipc-contract-api', () => {
  it('loads bundled contract helpers', () => {
    const frame = encodeFrame({
      v: 1,
      seq: 1,
      type: 'plugin_hello',
      window_instance_id: 'window-instance-1',
      is_main_window: true,
      plugin_challenge: 'abc',
    })
    expect(frame.byteLength).toBeGreaterThan(4)
  })
})
