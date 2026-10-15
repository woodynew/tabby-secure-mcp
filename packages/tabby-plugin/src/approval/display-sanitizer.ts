const C0_C1_CONTROL =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ufeff\u200b-\u200f\u2028\u2029]/g
const ANSI_ESCAPE = /\u001b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g

function escapeChar(char: string): string {
  const code = char.codePointAt(0)
  if (code === undefined) {
    return ''
  }
  if (code === 0x09) {
    return '\\t'
  }
  if (code === 0x0a) {
    return '\\n'
  }
  if (code === 0x0d) {
    return '\\r'
  }
  return `\\u${code.toString(16).padStart(4, '0')}`
}

export function sanitizeApprovalDisplayText(value: string): string {
  const withoutAnsi = value.replace(ANSI_ESCAPE, sequence => {
    return sequence
      .split('')
      .map(char => escapeChar(char))
      .join('')
  })
  const withoutWhitespaceControls = withoutAnsi
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
  return withoutWhitespaceControls.replace(C0_C1_CONTROL, match => escapeChar(match))
}
