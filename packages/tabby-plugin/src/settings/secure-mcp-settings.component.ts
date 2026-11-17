import { Component, ElementRef, Inject, NgZone, OnDestroy, OnInit, Optional, ViewChild } from '@angular/core'
import { ConfigService, ProfilesService, type PartialProfile, type Profile } from 'tabby-core'
import {
  commandRuleFromText, validateApprovedCommandRules, exportCommandSet, importCommandSet, lowRiskReadOnlyCommandRules,
  type ApprovedCommandRule,
} from '@tabby-secure-mcp/ipc-contract/command-policy'

import { stableProfileDigest } from '../approval/profile-security-snapshot'
import { resolveEffectiveProfile } from '../profiles/effective-profile'
import { isGrantedOperationTier, type GrantedOperationTier } from '../authorization/operation-tier-policy'
import { PermanentAuthorizationStore } from '../authorization/permanent-authorization-store'
import {
  persistAuthorizedSshProfileIds,
  readAuthorizedSshProfileIds,
  hasUnpersistedRevocations,
  persistCommandSessionClosePolicy,
  readCommandSessionClosePolicy,
  type CommandSessionClosePolicy,
} from '../config/secure-mcp-config'
import {
  buildSecureMcpSettingsRows,
  SETTINGS_OPERATION_TIER_OPTIONS,
  type SecureMcpSettingsRow,
  type CommandSetEditor,
  type CommandSetRuleRow,
} from './secure-mcp-settings.view-model'
import { secureMcpSettingsTemplate } from './secure-mcp-settings.template'
import { secureMcpSettingsStyles } from './secure-mcp-settings.styles'
import { PluginHttpRuntime } from '../runtime/plugin-http-runtime'
import type { ClientCredentialView } from '@tabby-secure-mcp/companion'

type CommandEditorSnapshot = { revision: number } & (
  | { scope: 'global' }
  | { scope: 'local'; client: ClientCredentialView; profileId: string; profileDigest: string }
)
type SettingsSection = 'service' | 'clients' | 'ssh' | 'global'
type ConfirmationChoice = 'cancel' | 'discard' | 'save' | 'confirm' | 'apply'

@Component({
  selector: 'secure-mcp-settings',
  template: secureMcpSettingsTemplate,
  styles: [secureMcpSettingsStyles],
})
export class SecureMcpSettingsComponent implements OnInit, OnDestroy {
  rows: SecureMcpSettingsRow[] = []
  readonly tierOptions = SETTINGS_OPERATION_TIER_OPTIONS
  loading = true
  saving = false
  commandSessionClosePolicy: CommandSessionClosePolicy = 'keep'
  error: string | null = null
  private loadedProfiles: PartialProfile<Profile>[] = []
  readonly serviceStatuses: Record<string, string> = {
    stopped: 'secureMcp.serviceStopped',
    starting: 'secureMcp.serviceStarting',
    running: 'secureMcp.serviceRunning',
    secondary: 'secureMcp.serviceSecondary',
    error: 'secureMcp.serviceError',
  }
  readonly serviceErrors: Record<string, string> = {
    'Could not load MCP credentials or start the local service. Check the private credential file and port availability.': 'secureMcp.runtimeLoadError',
    'Service stopped for this run, but the configuration was not saved. Retry before restarting Tabby.': 'secureMcp.runtimeStopError',
    'Could not start local MCP. Check the configured port and audit/credential storage.': 'secureMcp.runtimeStartError',
    'Invalid MCP service configuration.': 'secureMcp.runtimeConfigError',
  }
  clientName = ''
  creatingClient = false
  httpPort = 50333
  notice: string | null = null
  commandEditor: CommandSetEditor | null = null
  section: SettingsSection = 'clients'
  selectedClientId: string | null = null
  importOpen = false
  confirmation: { titleKey: string; bodyKey: string; save?: boolean; apply?: boolean; danger?: boolean } | null = null
  @ViewChild('commandInput') private commandInput?: ElementRef<HTMLInputElement>
  @ViewChild('editorTop') private editorTop?: ElementRef<HTMLElement>
  @ViewChild('confirmationDialog') private confirmationDialog?: ElementRef<HTMLDialogElement>
  private confirmationAction?: (choice: ConfirmationChoice) => void | Promise<void>
  private initialCommandSet: { rules: string; inheritDefaults: boolean } | null = null
  private focusTimer?: ReturnType<typeof setTimeout>
  private commandEditorSnapshot: CommandEditorSnapshot | null = null
  private stopUpdates?: () => void
  private stopConfigUpdates?: () => void
  private reloadRevision = 0
  private configRevision = 0

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(ProfilesService) private readonly profiles: ProfilesService,
    @Inject(PermanentAuthorizationStore) private readonly authorizations: PermanentAuthorizationStore,
    @Optional() @Inject(PluginHttpRuntime) readonly runtime?: PluginHttpRuntime,
    @Optional() @Inject(NgZone) private readonly zone?: NgZone,
  ) {}

  async ngOnInit(): Promise<void> {
    if (this.runtime) {
      this.httpPort = this.runtime.serverConfig().port
      this.stopUpdates = this.runtime.onChange(() => {
        this.updateView(() => { this.httpPort = this.runtime!.serverConfig().port })
        void this.reload(true)
      })
    }
    const subscription = this.config.changed$?.subscribe(() => { ++this.configRevision; void this.reload(true) })
    if (subscription) this.stopConfigUpdates = () => subscription.unsubscribe()
    await this.reload()
  }

  ngOnDestroy(): void {
    ++this.reloadRevision
    clearTimeout(this.focusTimer)
    this.confirmationDialog?.nativeElement.close()
    this.confirmationAction = undefined
    this.commandEditorSnapshot = null
    this.stopUpdates?.()
    this.stopConfigUpdates?.()
  }
  private updateView(work: () => void): void { if (this.zone) this.zone.run(work); else work() }
  get canManage(): boolean { return this.runtime?.isMainWindow ?? true }
  get clients(): ClientCredentialView[] { return this.runtime?.credentials.list() ?? [] }
  get selectedClient(): ClientCredentialView | undefined { return this.clients.find(client => client.id === this.selectedClientId) ?? this.clients[0] }
  // Key the detail view so native select drafts cannot leak across client identities.
  get selectedClientView(): ClientCredentialView[] { const client = this.selectedClient; return client ? [client] : [] }
  get selectedRows(): SecureMcpSettingsRow[] { return this.rows.filter(row => row.selected) }
  get defaultCommandRules(): ApprovedCommandRule[] {
    try { return this.runtime?.credentials.defaultCommandSet().rules ?? [] }
    catch { return [] }
  }
  get commandSetDirty(): boolean {
    const editor = this.commandEditor
    return !!editor && !!this.initialCommandSet && (JSON.stringify(editor.rules) !== this.initialCommandSet.rules
      || editor.inheritDefaults !== this.initialCommandSet.inheritDefaults || this.pendingRuleInput()
      || !!editor.pasteText.trim() || editor.importPreview !== null)
  }

  clientCommandSummary(client: ClientCredentialView, row: SecureMcpSettingsRow): { local: number; global: number; effective: number; inheritDefaults: boolean; stale: boolean } {
    try {
      const profile = this.loadedProfiles.find(item => item.id === row.id)
      if (!profile || !this.runtime) throw new Error('profile unavailable')
      const set = this.runtime.credentials.commandSet(client, row.id, stableProfileDigest(profile))
      const defaults = set.inheritDefaults ? this.defaultCommandRules : []
      return { local: set.rules.length, global: defaults.length, effective: new Set([...defaults, ...set.rules].map(rule => JSON.stringify(rule))).size, inheritDefaults: set.inheritDefaults, stale: set.stale }
    } catch { return { local: 0, global: 0, effective: 0, inheritDefaults: false, stale: true } }
  }

  onSectionChange(section: SettingsSection): void {
    if (!['service', 'clients', 'ssh', 'global'].includes(section) || this.saving) return
    this.leaveCommandEditor(() => { this.section = section })
  }

  onSelectClient(id: string): void {
    if (this.saving || !this.clients.some(client => client.id === id)) return
    this.leaveCommandEditor(() => { this.selectedClientId = id; this.section = 'clients' })
  }

  private leaveCommandEditor(next: () => void): void {
    if (this.commandSetDirty) {
      this.requestConfirmation({ titleKey: 'secureMcp.unsavedTitle', bodyKey: 'secureMcp.unsavedBody', save: true }, async choice => {
        if (choice === 'save') { await this.onSaveCommandSet(); if (this.commandEditor) return }
        else if (choice !== 'discard') return
        this.closeCommandEditor()
        next()
      })
    } else { this.closeCommandEditor(); next() }
  }

  private requestConfirmation(prompt: NonNullable<SecureMcpSettingsComponent['confirmation']>, action: (choice: ConfirmationChoice) => void | Promise<void>): void {
    if (this.confirmation || this.saving) return
    this.confirmation = prompt
    this.confirmationAction = action
    clearTimeout(this.focusTimer)
    this.focusTimer = setTimeout(() => this.updateView(() => {
      if (this.confirmation && !this.confirmationDialog?.nativeElement.open) this.confirmationDialog?.nativeElement.showModal()
    }), 0)
  }

  async onConfirmation(choice: ConfirmationChoice): Promise<void> {
    if (this.saving || !this.confirmation) return
    const action = this.confirmationAction
    this.confirmation = null
    this.confirmationAction = undefined
    this.confirmationDialog?.nativeElement.close()
    try { if (choice !== 'cancel') await action?.(choice) }
    finally { this.updateView(() => {}) }
  }

  onCancelConfirmation(event: Event): void { event.preventDefault(); void this.onConfirmation('cancel') }

  private focusCommandInput(atTop = false): void {
    const editor = this.commandEditor
    clearTimeout(this.focusTimer)
    this.focusTimer = setTimeout(() => {
      if (!editor || this.commandEditor !== editor || this.confirmation) return
      if (atTop) this.editorTop?.nativeElement.scrollIntoView({ block: 'start' })
      this.commandInput?.nativeElement.focus({ preventScroll: atTop })
    }, 0)
  }

  private pendingRuleInput(): boolean {
    const editor = this.commandEditor
    if (!editor) return false
    if (editor.editingIndex === null) return !!editor.ruleText.trim()
    const rule = editor.rules[editor.editingIndex]
    if (!rule || rule.kind === 'exact') return true
    return editor.ruleKind !== rule.kind || editor.ruleText !== rule.argv.join(' ')
  }

  onRuleTextChange(text: string): void { if (this.commandEditor && !this.saving) { this.commandEditor.ruleText = text; this.commandEditor.error = null } }
  onRuleKindChange(kind: string): void { if (this.commandEditor && !this.saving && (kind === 'family' || kind === 'exact')) this.commandEditor.ruleKind = kind }
  onPasteTextChange(text: string): void { if (this.commandEditor && !this.saving) { this.commandEditor.pasteText = text; this.commandEditor.importPreview = null } }
  onInheritanceChange(inherit: boolean): void { if (this.commandEditor?.scope === 'local' && !this.saving && this.canManage) { this.commandEditor.inheritDefaults = inherit; this.commandEditor.clearPending = false } }
  onToggleCommandImport(): void { if (this.commandEditor && !this.saving) this.importOpen = !this.importOpen }

  onRequestClearCommandSet(): void {
    if (!this.canManage || !this.commandEditor || this.saving) return
    this.requestConfirmation({ titleKey: 'secureMcp.clearTitle', bodyKey: 'secureMcp.clearBody', danger: true }, choice => { if (choice === 'confirm') this.onClearCommandSet() })
  }

  onRequestReplaceCommandImport(): void {
    if (!this.canManage || !this.commandEditor?.importPreview || this.saving) return
    this.requestConfirmation({ titleKey: 'secureMcp.replaceTitle', bodyKey: 'secureMcp.replaceBody', danger: true }, choice => { if (choice === 'confirm') this.onApplyCommandImport('replace') })
  }

  onRequestResetClient(id: string): void {
    if (!this.canManage || !this.clients.some(client => client.id === id)) return
    this.requestConfirmation({ titleKey: 'secureMcp.resetTitle', bodyKey: 'secureMcp.resetBody', danger: true }, async choice => { if (choice === 'confirm') await this.onResetClient(id) })
  }

  onRequestRevokeClient(id: string): void {
    if (!this.canManage || !this.clients.some(client => client.id === id)) return
    this.requestConfirmation({ titleKey: 'secureMcp.revokeTitle', bodyKey: 'secureMcp.revokeBody', danger: true }, async choice => { if (choice === 'confirm') await this.onRevokeClient(id) })
  }

  onEditGlobalFromLocal(): void { if (!this.saving) this.leaveCommandEditor(() => { this.section = 'global'; this.onOpenDefaultCommands() }) }

  onOpenLowRiskDefaults(): void { this.leaveCommandEditor(() => { this.section = 'global'; this.onOpenDefaultCommands(); this.onFillLowRiskCommands() }) }

  onFillLowRiskCommands(): void {
    const editor = this.commandEditor
    if (!this.canManage || this.saving || editor?.scope !== 'global') return
    try {
      const next = validateApprovedCommandRules([...editor.rules, ...lowRiskReadOnlyCommandRules()])
      exportCommandSet(next)
      const added = next.length - editor.rules.length
      editor.rules = next
      editor.clearPending = false
      editor.error = null
      editor.detail = ''
      this.notice = added ? 'secureMcp.filledLowRiskNotice' : 'secureMcp.presetsAlreadyPresent'
    } catch (error) {
      editor.error = 'secureMcp.errorCommandRule'
      editor.detail = error instanceof Error ? error.message : ''
    }
  }
  trackClient(_index: number, client: ClientCredentialView): string { return client.id }
  clientPermission(client: ClientCredentialView): string {
    if (client.permission.kind === 'session') return 'secureMcp.sessionPermissionPending'
    if (client.permission.kind === 'permanent') return 'secureMcp.permanentPermission'
    if (client.permission.kind === 'until') return 'secureMcp.untilPermission'
    if (this.runtime?.sessions().some(session => session.clientId === client.id && session.state === 'approved' && session.duration === 'session')) return 'secureMcp.sessionPermissionActive'
    return 'secureMcp.noRememberedPermission'
  }

  clientPermissionChoice(client: ClientCredentialView): string {
    if (client.permission.kind === 'until') return '24h'
    if (client.permission.kind === 'none' && this.runtime?.sessions().some(session => session.clientId === client.id && session.state === 'approved' && session.duration === 'session')) return 'session'
    return client.permission.kind
  }

  clientConnectionState(client: ClientCredentialView, row: SecureMcpSettingsRow): 'ask' | 'allowed' | 'stale' {
    const grant = this.runtime?.credentials.connectionGrants(client).find(item => item.profileId === row.id)
    if (!grant) return 'ask'
    try {
      const profile = this.loadedProfiles.find(item => item.id === row.id)
      return profile && grant.profileDigest === stableProfileDigest(profile) ? 'allowed' : 'stale'
    } catch { return 'stale' }
  }

  async onChangeClientConnection(client: ClientCredentialView, row: SecureMcpSettingsRow, choice: string): Promise<void> {
    if (!row.selected || (choice !== 'ask' && choice !== 'allowed')) return
    await this.clientAction(async () => {
      const credentials = this.runtime!.credentials
      const revision = credentials.connectionRevision(client)
      let digest: string | null = null
      if (choice === 'allowed') {
        const reviewed = this.loadedProfiles.find(item => item.id === row.id)
        const raw = (await this.profiles.getProfiles({ includeBuiltin: false, clone: true })).find(item => item.id === row.id)
        if (!reviewed || !raw || !readAuthorizedSshProfileIds(this.config.store, this.config).includes(row.id)) throw new Error('profile unavailable')
        digest = stableProfileDigest(resolveEffectiveProfile(raw, this.profiles))
        if (digest !== stableProfileDigest(reviewed)) {
          await this.reload(true)
          throw new Error('profile changed')
        }
      }
      await credentials.setConnectionPermission(client, row.id, digest, revision)
      this.notice = choice === 'allowed'
        ? 'secureMcp.connectionAllowedNotice'
        : 'secureMcp.connectionClearedNotice'
    }, 'secureMcp.errorSaveConnection')
  }

  clientFileTransferEnabled(client: ClientCredentialView, row: SecureMcpSettingsRow): boolean {
    try {
      const profile = this.loadedProfiles.find(item => item.id === row.id)
      return !!row.selected && !!profile && (this.runtime?.credentials.hasFileTransferPermission?.(client, row.id, stableProfileDigest(profile)) ?? false)
    } catch { return false }
  }

  async onChangeClientFileTransfer(client: ClientCredentialView, row: SecureMcpSettingsRow, enabled: boolean, input?: HTMLInputElement): Promise<void> {
    if (!row.selected) { if (input) input.checked = false; return }
    await this.clientAction(async () => {
      const credentials = this.runtime!.credentials
      const revision = credentials.fileTransferRevision()
      const configRevision = this.configRevision
      let digest: string | null = null
      if (enabled) {
        const reviewed = this.loadedProfiles.find(item => item.id === row.id)
        const raw = (await this.profiles.getProfiles({ includeBuiltin: false, clone: true })).find(item => item.id === row.id)
        if (!reviewed || !raw) throw new Error('profile unavailable')
        digest = stableProfileDigest(resolveEffectiveProfile(raw, this.profiles))
        if (digest !== stableProfileDigest(reviewed)) throw new Error('profile changed')
      }
      const current = () => {
        if (!this.canManage || !credentials.isCurrent(client)) return false
        if (!enabled) return true
        try {
          const reviewed = this.loadedProfiles.find(item => item.id === row.id)
          return configRevision === this.configRevision && !!reviewed && stableProfileDigest(reviewed) === digest
            && readAuthorizedSshProfileIds(this.config.store, this.config).includes(row.id)
        } catch { return false }
      }
      await credentials.setFileTransferPermission(client, row.id, digest, revision, current)
      this.notice = enabled ? 'secureMcp.fileTransferEnabledNotice' : 'secureMcp.fileTransferDisabledNotice'
    }, 'secureMcp.errorSaveFileTransfer')
    if (input) input.checked = this.clientFileTransferEnabled(client, row)
  }

  private async clientAction(action: () => Promise<unknown>, failure: string): Promise<void> {
    if (!this.canManage || this.saving || !this.runtime) return
    this.saving = true
    this.error = null
    this.notice = null
    try { await action() } catch { this.error = failure } finally { this.updateView(() => { this.saving = false }) }
  }

  async onSaveServer(enabled: boolean): Promise<void> {
    await this.clientAction(() => this.runtime!.setServerConfig(enabled, this.httpPort), 'secureMcp.errorSaveService')
  }

  async onCreateClient(): Promise<void> {
    await this.clientAction(async () => {
      const client = await this.runtime!.credentials.create(this.clientName)
      if (client) this.selectedClientId = client.id
      this.clientName = ''
      this.creatingClient = false
    }, 'secureMcp.errorCreateCredential')
  }

  async onRenameClient(id: string, name: string, input?: HTMLInputElement): Promise<void> {
    await this.clientAction(() => this.runtime!.credentials.rename(id, name), 'secureMcp.errorRenameCredential')
    const saved = this.runtime?.credentials.list().find(client => client.id === id)
    if (input && saved) input.value = saved.name
  }

  async onResetClient(id: string): Promise<void> {
    await this.clientAction(() => this.runtime!.credentials.reset(id), 'secureMcp.errorResetCredential')
  }

  async onRevokeClient(id: string): Promise<void> {
    await this.clientAction(() => this.runtime!.credentials.revoke(id), 'secureMcp.errorRevokeClient')
  }

  async onChangeClientPermission(id: string, generation: number, duration: string): Promise<void> {
    if (duration !== 'none' && duration !== 'session' && duration !== '24h' && duration !== 'permanent') return
    await this.clientAction(async () => {
      await this.runtime!.credentials.setPermission(id, generation, duration)
      this.notice = duration === 'session'
        ? 'secureMcp.sessionPermissionNotice'
        : duration === 'none'
          ? 'secureMcp.clearPermissionNotice'
          : 'secureMcp.updatedPermissionNotice'
    }, 'secureMcp.errorUpdatePermission')
  }

  async onCopyClient(id: string): Promise<void> {
    await this.clientAction(async () => {
      const value = { mcpServers: { 'tabby-secure-mcp': {
        url: `http://127.0.0.1:${this.runtime!.serverConfig().port}/mcp`,
        headers: { Authorization: `Bearer ${this.runtime!.credentials.tokenFor(id)}` },
      } } }
      await navigator.clipboard.writeText(JSON.stringify(value, null, 2))
      this.notice = 'secureMcp.copiedConfigurationNotice'
    }, 'secureMcp.errorCopyConfiguration')
  }

  onOpenDefaultCommands(): void {
    if (!this.canManage || this.saving || !this.runtime || this.commandEditor) return
    try {
      const set = this.runtime.credentials.defaultCommandSet()
      this.section = 'global'
      this.openCommandEditor({ scope: 'global', revision: set.revision }, set.rules, false, '', false)
    } catch { this.error = 'secureMcp.errorCommandSetLoad' }
  }

  onOpenClientCommands(client: ClientCredentialView, row: SecureMcpSettingsRow): void {
    if (!this.canManage || this.saving || !this.runtime || this.commandEditor || !row.selected) return
    try {
      const profile = this.loadedProfiles.find(item => item.id === row.id)
      if (!profile || !readAuthorizedSshProfileIds(this.config.store, this.config).includes(row.id)
        || !this.runtime.credentials.isCurrent(client)) throw new Error('target unavailable')
      const digest = stableProfileDigest(profile)
      const set = this.runtime.credentials.commandSet(client, row.id, digest)
      this.section = 'clients'
      this.selectedClientId = client.id
      this.openCommandEditor(
        { scope: 'local', revision: set.revision, client: { ...client }, profileId: row.id, profileDigest: digest },
        set.rules, set.inheritDefaults, `${client.name} / ${row.displayName}`, set.stale,
      )
    } catch { this.error = 'secureMcp.errorCommandSetLoad' }
  }

  private openCommandEditor(
    snapshot: CommandEditorSnapshot, rules: ApprovedCommandRule[], inheritDefaults: boolean, targetLabel: string, stale: boolean,
  ): void {
    this.commandEditorSnapshot = snapshot
    this.commandEditor = {
      scope: snapshot.scope, targetLabel, stale, inheritDefaults,
      rules: rules.map(rule => rule.kind === 'family' ? { ...rule, argv: [...rule.argv] } : { ...rule }),
      ruleKind: 'family', ruleText: '', editingIndex: null, pasteText: '', importPreview: null,
      clearPending: false, error: null, detail: '',
    }
    this.initialCommandSet = { rules: JSON.stringify(this.commandEditor.rules), inheritDefaults }
    this.importOpen = false
    this.notice = null
    this.focusCommandInput(true)
  }

  onCloseCommandEditor(): void {
    if (this.saving) return
    this.leaveCommandEditor(() => {})
  }

  private closeCommandEditor(): void {
    clearTimeout(this.focusTimer)
    this.commandEditor = null
    this.commandEditorSnapshot = null
    this.initialCommandSet = null
    this.importOpen = false
  }

  trackCommandRule(_index: number, row: CommandSetRuleRow): string { return row.key }

  commandRuleRows(): CommandSetRuleRow[] {
    const editor = this.commandEditor
    if (!editor) return []
    const rows = new Map<string, CommandSetRuleRow>()
    if (editor.scope === 'local' && editor.inheritDefaults) {
      for (const rule of this.runtime!.credentials.defaultCommandSet().rules) {
        const key = JSON.stringify(rule)
        rows.set(key, { key, kind: rule.kind, label: this.commandRulePreviewLabel(rule), global: true, local: false, localIndex: null })
      }
    }
    editor.rules.forEach((rule, index) => {
      const key = JSON.stringify(rule)
      rows.set(key, { key, kind: rule.kind, label: this.commandRulePreviewLabel(rule), global: editor.scope === 'global' || rows.has(key), local: editor.scope === 'local', localIndex: index })
    })
    return [...rows.values()]
  }

  commandRulePreviewLabel(rule: ApprovedCommandRule): string {
    return rule.kind === 'family' ? rule.argv.join(' ') : `${rule.program} · ${rule.hash.slice(0, 12)}`
  }

  localCommandRuleRows(): CommandSetRuleRow[] {
    const editor = this.commandEditor
    return editor?.rules.map((rule, index) => ({ key: JSON.stringify(rule), kind: rule.kind, label: this.commandRulePreviewLabel(rule), global: editor.scope === 'global', local: editor.scope === 'local', localIndex: index })) ?? []
  }

  inheritedCommandRuleRows(): CommandSetRuleRow[] {
    return this.commandEditor?.scope === 'local' && this.commandEditor.inheritDefaults
      ? this.defaultCommandRules.map(rule => ({ key: JSON.stringify(rule), kind: rule.kind, label: this.commandRulePreviewLabel(rule), global: true, local: false, localIndex: null })) : []
  }

  onEditCommandRule(index: number): void {
    const editor = this.commandEditor
    if (!this.canManage || this.saving || !editor) return
    const rule = editor.rules[index]
    if (!rule) return
    if (editor.editingIndex === index) { this.focusCommandInput(); return }
    if (this.pendingRuleInput()) {
      const key = JSON.stringify(rule)
      this.requestConfirmation({ titleKey: 'secureMcp.switchRuleTitle', bodyKey: 'secureMcp.switchRuleBody', apply: true }, choice => {
        if (this.commandEditor !== editor) return
        if (choice === 'apply') { this.onSaveCommandRule(); if (editor.error) return }
        else if (choice !== 'discard') return
        const nextIndex = editor.rules.findIndex(item => JSON.stringify(item) === key)
        if (nextIndex >= 0) this.editCommandRule(nextIndex)
      })
      return
    }
    this.editCommandRule(index)
  }

  private editCommandRule(index: number): void {
    const editor = this.commandEditor!
    const rule = editor.rules[index]!
    editor.editingIndex = index
    editor.ruleKind = rule.kind
    editor.ruleText = rule.kind === 'family' ? rule.argv.join(' ') : ''
    editor.error = null
    editor.detail = ''
    this.focusCommandInput()
  }

  onCancelCommandRule(): void {
    const editor = this.commandEditor
    if (!this.canManage || this.saving || !editor) return
    editor.editingIndex = null
    editor.ruleText = ''
  }

  onSaveCommandRule(): void {
    const editor = this.commandEditor
    if (!this.canManage || this.saving || !editor) return
    try {
      const rule = commandRuleFromText(editor.ruleText, editor.ruleKind)
      const next = [...editor.rules]
      if (editor.editingIndex === null) next.push(rule)
      else next[editor.editingIndex] = rule
      editor.rules = validateApprovedCommandRules(next)
      editor.clearPending = false
      editor.error = null
      editor.detail = ''
      this.onCancelCommandRule()
      this.focusCommandInput()
    } catch (error) {
      editor.error = 'secureMcp.errorCommandRule'
      editor.detail = error instanceof Error ? error.message : ''
    }
  }

  onDeleteCommandRule(index: number): void {
    const editor = this.commandEditor
    if (!this.canManage || this.saving || !editor) return
    if (!editor.rules[index]) return
    editor.rules = editor.rules.filter((_rule, candidate) => candidate !== index)
    if (editor.editingIndex === index) this.onCancelCommandRule()
    else if (editor.editingIndex !== null && editor.editingIndex > index) editor.editingIndex--
  }

  onClearCommandSet(): void {
    const editor = this.commandEditor
    if (!this.canManage || this.saving || !editor) return
    editor.rules = []
    editor.clearPending = true
    editor.error = null
    editor.detail = ''
    this.onCancelCommandRule()
    this.onCancelCommandImport()
  }

  onPreviewCommandImport(): void {
    const editor = this.commandEditor
    if (!this.canManage || this.saving || !editor) return
    try {
      editor.importPreview = importCommandSet(editor.pasteText)
      editor.error = null
      editor.detail = ''
    } catch (error) {
      editor.importPreview = null
      editor.error = 'secureMcp.errorCommandImport'
      editor.detail = error instanceof Error ? error.message : ''
    }
  }

  onApplyCommandImport(strategy: 'merge' | 'replace'): void {
    const editor = this.commandEditor
    if (!this.canManage || this.saving || !editor || !editor.importPreview) return
    if (strategy !== 'merge' && strategy !== 'replace') return
    try {
      const rules = validateApprovedCommandRules(strategy === 'merge'
        ? [...editor.rules, ...editor.importPreview] : editor.importPreview)
      editor.rules = rules
      if (strategy === 'replace') this.onCancelCommandRule()
      editor.clearPending = false
      editor.error = null
      editor.detail = ''
      this.onCancelCommandImport()
    } catch (error) {
      editor.error = 'secureMcp.errorCommandImport'
      editor.detail = error instanceof Error ? error.message : ''
    }
  }

  onCancelCommandImport(): void {
    const editor = this.commandEditor
    if (!this.canManage || this.saving || !editor) return
    editor.importPreview = null
    editor.pasteText = ''
    this.importOpen = false
  }

  async onCopyCommandSet(): Promise<void> {
    const editor = this.commandEditor
    if (!this.canManage || this.saving || !editor || !this.runtime) return
    try {
      await navigator.clipboard.writeText(exportCommandSet(editor.rules))
      this.updateView(() => {
        this.notice = 'secureMcp.copiedCommandSetNotice'
        editor.error = null
        editor.detail = ''
      })
    } catch { this.updateView(() => { editor.error = 'secureMcp.errorCommandCopy'; this.notice = null }) }
  }

  async onSaveCommandSet(): Promise<void> {
    const editor = this.commandEditor
    const snapshot = this.commandEditorSnapshot
    if (!this.canManage || this.saving || !this.runtime || !editor || !snapshot) return
    editor.error = null
    editor.detail = ''
    if (editor.ruleText.trim() || editor.editingIndex !== null || editor.pasteText.trim() || editor.importPreview !== null) {
      editor.error = 'secureMcp.errorCommandDraft'
      return
    }
    this.saving = true
    const configRevision = this.configRevision
    let targetCurrent = (): boolean => true
    try {
      const credentials = this.runtime.credentials
      const rules = validateApprovedCommandRules(editor.rules)
      if (snapshot.scope === 'local') {
        const raw = (await this.profiles.getProfiles({ includeBuiltin: false, clone: true })).find(item => item.id === snapshot.profileId)
        targetCurrent = (): boolean => {
          try {
            const reviewed = this.loadedProfiles.find(item => item.id === snapshot.profileId)
            return !!raw && !!reviewed && this.canManage && credentials.isCurrent(snapshot.client)
              && this.commandEditorSnapshot === snapshot && this.configRevision === configRevision
              && readAuthorizedSshProfileIds(this.config.store, this.config).includes(snapshot.profileId)
              && stableProfileDigest(resolveEffectiveProfile(raw, this.profiles)) === snapshot.profileDigest
              && stableProfileDigest(reviewed) === snapshot.profileDigest
          } catch { return false }
        }
        if (!targetCurrent()) { editor.error = 'secureMcp.errorCommandSetTarget'; return }
        if (credentials.commandRevision() !== snapshot.revision) { editor.error = 'secureMcp.errorCommandSetConflict'; return }
        await credentials.setCommandSet(snapshot.client, snapshot.profileId, snapshot.profileDigest,
          { inheritDefaults: editor.inheritDefaults, rules }, snapshot.revision, targetCurrent)
      } else {
        if (credentials.commandRevision() !== snapshot.revision) { editor.error = 'secureMcp.errorCommandSetConflict'; return }
        await credentials.setDefaultCommandSet(rules, snapshot.revision)
      }
      this.section = snapshot.scope === 'global' ? 'global' : 'clients'
      this.closeCommandEditor()
      this.notice = 'secureMcp.savedCommandSetNotice'
    } catch (error) {
      editor.error = targetCurrent() ? 'secureMcp.errorCommandSetSave' : 'secureMcp.errorCommandSetTarget'
      editor.detail = error instanceof Error ? error.message : ''
    } finally { this.updateView(() => { this.saving = false }) }
  }

  async reload(preserveError = false): Promise<void> {
    const revision = ++this.reloadRevision
    this.loading = true
    if (!preserveError) this.error = null
    this.commandSessionClosePolicy = readCommandSessionClosePolicy(this.config.store)
    try {
      const loadedProfiles = (await this.profiles.getProfiles({ includeBuiltin: false, clone: true }))
        .map(profile => resolveEffectiveProfile(profile, this.profiles))
      if (revision !== this.reloadRevision) return
      this.loadedProfiles = loadedProfiles
      const authorizedIds = readAuthorizedSshProfileIds(this.config.store, this.config)
      this.rows = buildSecureMcpSettingsRows(
        this.loadedProfiles,
        authorizedIds,
        this.authorizations.list(),
      )
      if (!this.error && hasUnpersistedRevocations(this.config)) this.error = 'secureMcp.revocationsPending'
    } catch {
      if (revision !== this.reloadRevision) return
      this.error = 'secureMcp.errorLoadProfiles'
      this.rows = []
      this.loadedProfiles = []
    } finally {
      if (revision === this.reloadRevision) this.updateView(() => { this.loading = false })
    }
  }

  async onClosePolicyChange(rawPolicy: string, select?: Pick<HTMLSelectElement, 'value'>): Promise<void> {
    if (!this.canManage || this.loading || this.saving || (rawPolicy !== 'keep' && rawPolicy !== 'after-completion')) {
      return
    }
    const previous = this.commandSessionClosePolicy
    this.saving = true
    this.error = null
    this.commandSessionClosePolicy = rawPolicy
    try {
      await persistCommandSessionClosePolicy(this.config, rawPolicy)
    } catch {
      this.commandSessionClosePolicy = previous
      this.error = 'secureMcp.errorSaveClosePolicy'
    } finally {
      this.updateView(() => { this.saving = false })
      // Native selection changes can precede Angular's binding update on a rejected save.
      if (select) {
        select.value = this.commandSessionClosePolicy
      }
    }
  }

  async onToggle(row: SecureMcpSettingsRow, selected: boolean): Promise<void> {
    if (!this.canManage) return
    if (this.saving && selected) {
      return
    }
    const previousSelected = row.selected
    this.saving = true
    this.error = null
    try {
      const current = readAuthorizedSshProfileIds(this.config.store, this.config)
      const next = selected ? [...current, row.id] : current.filter(id => id !== row.id)
      const saved = await persistAuthorizedSshProfileIds(this.config, next)
      const persisted = readAuthorizedSshProfileIds(this.config.store, this.config)
      if (JSON.stringify(saved) !== JSON.stringify(persisted)) {
        throw new Error('authorized profile whitelist did not persist in Tabby config store')
      }
      this.rows = buildSecureMcpSettingsRows(
        this.loadedProfiles,
        persisted,
        this.authorizations.list(),
      )
      if (!selected && this.runtime) {
        for (const client of this.clients) {
          try { await this.runtime.credentials.setConnectionPermission(client, row.id, null) }
          catch { this.error = 'secureMcp.errorClearProfileMemory' }
        }
      }
    } catch {
      row.selected = previousSelected
      this.error = 'secureMcp.errorSaveProfiles'
      await this.reload(true)
    } finally {
      this.updateView(() => { this.saving = false })
    }
  }

  async onTierChange(row: SecureMcpSettingsRow, rawTier: string): Promise<void> {
    if (!this.canManage) return
    if (!isGrantedOperationTier(rawTier) || !row.selected || this.saving) {
      return
    }
    if (row.grantStale) {
      this.error = 'secureMcp.errorStaleTier'
      return
    }
    await this.saveManagedGrant(row, { openSession: row.openSession, operationTier: rawTier })
  }

  async onRevokeOpen(row: SecureMcpSettingsRow): Promise<void> {
    if (!this.canManage) return
    if (!row.selected) {
      return
    }
    try {
      await this.authorizations.revokeOpen(row.id)
      await this.reload()
    } catch {
      this.error = 'secureMcp.errorRevokeOpen'
      await this.reload(true)
    }
  }

  async onRefreshGrant(row: SecureMcpSettingsRow): Promise<void> {
    if (!this.canManage) return
    if (!row.selected || this.saving) {
      return
    }
    await this.saveManagedGrant(row, { openSession: row.openSession, operationTier: row.operationTier })
  }

  private async saveManagedGrant(
    row: SecureMcpSettingsRow,
    update: { openSession: boolean; operationTier: GrantedOperationTier },
  ): Promise<void> {
    const profile = this.loadedProfiles.find(candidate => candidate.id === row.id)
    if (!profile) {
      this.error = 'secureMcp.errorProfileMissing'
      await this.reload(true)
      return
    }
    this.saving = true
    this.error = null
    try {
      const raw = (await this.profiles.getProfiles({ includeBuiltin: false, clone: true })).find(item => item.id === row.id)
      if (!raw) throw new Error('profile unavailable')
      const fresh = resolveEffectiveProfile(raw, this.profiles)
      if (stableProfileDigest(fresh) !== stableProfileDigest(profile)) {
        this.error = 'secureMcp.errorProfileChanged'
        await this.reload(true)
        return
      }
      await this.authorizations.setManagedGrant(row.id, fresh, update)
      const saved = this.authorizations.effectiveGrant(row.id, stableProfileDigest(fresh))
      if (saved.openSession !== update.openSession || saved.operationTier !== update.operationTier) {
        throw new Error('operation grant did not persist')
      }
      await this.reload(true)
    } catch {
      this.error = 'secureMcp.errorSaveGrant'
      await this.reload(true)
    } finally {
      this.updateView(() => { this.saving = false })
    }
  }
}
