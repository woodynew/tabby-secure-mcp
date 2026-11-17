import { describe, expect, it } from 'vitest'
import { SETTINGS_OPERATION_TIER_OPTIONS } from '../src/settings/secure-mcp-settings.view-model'

describe('settings approval modes', () => {
  it('offers disabled execution and the three approval modes without old tier values', () => {
    expect(SETTINGS_OPERATION_TIER_OPTIONS.map(option => option.value)).toEqual(['none', 'ask', 'auto_edit', 'full'])
    expect(SETTINGS_OPERATION_TIER_OPTIONS.map(option => option.labelKey)).toEqual([
      'secureMcp.commandDisabled', 'secureMcp.modeAsk', 'secureMcp.modeAutoEdit', 'secureMcp.modeFull',
    ])
  })
})
