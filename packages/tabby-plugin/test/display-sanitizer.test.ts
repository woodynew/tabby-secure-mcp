import { describe, expect, it } from 'vitest'

import { sanitizeApprovalDisplayText } from '../src/approval/display-sanitizer'

describe('sanitizeApprovalDisplayText', () => {
  it('escapes ANSI, CR/LF/tab, C0/C1, bidi, zero-width, and other control characters visibly', () => {
    const input = [
      '\u001b[31mred\u001b[0m',
      '\r\n\t',
      '\u007f',
      '\u0080',
      '\u202eRTL',
      '\u200bzw',
      '\u0000',
    ].join('')

    const sanitized = sanitizeApprovalDisplayText(input)

    expect(sanitized).not.toContain('\u001b')
    expect(sanitized).not.toContain('\r')
    expect(sanitized).not.toContain('\n')
    expect(sanitized).not.toContain('\t')
    expect(sanitized).not.toContain('\u0000')
    expect(sanitized).not.toContain('\u202e')
    expect(sanitized).not.toContain('\u200b')
    expect(sanitized).toMatch(/\\u001b/i)
    expect(sanitized).toMatch(/\\r|\\n|\\t/)
    expect(sanitized).toMatch(/\\u202e/i)
    expect(sanitized).toMatch(/\\u200b/i)
  })

  it('leaves ordinary text unchanged', () => {
    expect(sanitizeApprovalDisplayText('client-1 / open_authorized_ssh_profile')).toBe(
      'client-1 / open_authorized_ssh_profile',
    )
  })
})
