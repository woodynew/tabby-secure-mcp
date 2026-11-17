import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tabby-secure-mcp/companion', () => ({ APPROVAL_WINDOW_MS: 60_000, CredentialStore: class {}, EmbeddedMcpServer: class {} }))
vi.mock('../src/runtime/plugin-http-runtime', () => ({ PluginHttpRuntime: class {} }))
import { PermanentAuthorizationStore } from '../src/authorization/permanent-authorization-store'
import { stableProfileDigest } from '../src/approval/profile-security-snapshot'
import { SecureMcpSettingsComponent } from '../src/settings/secure-mcp-settings.component'
import { commandRuleFromText } from '@tabby-secure-mcp/ipc-contract/command-policy'

const directories: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function harness(zone?: { run: (work: () => void) => void }) {
  const { CredentialStore } = await import('../../companion/src/http/credentials')
  const dir = await mkdtemp(path.join(await realpath(tmpdir()), 'command-editor-'))
  directories.push(dir)
  const credentials = new CredentialStore(path.join(dir, 'private', 'credentials.json'))
  await credentials.load()
  const client = await credentials.create('Same name')
  const neighbor = await credentials.create('Same name')
  const profile = { id: 'ssh-1', type: 'ssh', name: 'SSH', options: { host: 'test.invalid' }, isBuiltin: false, isTemplate: false }
  const configListeners = new Set<() => void>()
  const config = { store: { profiles: [profile], secureMcp: { authorizedSshProfileIds: ['ssh-1'], permanentAuthorizations: [] } }, save: async () => {},
    changed$: { subscribe(listener: () => void) { configListeners.add(listener); return { unsubscribe: () => configListeners.delete(listener) } } } }
  const profiles = { getProfiles: vi.fn(async () => structuredClone([profile])), getConfigProxyForProfile: (p: any) => p }
  let runtimeChanged = () => {}
  const runtime = { credentials, isMainWindow: true, onChange: (listener: () => void) => { runtimeChanged = listener; return () => {} }, serverConfig: () => ({ port: 50333 }) }
  const component = new SecureMcpSettingsComponent(config as never, profiles as never, new PermanentAuthorizationStore(config as never), runtime as never, zone as never)
  await component.ngOnInit()
  return { component, credentials, client, neighbor, profile, profiles, config, runtime,
    runtimeChanged: () => runtimeChanged(), configChanged: () => { for (const listener of configListeners) listener() } }
}

describe('command-set settings editor', () => {
  it('keeps file transfer default-off and grants it only for the selected client and SSH', async () => {
    const { component, credentials, client, neighbor, profile } = await harness()
    const row = component.rows[0]!
    expect(component.clientFileTransferEnabled(client, row)).toBe(false)
    await component.onChangeClientFileTransfer(client, row, true)
    expect(component.clientFileTransferEnabled(client, row)).toBe(true)
    expect(component.clientFileTransferEnabled(neighbor, row)).toBe(false)
    expect(credentials.commandSet(client, profile.id, stableProfileDigest(profile))).toMatchObject({ inheritDefaults: true, rules: [] })
    expect(component.rows[0]!.operationTier).toBe('none')
    await component.onChangeClientFileTransfer(client, row, false)
    expect(component.clientFileTransferEnabled(client, row)).toBe(false)
  })

  it('restores the file transfer checkbox when persistence or profile validation fails', async () => {
    const { component, credentials, client, profile } = await harness()
    const row = component.rows[0]!
    const checkbox = { checked: true } as HTMLInputElement
    vi.spyOn(credentials, 'setFileTransferPermission').mockRejectedValueOnce(new Error('disk full'))
    await component.onChangeClientFileTransfer(client, row, true, checkbox)
    expect(checkbox.checked).toBe(false)
    expect(component.error).toBe('secureMcp.errorSaveFileTransfer')
    profile.options.host = 'changed.invalid'
    checkbox.checked = true
    await component.onChangeClientFileTransfer(client, row, true, checkbox)
    expect(checkbox.checked).toBe(false)
    expect(credentials.hasFileTransferPermission(client, profile.id, stableProfileDigest(profile))).toBe(false)
  })

  it('copies only 128 local rules when another 128 are inherited', async () => {
    const { component, credentials, client, neighbor, profile } = await harness()
    const defaults = Array.from({ length: 128 }, (_, i) => commandRuleFromText('g ' + i, 'exact'))
    const local = Array.from({ length: 128 }, (_, i) => commandRuleFromText('l ' + i, 'exact'))
    await credentials.setDefaultCommandSet(defaults, credentials.commandRevision())
    await credentials.setCommandSet(client, profile.id, stableProfileDigest(profile), { inheritDefaults: true, rules: local }, credentials.commandRevision())
    const writeText = vi.fn(async (_text: string) => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    component.onOpenClientCommands(client, component.rows[0]!)
    await component.onCopyCommandSet()
    expect(writeText).toHaveBeenCalledOnce()
    const copied = writeText.mock.calls[0]![0]
    component.onCloseCommandEditor()
    component.onOpenClientCommands(neighbor, component.rows[0]!)
    component.commandEditor!.pasteText = copied
    component.onPreviewCommandImport()
    expect(component.commandEditor!.importPreview).toHaveLength(128)
    component.onApplyCommandImport('merge')
    expect(component.commandEditor!.error).toBeNull()
    expect(component.commandEditor!.rules).toEqual(local)
    expect(component.commandEditor!.inheritDefaults).toBe(true)
    expect(credentials.commandSet(neighbor, profile.id, stableProfileDigest(profile)).rules).toEqual([])
  })
  it('detaches its draft from the private store snapshot', () => {
    const rules = [{ kind: 'family', version: 1, argv: ['docker', 'ps'] }]
    const component = new SecureMcpSettingsComponent({} as never, {} as never, {} as never,
      { isMainWindow: true, credentials: { defaultCommandSet: () => ({ rules, revision: 7 }) } } as never)
    component.onOpenDefaultCommands()
    component.commandEditor!.rules.splice(0)
    expect(rules).toEqual([{ kind: 'family', version: 1, argv: ['docker', 'ps'] }])
  })
  it('opens initially empty global defaults and saves a human-readable family rule', async () => {
    const { component, credentials } = await harness()
    component.onOpenDefaultCommands()
    expect(component.commandEditor).toMatchObject({ scope: 'global', rules: [] })
    component.commandEditor!.ruleText = 'docker ps'
    component.onSaveCommandRule()
    expect(component.commandEditor!.rules).toEqual([{ kind: 'family', version: 1, argv: ['docker', 'ps'] }])
    expect(credentials.defaultCommandSet().rules).toEqual([])
    await component.onSaveCommandSet()
    expect(credentials.defaultCommandSet().rules).toEqual([{ kind: 'family', version: 1, argv: ['docker', 'ps'] }])
    expect(component.commandEditor).toBeNull()
  })

  it('retains an unsaved local draft across runtime refreshes and isolates identical client names', async () => {
    const { component, credentials, client, neighbor, profile, runtimeChanged } = await harness()
    component.onOpenClientCommands(client, component.rows[0]!)
    const draft = component.commandEditor!
    draft.ruleText = 'uci get openclash.config.en_mode'
    component.onSaveCommandRule()
    runtimeChanged()
    await component.reload(true)
    expect(component.commandEditor).toBe(draft)
    await component.onSaveCommandSet()
    const snapshot = credentials.commandSet(client, 'ssh-1', stableProfileDigest(profile))
    expect(snapshot.rules).toEqual([{ kind: 'family', version: 1, argv: ['uci', 'get'] }])
    expect(credentials.commandSet(neighbor, 'ssh-1', snapshot.profileDigest).rules).toEqual([])
  })

  it('edits and removes family rules without widening duplicate entries', async () => {
    const { component } = await harness()
    component.onOpenDefaultCommands()
    const draft = component.commandEditor!
    draft.ruleText = 'docker ps'
    component.onSaveCommandRule()
    draft.ruleText = 'docker ps --all'
    component.onSaveCommandRule()
    expect(draft.rules).toHaveLength(1)
    component.onEditCommandRule(0)
    expect(draft.ruleText).toBe('docker ps')
    draft.ruleText = 'uci get example.key'
    component.onSaveCommandRule()
    expect(draft.rules).toEqual([{ kind: 'family', version: 1, argv: ['uci', 'get'] }])
    component.onDeleteCommandRule(0)
    expect(draft.rules).toEqual([])
  })

  it('separates command text and fingerprints from localized matching-scope labels', async () => {
    const { component } = await harness()
    component.onOpenDefaultCommands()
    component.commandEditor!.ruleText = 'docker ps'
    component.onSaveCommandRule()
    expect(component.commandRuleRows()).toMatchObject([{ kind: 'family', label: 'docker ps' }])
    expect(component.commandRulePreviewLabel({ kind: 'exact', version: 1, program: 'tool', hash: 'a'.repeat(64) }))
      .toBe('tool · aaaaaaaaaaaa')
  })

  it('replaces exact fingerprints with newly typed commands and never restores old arguments', async () => {
    const { component, credentials } = await harness()
    const { commandRuleFromText } = await import('@tabby-secure-mcp/ipc-contract/command-policy')
    component.onOpenDefaultCommands()
    const draft = component.commandEditor!
    draft.ruleKind = 'exact'
    draft.ruleText = 'private-tool secret-value'
    component.onSaveCommandRule()
    expect(JSON.stringify(draft.rules)).not.toContain('secret-value')
    const old = draft.rules[0]
    component.onEditCommandRule(0)
    expect(draft.ruleText).toBe('')
    draft.ruleText = 'private-tool other-value'
    component.onSaveCommandRule()
    expect(draft.rules).toEqual([commandRuleFromText('private-tool other-value', 'exact')])
    expect(draft.rules[0]).not.toEqual(old)
    await component.onSaveCommandSet()
    expect(JSON.stringify(credentials.defaultCommandSet())).not.toMatch(/secret-value|other-value/)
  })

  it('leaves the draft untouched after unsupported syntax or an invalid portable payload', async () => {
    const { component } = await harness()
    component.onOpenDefaultCommands()
    const draft = component.commandEditor!
    draft.ruleText = 'docker ps; rm -rf /'
    component.onSaveCommandRule()
    expect(draft.error).toBe('secureMcp.errorCommandRule')
    expect(draft.rules).toEqual([])
    draft.pasteText = '{"version":999,"rules":[]}'
    component.onPreviewCommandImport()
    expect(draft.error).toBe('secureMcp.errorCommandImport')
    expect(draft.importPreview).toBeNull()
    expect(draft.rules).toEqual([])
  })

  it('previews imports before merging or replacing and preserves local inheritance', async () => {
    const { component, credentials, client, profile } = await harness()
    const { exportCommandSet } = await import('@tabby-secure-mcp/ipc-contract/command-policy')
    const docker = { kind: 'family' as const, version: 1 as const, argv: ['docker', 'ps'] }
    await credentials.setDefaultCommandSet([docker], credentials.commandRevision())
    component.onOpenClientCommands(client, component.rows[0]!)
    const draft = component.commandEditor!
    draft.pasteText = exportCommandSet([docker])
    component.onPreviewCommandImport()
    expect(draft.rules).toEqual([])
    expect(draft.importPreview).toEqual([docker])
    component.onApplyCommandImport('merge')
    expect(draft.inheritDefaults).toBe(true)
    expect(component.commandRuleRows()).toMatchObject([{ global: true, local: true }])
    draft.pasteText = exportCommandSet([docker])
    component.onPreviewCommandImport()
    component.onApplyCommandImport('merge')
    expect(draft.rules).toEqual([docker])
    draft.pasteText = exportCommandSet([])
    component.onPreviewCommandImport()
    component.onApplyCommandImport('replace')
    expect(draft.inheritDefaults).toBe(true)
    expect(draft.rules).toEqual([])
    await component.onSaveCommandSet()
    expect(credentials.commandSet(client, 'ssh-1', stableProfileDigest(profile))).toMatchObject({ inheritDefaults: true, rules: [] })
    expect(credentials.defaultCommandSet().rules).toEqual([docker])
  })

  it('clears a local draft without changing inheritance, defaults or another client', async () => {
    const { component, credentials, client, neighbor, profile } = await harness()
    const docker = { kind: 'family' as const, version: 1 as const, argv: ['docker', 'ps'] }
    await credentials.setDefaultCommandSet([docker], credentials.commandRevision())
    component.onOpenClientCommands(client, component.rows[0]!)
    component.onClearCommandSet()
    expect(component.commandEditor).toMatchObject({ rules: [], inheritDefaults: true, clearPending: true })
    expect(credentials.commandSet(client, 'ssh-1', stableProfileDigest(profile)).inheritDefaults).toBe(true)
    await component.onSaveCommandSet()
    expect(credentials.commandSet(client, 'ssh-1', stableProfileDigest(profile)).inheritDefaults).toBe(true)
    expect(credentials.commandSet(neighbor, 'ssh-1', stableProfileDigest(profile)).inheritDefaults).toBe(true)
    expect(credentials.defaultCommandSet().rules).toEqual([docker])
  })

  it('clears global defaults only and keeps local rules and inheritance settings', async () => {
    const { component, credentials, client, profile } = await harness()
    const docker = { kind: 'family' as const, version: 1 as const, argv: ['docker', 'ps'] }
    await credentials.setDefaultCommandSet([docker], credentials.commandRevision())
    await credentials.setCommandSet(client, 'ssh-1', stableProfileDigest(profile), { inheritDefaults: false, rules: [docker] }, credentials.commandRevision())
    component.onOpenDefaultCommands()
    component.onClearCommandSet()
    expect(credentials.defaultCommandSet().rules).toEqual([docker])
    await component.onSaveCommandSet()
    expect(credentials.defaultCommandSet().rules).toEqual([])
    expect(credentials.commandSet(client, 'ssh-1', stableProfileDigest(profile))).toMatchObject({ inheritDefaults: false, rules: [docker] })
  })

  it('copies effective deduplicated rules without identity or credentials and handles clipboard denial', async () => {
    const { component, credentials, client, profile } = await harness()
    const { importCommandSet } = await import('@tabby-secure-mcp/ipc-contract/command-policy')
    const docker = { kind: 'family' as const, version: 1 as const, argv: ['docker', 'ps'] }
    await credentials.setDefaultCommandSet([docker], credentials.commandRevision())
    await credentials.setCommandSet(client, 'ssh-1', stableProfileDigest(profile), { inheritDefaults: true, rules: [docker] }, credentials.commandRevision())
    component.onOpenClientCommands(client, component.rows[0]!)
    const writeText = vi.fn(async (_text: string) => {})
    const readText = vi.fn()
    vi.stubGlobal('navigator', { clipboard: { writeText, readText } })
    expect(writeText).not.toHaveBeenCalled()
    await component.onCopyCommandSet()
    const text = writeText.mock.calls[0]![0]
    expect(importCommandSet(text)).toEqual([docker])
    for (const privateValue of [client.id, credentials.tokenFor(client.id), profile.id, stableProfileDigest(profile)]) expect(text).not.toContain(privateValue)
    expect(readText).not.toHaveBeenCalled()
    writeText.mockRejectedValueOnce(new Error('denied'))
    await component.onCopyCommandSet()
    expect(component.commandEditor!.error).toBe('secureMcp.errorCommandCopy')
  })

  it('shows native clipboard completion inside Angular change detection', async () => {
    let component: SecureMcpSettingsComponent
    let renderedNotice: string | null = null
    const zone = { run: (work: () => void) => { work(); renderedNotice = component.notice } }
    component = new SecureMcpSettingsComponent({} as never, {} as never, {} as never,
      { isMainWindow: true, credentials: { defaultCommandSet: () => ({ rules: [], revision: 0 }) } } as never, zone as never)
    component.onOpenDefaultCommands()
    vi.stubGlobal('navigator', { clipboard: { writeText: async () => {} } })
    await component.onCopyCommandSet()
    expect(renderedNotice).toBe('secureMcp.copiedCommandSetNotice')
  })

  it('rejects an old private revision without losing the draft or newer defaults', async () => {
    const { component, credentials } = await harness()
    component.onOpenDefaultCommands()
    const draft = component.commandEditor!
    draft.ruleText = 'uci get example.key'
    component.onSaveCommandRule()
    const newer = [{ kind: 'family' as const, version: 1 as const, argv: ['docker', 'ps'] }]
    await credentials.setDefaultCommandSet(newer, credentials.commandRevision())
    ;(draft as any).revision = credentials.commandRevision()
    await component.onSaveCommandSet()
    expect(component.commandEditor).toBe(draft)
    expect(draft.error).toBe('secureMcp.errorCommandSetConflict')
    expect(draft.rules).toEqual([{ kind: 'family', version: 1, argv: ['uci', 'get'] }])
    expect(credentials.defaultCommandSet().rules).toEqual(newer)
    await component.reload()
    expect(draft.error).toBe('secureMcp.errorCommandSetConflict')
  })

  it.each(['digest', 'whitelist', 'generation'] as const)('revalidates the local target %s before saving', async change => {
    const { component, credentials, client, profile, config } = await harness()
    component.onOpenClientCommands(client, component.rows[0]!)
    const draft = component.commandEditor!
    draft.ruleText = 'docker ps'
    component.onSaveCommandRule()
    if (change === 'digest') profile.options.host = 'changed.invalid'
    if (change === 'whitelist') config.store.secureMcp.authorizedSshProfileIds = []
    if (change === 'generation') await credentials.reset(client.id)
    await component.onSaveCommandSet()
    expect(component.commandEditor).toBe(draft)
    expect(draft.error).toBe('secureMcp.errorCommandSetTarget')
  })

  it('does not discard pending command text when saving the set', async () => {
    const { component, credentials } = await harness()
    component.onOpenDefaultCommands()
    component.commandEditor!.ruleText = 'docker ps'
    await component.onSaveCommandSet()
    expect(component.commandEditor!.error).toBe('secureMcp.errorCommandDraft')
    expect(credentials.defaultCommandSet().rules).toEqual([])
  })

  it('rejects a queued local save when config changes before profile reload finishes', async () => {
    const { component, credentials, client, profile, profiles, configChanged } = await harness()
    component.onOpenClientCommands(client, component.rows[0]!)
    const draft = component.commandEditor!
    draft.ruleText = 'docker ps'
    component.onSaveCommandRule()
    const persist = credentials.setCommandSet.bind(credentials)
    let resume!: () => void
    let entered!: () => void
    const enteredStore = new Promise<void>(resolve => { entered = resolve })
    const queued = new Promise<void>(resolve => { resume = resolve })
    vi.spyOn(credentials, 'setCommandSet').mockImplementation(async (...args) => { entered(); await queued; return persist(...args) })
    const saving = component.onSaveCommandSet()
    await enteredStore
    let finishReload!: (value: typeof profile[]) => void
    profiles.getProfiles.mockReturnValueOnce(new Promise(resolve => { finishReload = resolve }))
    profile.options.host = 'changed.invalid'
    configChanged()
    resume()
    await saving
    expect(component.commandEditor).toBe(draft)
    expect(draft.error).toBe('secureMcp.errorCommandSetTarget')
    expect(credentials.commandSet(client, 'ssh-1', stableProfileDigest(profile)).rules).toEqual([])
    finishReload(structuredClone([profile]))
  })

  it('blocks command-set editing and copying in secondary windows', async () => {
    const { component, runtime, client } = await harness()
    runtime.isMainWindow = false
    component.onOpenDefaultCommands()
    component.onOpenClientCommands(client, component.rows[0]!)
    expect(component.commandEditor).toBeNull()
  })

  it('removes every client’s connection and command memory before a whitelist re-add', async () => {
    const { component, credentials, client, neighbor, profile } = await harness()
    const digest = stableProfileDigest(profile)
    for (const identity of [client, neighbor]) {
      await credentials.setConnectionPermission(identity, profile.id, digest)
      await credentials.setCommandSet(identity, profile.id, digest,
        { inheritDefaults: false, rules: [{ kind: 'family', version: 1, argv: ['docker', 'ps'] }] }, credentials.commandRevision())
    }
    await component.onToggle(component.rows[0]!, false)
    expect(component.rows[0]!.selected).toBe(false)
    await component.onToggle(component.rows[0]!, true)
    for (const identity of [client, neighbor]) {
      expect(credentials.hasConnectionPermission(identity, profile.id, digest)).toBe(false)
      expect(credentials.commandSet(identity, profile.id, digest).rules).toEqual([])
    }
  })

  it('keeps the whitelist removed and continues other clients when memory cleanup fails', async () => {
    const { component, credentials, client, neighbor, profile, config } = await harness()
    const digest = stableProfileDigest(profile)
    for (const identity of [client, neighbor]) await credentials.setConnectionPermission(identity, profile.id, digest)
    vi.spyOn(credentials, 'setConnectionPermission').mockRejectedValueOnce(new Error('disk full'))
    await component.onToggle(component.rows[0]!, false)
    expect(config.store.secureMcp.authorizedSshProfileIds).toEqual([])
    expect(component.rows[0]!.selected).toBe(false)
    expect(component.error).toBe('secureMcp.errorClearProfileMemory')
    expect(credentials.hasConnectionPermission(neighbor, profile.id, digest)).toBe(false)
  })

  it('fills only the global draft with detached read-only presets and deduplicates repeated fills', async () => {
    const { component, credentials } = await harness()
    component.onOpenLowRiskDefaults()
    expect(component.section).toBe('global')
    expect(component.commandEditor!.rules).toHaveLength(15)
    expect(credentials.defaultCommandSet().rules).toEqual([])
    expect(component.commandSetDirty).toBe(true)
    component.onFillLowRiskCommands()
    expect(component.commandEditor!.rules).toHaveLength(15)
    expect(component.notice).toBe('secureMcp.presetsAlreadyPresent')
    await component.onSaveCommandSet()
    expect(credentials.defaultCommandSet().rules).toHaveLength(15)
    expect(component.commandEditor).toBeNull()
  })

  it('keeps section navigation available while the credential store is not loaded', () => {
    const component = new SecureMcpSettingsComponent({} as never, {} as never, {} as never, {
      credentials: { defaultCommandSet: () => { throw new Error('not loaded') }, list: () => [] },
    } as never)
    expect(component.defaultCommandRules).toEqual([])
    component.onSectionChange('service')
    expect(component.section).toBe('service')
  })

  it('leaves a full preset draft untouched on overflow and never fills a local set', async () => {
    const { component, client } = await harness()
    component.onOpenDefaultCommands()
    component.commandEditor!.rules = Array.from({ length: 128 }, (_, i) => commandRuleFromText('tool ' + i, 'exact'))
    const before = structuredClone(component.commandEditor!.rules)
    component.onFillLowRiskCommands()
    expect(component.commandEditor!.error).toBe('secureMcp.errorCommandRule')
    expect(component.commandEditor!.rules).toEqual(before)
    component.onCloseCommandEditor()
    await component.onConfirmation('discard')
    component.onOpenClientCommands(client, component.rows[0]!)
    component.onFillLowRiskCommands()
    expect(component.commandEditor!.rules).toEqual([])
  })

  it('protects an unsaved draft when changing sections, supports cancel and discard', async () => {
    const { component, credentials } = await harness()
    component.onOpenDefaultCommands()
    component.onRuleTextChange('pwd')
    component.onSaveCommandRule()
    const draft = component.commandEditor
    component.onSectionChange('clients')
    expect(component.confirmation).toMatchObject({ save: true })
    expect(component.commandEditor).toBe(draft)
    expect(component.section).toBe('global')
    await component.onConfirmation('cancel')
    expect(component.commandEditor).toBe(draft)
    component.onSectionChange('clients')
    await component.onConfirmation('discard')
    expect(component.commandEditor).toBeNull()
    expect(component.section).toBe('clients')
    expect(credentials.defaultCommandSet().rules).toEqual([])
  })

  it('saves before navigating and retains the current view if persistence fails', async () => {
    const { component, credentials } = await harness()
    component.onOpenLowRiskDefaults()
    component.onSectionChange('ssh')
    vi.spyOn(credentials, 'setDefaultCommandSet').mockRejectedValueOnce(new Error('disk full'))
    await component.onConfirmation('save')
    expect(component.commandEditor!.rules).toHaveLength(15)
    expect(component.commandEditor!.error).toBe('secureMcp.errorCommandSetSave')
    expect(component.section).toBe('global')
    component.onSectionChange('ssh')
    await component.onConfirmation('save')
    expect(component.commandEditor).toBeNull()
    expect(component.section).toBe('ssh')
    expect(credentials.defaultCommandSet().rules).toHaveLength(15)
  })

  it('renders the destination inside Angular after a native async save-and-leave', async () => {
    let component: SecureMcpSettingsComponent | undefined
    let renderedSection: string | undefined
    const zone = { run(work: () => void) { work(); renderedSection = component?.section } }
    component = (await harness(zone)).component
    component.onOpenLowRiskDefaults()
    component.onSectionChange('ssh')
    await component.onConfirmation('save')
    expect(component.section).toBe('ssh')
    expect(renderedSection).toBe('ssh')
  })

  it('protects pending command input before editing another rule', async () => {
    const { component } = await harness()
    component.onOpenLowRiskDefaults()
    component.onRuleTextChange('uname -a')
    component.onRuleKindChange('exact')
    component.onEditCommandRule(0)
    expect(component.commandEditor!.ruleText).toBe('uname -a')
    expect(component.confirmation).toMatchObject({ apply: true })
    await component.onConfirmation('cancel')
    expect(component.commandEditor!.ruleText).toBe('uname -a')
    component.onEditCommandRule(0)
    await component.onConfirmation('apply')
    expect(component.commandEditor!.rules).toHaveLength(16)
    expect(component.commandEditor!.ruleText).toBe('pwd')
    expect(component.commandEditor!.editingIndex).toBe(0)
  })

  it('keeps invalid pending input when apply-and-switch fails', async () => {
    const { component } = await harness()
    component.onOpenLowRiskDefaults()
    component.onRuleTextChange('pwd; rm -rf /')
    component.onEditCommandRule(1)
    await component.onConfirmation('apply')
    expect(component.commandEditor!.ruleText).toBe('pwd; rm -rf /')
    expect(component.commandEditor!.editingIndex).toBeNull()
    expect(component.commandEditor!.error).toBe('secureMcp.errorCommandRule')
  })

  it('requires confirmation before clear and preserves local inheritance', async () => {
    const { component, client } = await harness()
    component.onOpenClientCommands(client, component.rows[0]!)
    component.onRuleTextChange('pwd')
    component.onSaveCommandRule()
    component.onRequestClearCommandSet()
    expect(component.commandEditor!.rules).toHaveLength(1)
    await component.onConfirmation('cancel')
    expect(component.commandEditor!.rules).toHaveLength(1)
    component.onRequestClearCommandSet()
    await component.onConfirmation('confirm')
    expect(component.commandEditor!.rules).toEqual([])
    expect(component.commandEditor!.inheritDefaults).toBe(true)
  })

  it('resets old row edits after import replacement and retains inheritance', async () => {
    const { component, credentials, client, profile } = await harness()
    const { exportCommandSet } = await import('@tabby-secure-mcp/ipc-contract/command-policy')
    component.onOpenClientCommands(client, component.rows[0]!)
    component.onRuleTextChange('docker ps')
    component.onSaveCommandRule()
    component.onEditCommandRule(0)
    component.onPasteTextChange(exportCommandSet([commandRuleFromText('whoami', 'family')]))
    component.onPreviewCommandImport()
    component.onRequestReplaceCommandImport()
    expect(component.commandEditor!.ruleText).toBe('docker ps')
    await component.onConfirmation('confirm')
    expect(component.commandEditor).toMatchObject({ editingIndex: null, ruleText: '', inheritDefaults: true })
    await component.onSaveCommandSet()
    expect(credentials.commandSet(client, profile.id, stableProfileDigest(profile)).rules).toEqual([commandRuleFromText('whoami', 'family')])
  })

  it('preserves unrelated pending input while removing another rule', async () => {
    const { component } = await harness()
    component.onOpenLowRiskDefaults()
    component.onEditCommandRule(2)
    component.onRuleTextChange('uname -a')
    component.onDeleteCommandRule(0)
    expect(component.commandEditor).toMatchObject({ editingIndex: 1, ruleText: 'uname -a' })
    component.onSaveCommandRule()
    expect(component.commandEditor!.rules[1]).toEqual(commandRuleFromText('uname -a', 'family'))
  })

  it('copies local rules without inheriting a different global family', async () => {
    const { component, credentials, client, profile } = await harness()
    const { importCommandSet } = await import('@tabby-secure-mcp/ipc-contract/command-policy')
    await credentials.setDefaultCommandSet([commandRuleFromText('docker ps', 'family')], credentials.commandRevision())
    await credentials.setCommandSet(client, profile.id, stableProfileDigest(profile), { inheritDefaults: true, rules: [commandRuleFromText('whoami', 'family')] }, credentials.commandRevision())
    component.onOpenClientCommands(client, component.rows[0]!)
    const writeText = vi.fn(async (_value: string) => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    await component.onCopyCommandSet()
    expect(importCommandSet(writeText.mock.calls[0]![0])).toEqual([commandRuleFromText('whoami', 'family')])
    expect(component.inheritedCommandRuleRows()).toHaveLength(1)
    expect(component.localCommandRuleRows()).toHaveLength(1)
    expect(component.clientCommandSummary(client, component.rows[0]!)).toMatchObject({ local: 1, global: 1, effective: 2, inheritDefaults: true })
  })
})
