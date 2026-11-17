import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseTemplate } from '@angular/compiler'
import { describe, expect, it, vi } from 'vitest'
import { analyzeSshCommand } from '../../ipc-contract/src/command-policy'
import * as approval from '../src/approval/approval-presenter'
import { NgBootstrapApprovalPresenter } from '../src/approval/ng-bootstrap-approval-presenter'
import { OpenApprovalModalComponent } from '../src/approval/open-approval-modal.component'
import { translationsForLocale } from '../src/i18n/messages'
import { createHostTranslator } from './tabby-translation.harness'

const reasons = [
  ['docker ps', 'Recognized query with validated arguments.', '已识别的查询，参数已通过校验。'],
  ['touch project/file', 'Constrained relative write paths; remote symlinks are not resolved.', '写入路径限定为相对路径；不会解析远程符号链接。'],
  ['touch /etc/file', 'Write path is sensitive or cannot be screened lexically.', '写入路径敏感，或无法通过静态路径检查。'],
  ['cp a b', 'May overwrite files or remove source paths.', '可能覆盖文件或移除源路径。'],
  ['rm file', 'Recognized state-changing operation.', '已识别的状态变更操作。'],
  ['custom argument', 'Unrecognized program or arguments; approval required.', '无法识别程序或参数，需要批准。'],
] as const

describe('dynamic command approval localization', () => {
  it.each([
    [true, true, true],
    [true, false, false],
    [false, true, false],
    [false, false, false],
  ])('remembers only when commandMode=%s and allowRemember=%s', (commandMode, allowRemember, permitted) => {
    const close = vi.fn()
    const component = new OpenApprovalModalComponent({ close } as never)
    component.commandMode = commandMode
    component.allowRemember = allowRemember
    component.remember()
    expect(close.mock.calls).toEqual(permitted ? [['remember']] : [])
  })

  it.each([false, true])('keeps the ordinary allow decision for commandMode=%s', commandMode => {
    const close = vi.fn()
    const component = new OpenApprovalModalComponent({ close } as never)
    component.commandMode = commandMode
    component.allow()
    expect(close).toHaveBeenCalledExactlyOnceWith('allow')
  })

  it.each([
    ['allowAndRemember', 'Always allow (add to command set)', '永久允许（加入审批命令集）'],
    ['allowConnection', 'Always allow this SSH connection', '永久允许此 SSH 连接'],
    ['commandRememberLocalHelp',
      'Permanently saves the matching scope shown above only to the command set for this client and this SSH profile. Other clients and SSH profiles are unchanged.',
      '将上述匹配范围永久保存到当前客户端与此 SSH 配置的审批命令集，不影响其他客户端或 SSH 连接。'],
  ])('updates %s through the host translator with English fallback', (key, english, chinese) => {
    const { translate, pipe } = createHostTranslator()
    const text = pipe()
    for (const locale of ['en-US', 'zh-CN', 'fr-FR', 'zh-CN']) {
      translate.setTranslation(locale, translationsForLocale(locale))
      translate.setDefaultLang(locale)
      expect(text.transform('secureMcp.' + key)).toBe(locale === 'zh-CN' ? chinese : english)
    }
    text.ngOnDestroy()
  })

  it.each(['docker ps', "custom '原始参数 <tag> {seconds}'"])('passes structured details and the raw command unchanged to the modal for %s', async rawCommand => {
    const analysis = analyzeSshCommand(rawCommand)!
    const componentInstance = new OpenApprovalModalComponent({} as never)
    const modal = { open: () => ({ componentInstance, result: Promise.resolve('remember'), dismiss() {} }) }
    const presenter = new NgBootstrapApprovalPresenter(modal as never)
    const details = approval.buildCommandApprovalDetails(analysis)
    vi.stubGlobal('window', { setInterval: () => 1, clearInterval() {} })
    try {
      expect(await presenter.presentCommand({
        clientIdentity: 'Agent', toolName: 'ssh_command', targetDisplayName: 'Target',
        operationDisplay: rawCommand, remainingSeconds: 30, risk: analysis.risk,
        ...details, allowRemember: true, approveConnection: false,
      }, {
        signal: new AbortController().signal, deadlineMonotonicMs: performance.now() + 30_000,
        remainingSeconds: () => 30,
      })).toBe('remember')
      expect(componentInstance).toMatchObject({ ...details, operationDisplay: rawCommand, commandMode: true })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps rule text and full exact fingerprints literal, independent of the legacy English reason', () => {
    expect(approval.buildCommandApprovalDetails).toBeTypeOf('function')
    const family = analyzeSshCommand('docker ps')!
    expect(approval.buildCommandApprovalDetails({ ...family, reason: 'Changed API wording' })).toEqual({
      riskReasonKey: 'secureMcp.commandReason_query', ruleKind: 'family', ruleText: 'docker ps', ruleFingerprint: '',
    })
    const exact = analyzeSshCommand("custom '原始参数 <tag> {seconds}'")!
    const snapshot = structuredClone(exact)
    expect(approval.buildCommandApprovalDetails(exact)).toEqual({
      riskReasonKey: 'secureMcp.commandReason_unknown', ruleKind: 'exact', ruleText: 'custom',
      ruleFingerprint: exact.rule.kind === 'exact' ? exact.rule.hash : '',
    })
    expect(exact).toEqual(snapshot)
  })

  it('binds dynamic reasons and scope labels to translate pipes while leaving command and hash literal', () => {
    const source = readFileSync(resolve(import.meta.dirname, '../src/approval/open-approval-modal.component.ts'), 'utf8')
    const template = source.match(/template:\s*\x60([\s\S]*?)\x60/)![1]!
    expect(parseTemplate(template, 'command-approval.html').errors).toBeNull()
    expect(template).toMatch(/\{\{\s*riskReasonKey\s*\|\s*translate\s*\}\}/)
    expect(template).toContain("'secureMcp.commandApprovalFamilyScope'")
    expect(template).toContain("'secureMcp.commandApprovalExactScope'")
    expect(template).toContain(`<p *ngIf="commandMode && allowRemember" class="text-muted">{{ 'secureMcp.commandRememberLocalHelp' | translate }}</p>`)
    expect(template).toContain("commandMode ? 'secureMcp.allowOnce' : 'secureMcp.allowConnection'")
    for (const field of ['operationDisplay', 'ruleText', 'ruleFingerprint']) {
      expect(template).toContain('{{ ' + field + ' }}')
      expect(template).not.toMatch(new RegExp(field + '\\s*\\|\\s*translate'))
    }
  })

  it.each(reasons)('translates the risk reason for %s and updates existing pipes on language changes', (command, english, chinese) => {
    const { translate, pipe } = createHostTranslator()
    const reason = pipe()
    const key = approval.buildCommandApprovalDetails(analyzeSshCommand(command)!).riskReasonKey
    for (const locale of ['en-US', 'zh-CN', 'fr-FR', 'zh-CN']) {
      translate.setTranslation(locale, translationsForLocale(locale))
      translate.setDefaultLang(locale)
      expect(reason.transform(key)).toBe(locale === 'zh-CN' ? chinese : english)
    }
    reason.ngOnDestroy()
  })

  it.each([
    ['family', 'Arguments must pass risk validation', '参数须通过风险校验'],
    ['exact', 'Exact command fingerprint', '精确命令指纹'],
  ])('translates remembered %s approval scope on language changes', (kind, english, chinese) => {
    const { translate, pipe } = createHostTranslator()
    const scope = pipe()
    const key = kind === 'family' ? 'secureMcp.commandApprovalFamilyScope' : 'secureMcp.commandApprovalExactScope'
    for (const locale of ['en-US', 'zh-CN', 'en-US']) {
      translate.setTranslation(locale, translationsForLocale(locale))
      translate.setDefaultLang(locale)
      expect(scope.transform(key)).toBe(locale === 'zh-CN' ? chinese : english)
    }
    scope.ngOnDestroy()
  })
})
