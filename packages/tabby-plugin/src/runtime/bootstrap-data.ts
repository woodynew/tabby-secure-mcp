import type { BootstrapData } from 'tabby-core'

export interface NormalizedWindowBootstrap {
  isMainWindow: boolean
  windowId: string
}

export type WindowBootstrapSource = () => NormalizedWindowBootstrap

export function normalizeWindowBootstrap(
  data: BootstrapData | null | undefined,
): NormalizedWindowBootstrap {
  if (!data || typeof data.isMainWindow !== 'boolean') {
    return { isMainWindow: false, windowId: '0' }
  }
  const rawId = data.windowID
  if (typeof rawId !== 'number' || !Number.isFinite(rawId)) {
    return { isMainWindow: false, windowId: '0' }
  }
  return {
    isMainWindow: data.isMainWindow === true,
    windowId: String(Math.trunc(rawId)),
  }
}
