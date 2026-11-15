import { describe, expect, it, vi } from 'vitest'
vi.mock('@tabby-secure-mcp/companion', () => ({ APPROVAL_WINDOW_MS: 60_000, CredentialStore: class {}, EmbeddedMcpServer: class {} }))
import { SecureMcpSettingsComponent } from '../src/settings/secure-mcp-settings.component'
import { CredentialStore } from '../../companion/src/http/credentials'
import { PermanentAuthorizationStore } from '../src/authorization/permanent-authorization-store'
import { stableProfileDigest } from '../src/approval/profile-security-snapshot'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

describe('named MCP credentials in settings', () => {
  it('preauthorizes an offline client for a profile without changing command tiers or its neighbor', async () => {
    const dir = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), 'client-settings-'))
    try {
      const credentials = new CredentialStore(path.join(dir, 'private', 'credentials.json'))
      await credentials.load()
      const a = await credentials.create('Agent'), b = await credentials.create('Agent')
      const profile = { id: 'p', type: 'ssh', name: 'SSH', options: { host: 'test.invalid' }, isBuiltin: false, isTemplate: false }
      const changes = new Set<() => void>()
      const config = { store: { profiles: [profile], secureMcp: { authorizedSshProfileIds: ['p'], permanentAuthorizations: [] } }, save: async () => {},
        changed$: { subscribe(listener: () => void) { changes.add(listener); return { unsubscribe: () => changes.delete(listener) } } } }
      const profiles = { getProfiles: async () => [profile], getConfigProxyForProfile: (p: any) => p }
      const memory = new PermanentAuthorizationStore(config as never)
      const component = new SecureMcpSettingsComponent(config as never, profiles as never, memory, { credentials, isMainWindow: true, onChange: () => () => {}, serverConfig: () => ({ port: 50333 }) } as never)
      await component.ngOnInit()
      const row = component.rows[0]!
      expect(component.clientConnectionState(a, row)).toBe('ask')
      await component.onChangeClientConnection(a, row, 'allowed')
      expect(component.clientConnectionState(a, row)).toBe('allowed')
      expect(component.clientConnectionState(b, row)).toBe('ask')
      expect(memory.effectiveGrant('p', stableProfileDigest(profile)).operationTier).toBe('none')
      profile.options.host = 'changed.invalid'
      for (const changed of changes) changed()
      await vi.waitFor(() => expect(component.clientConnectionState(a, row)).toBe('stale'))
      await component.onChangeClientConnection(a, row, 'allowed')
      expect(component.clientConnectionState(a, row)).toBe('allowed')
      await component.onChangeClientConnection(a, row, 'ask')
      expect(component.clientConnectionState(a, row)).toBe('ask')
      await component.onChangeClientConnection(a, row, 'invalid')
      expect(component.clientConnectionState(a, row)).toBe('ask')
      component.ngOnDestroy()
      expect(changes.size).toBe(0)
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })
  it('applies a client permission choice without rotating its credential and explains reconnect behavior', async () => {
    const credentials = { setPermission: vi.fn(async () => {}) }
    const runtime = { credentials, isMainWindow: true }
    const component = new SecureMcpSettingsComponent({} as never, {} as never, {} as never, runtime as never)
    await component.onChangeClientPermission('id', 2, 'session')
    expect(credentials.setPermission).toHaveBeenCalledWith('id', 2, 'session')
    expect(component.notice).toContain('next connection')
    expect(component.notice).toContain('unchanged')
    await component.onChangeClientPermission('id', 3, 'untrusted')
    expect(credentials.setPermission).toHaveBeenCalledTimes(1)
  })
  it('finishes native async credential saves inside Angular change detection', async () => {
    const runtime = { credentials: { create: vi.fn(async () => ({})) }, isMainWindow: true }
    let component: SecureMcpSettingsComponent
    const zone = { run: vi.fn((work: () => void) => { work(); expect(component.saving).toBe(false) }) }
    component = new SecureMcpSettingsComponent({} as never, {} as never, {} as never, runtime as never, zone as never)
    component.clientName = 'Named client'
    await component.onCreateClient()
    expect(zone.run).toHaveBeenCalledOnce()
  })
  it('creates and renames credentials and copies generic authenticated HTTP configuration', async () => {
    const credentials = { create: vi.fn(async () => ({})), rename: vi.fn(async () => {}), tokenFor: () => 'private-client-token', list: () => [] }
    const runtime = { credentials, isMainWindow: true, onChange: () => () => {}, serverConfig: () => ({ enabled: true, port: 50333 }) }
    const component = new SecureMcpSettingsComponent({} as never, {} as never, {} as never, runtime as never)
    component.clientName = 'My AI agent'
    await component.onCreateClient()
    expect(credentials.create).toHaveBeenCalledWith('My AI agent')
    await component.onRenameClient('id', 'Office agent')
    expect(credentials.rename).toHaveBeenCalledWith('id', 'Office agent')
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    await component.onCopyClient('id')
    const copied = JSON.parse(writeText.mock.calls[0]![0])
    expect(copied.mcpServers['tabby-secure-mcp']).toEqual({ url: 'http://127.0.0.1:50333/mcp', headers: { Authorization: 'Bearer private-client-token' } })
    expect(component.error).toBeNull()
    vi.unstubAllGlobals()
  })
  it('does not allow a secondary window to create credentials or edit profile grants', async () => {
    const create = vi.fn()
    const save = vi.fn()
    const runtime = { credentials: { create }, isMainWindow: false }
    const component = new SecureMcpSettingsComponent({ save } as never, {} as never, {} as never, runtime as never)
    component.clientName = 'Blocked'
    await component.onCreateClient()
    await component.onToggle({ id: 'id', selected: false } as never, true)
    expect(create).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
  })
})
