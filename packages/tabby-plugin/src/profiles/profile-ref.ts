const PROFILE_REF_PATTERN = /^[0-9a-f]{32}$/

export function generateProfileRef(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

export function isProfileRef(value: string): boolean {
  return PROFILE_REF_PATTERN.test(value)
}
