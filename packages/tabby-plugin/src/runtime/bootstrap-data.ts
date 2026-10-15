export interface BootstrapData {
  isMainWindow: boolean
  windowID: string
}

export type BootstrapDataSource = () => BootstrapData

export function readTabbyBootstrapData(): BootstrapData {
  const globalScope = globalThis as { BOOTSTRAP_DATA?: BootstrapData }
  const data = globalScope.BOOTSTRAP_DATA
  if (!data || typeof data.isMainWindow !== 'boolean' || typeof data.windowID !== 'string') {
    return { isMainWindow: true, windowID: 'unknown-window' }
  }
  return data
}
