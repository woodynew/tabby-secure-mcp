import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseTemplate, TmplAstText } from '@angular/compiler'
import { AsyncSubject, Subject } from 'rxjs'
import { describe, expect, it, vi } from 'vitest'

import { SECURE_MCP_EN, SECURE_MCP_ZH_CN, translationsForLocale } from '../src/i18n/messages'
import { SecureMcpTranslations } from '../src/i18n/secure-mcp-translations'
import { secureMcpSettingsTemplate } from '../src/settings/secure-mcp-settings.template'
import { SETTINGS_OPERATION_TIER_OPTIONS } from '../src/settings/secure-mcp-settings.view-model'
import { createHostTranslator } from './tabby-translation.harness'

function harness(initialLocale = 'en-US', alreadyReady = false) {
  const ready = new AsyncSubject<boolean>()
  const changed = new Subject<string>()
  const translationChanged = new Subject<{ lang: string; translations: Record<string, unknown> }>()
  let currentLocale = initialLocale
  const catalogs: Record<string, Record<string, unknown>> = {}
  const translate = {
    onTranslationChange: translationChanged,
    setTranslation: vi.fn((lang: string, messages: Record<string, unknown>, merge: boolean) => {
      expect(merge).toBe(true)
      catalogs[lang] = { ...catalogs[lang], ...messages }
      translationChanged.next({ lang, translations: catalogs[lang]! })
    }),
  }
  const loadHostLanguage = (lang: string): void => {
    // Models Tabby's check that registered languages must already contain its own catalog.
    if (!catalogs[lang]) {
      catalogs[lang] = { hostTitle: 'Host ' + lang }
      translationChanged.next({ lang, translations: catalogs[lang]! })
    }
    currentLocale = lang
    changed.next(lang)
  }
  if (alreadyReady) {
    loadHostLanguage(initialLocale)
    ready.next(true)
    ready.complete()
  }
  const service = new SecureMcpTranslations(
    { ready$: ready } as never,
    { getLocale: () => currentLocale, localeChanged$: changed } as never,
    translate as never,
  )
  return {
    service, ready, changed, catalogs, translate, loadHostLanguage,
    finishLoading() {
      loadHostLanguage(initialLocale)
      ready.next(true)
      ready.complete()
    },
  }
}

describe('Secure MCP host translation registration', () => {
  it('refreshes open UI text, existing errors and countdowns with Tabby default-language events', () => {
    const { translate, pipe } = createHostTranslator()
    const ready = new AsyncSubject<boolean>()
    const changed = new Subject<string>()
    let current = 'en-US'
    function setLocale(lang: string): void {
      if (!translate.getLangs().includes(lang)) {
        translate.setTranslation(lang, { hostTitle: lang })
      }
      translate.setDefaultLang(lang)
      current = lang
      changed.next(lang)
    }
    setLocale('en-US')
    ready.next(true)
    ready.complete()
    const service = new SecureMcpTranslations(
      { ready$: ready } as never,
      { getLocale: () => current, localeChanged$: changed } as never,
      translate,
    )
    const title = pipe()
    const error = pipe()
    const countdown = pipe()
    const httpNotice = pipe()
    const permission = pipe()
    expect(title.transform('secureMcp.commandSessions')).toBe('Command sessions')
    expect(error.transform('secureMcp.errorLoadProfiles')).toBe('Failed to load SSH profiles.')
    expect(countdown.transform('secureMcp.timeRemaining', { seconds: 5 })).toBe('Time remaining: 5s')
    for (const lang of ['zh-CN', 'fr-FR', 'en-US', 'zh-CN']) {
      setLocale(lang)
      const zh = lang === 'zh-CN'
      expect(title.transform('secureMcp.commandSessions')).toBe(zh ? '命令会话' : 'Command sessions')
      expect(error.transform('secureMcp.errorLoadProfiles'))
        .toBe(zh ? '加载 SSH 连接失败。' : 'Failed to load SSH profiles.')
      expect(countdown.transform('secureMcp.timeRemaining', { seconds: 5 }))
        .toBe(zh ? '剩余时间：5 秒' : 'Time remaining: 5s')
      expect(httpNotice.transform('secureMcp.sessionPermissionNotice'))
        .toBe(zh ? SECURE_MCP_ZH_CN.sessionPermissionNotice : SECURE_MCP_EN.sessionPermissionNotice)
      expect(permission.transform('secureMcp.untilPermission', { expiresAt: '2026-11-16 12:00' }))
        .toBe(zh ? '有效期至 2026-11-16 12:00' : 'Until 2026-11-16 12:00')
      expect(translate.instant('hostTitle')).toBe(lang)
    }
    title.ngOnDestroy()
    error.ngOnDestroy()
    countdown.ngOnDestroy()
    httpNotice.ngOnDestroy()
    permission.ngOnDestroy()
    service.ngOnDestroy()
  })

  it('waits for the host catalog and preserves host messages when merging', () => {
    const h = harness('zh-CN')
    expect(h.translate.setTranslation).not.toHaveBeenCalled()
    h.changed.next('en-US')
    expect(h.translate.setTranslation).not.toHaveBeenCalled()
    h.finishLoading()
    expect(h.catalogs['zh-CN']).toEqual({
      hostTitle: 'Host zh-CN', secureMcp: { ...SECURE_MCP_EN, ...SECURE_MCP_ZH_CN },
    })
    expect(h.catalogs['en-US']).toBeUndefined()
    h.service.ngOnDestroy()
  })

  it('initializes when Tabby configuration was already loaded', () => {
    const h = harness('en-GB', true)
    expect(h.catalogs['en-GB']?.secureMcp).toEqual(SECURE_MCP_EN)
    h.service.ngOnDestroy()
  })

  it('does not re-merge an intact plugin catalog when another plugin adds translations', () => {
    const h = harness('en-US', true)
    h.translate.setTranslation.mockClear()
    h.translate.setTranslation('en-US', { otherPlugin: 'Hello' }, true)
    expect(h.translate.setTranslation).toHaveBeenCalledOnce()
    expect(h.catalogs['en-US']?.otherPlugin).toBe('Hello')
    expect(h.catalogs['en-US']?.secureMcp).toEqual(SECURE_MCP_EN)
    h.service.ngOnDestroy()
  })

  it('follows language changes with English fallback without pre-registering other languages', () => {
    const h = harness()
    h.finishLoading()
    h.loadHostLanguage('zh-CN')
    expect(h.catalogs['zh-CN']?.secureMcp).toEqual(SECURE_MCP_ZH_CN)
    for (const lang of ['en-GB', 'fr-FR', 'zh-TW']) {
      expect(h.catalogs[lang]).toBeUndefined()
      h.loadHostLanguage(lang)
      expect(h.catalogs[lang]).toEqual({ hostTitle: 'Host ' + lang, secureMcp: SECURE_MCP_EN })
    }
    h.service.ngOnDestroy()
    const calls = h.translate.setTranslation.mock.calls.length
    h.loadHostLanguage('zh-CN')
    expect(h.translate.setTranslation).toHaveBeenCalledTimes(calls)
  })

  it('unsubscribes even when destroyed before host initialization', () => {
    const h = harness()
    h.service.ngOnDestroy()
    h.finishLoading()
    expect(h.translate.setTranslation).not.toHaveBeenCalled()
  })
})

describe('Secure MCP bilingual UI catalogs', () => {
  it('has complete matching keys and interpolation parameters', () => {
    expect(Object.keys(SECURE_MCP_ZH_CN).sort()).toEqual(Object.keys(SECURE_MCP_EN).sort())
    for (const key of Object.keys(SECURE_MCP_EN) as Array<keyof typeof SECURE_MCP_EN>) {
      expect(SECURE_MCP_EN[key].trim()).not.toBe('')
      expect(SECURE_MCP_ZH_CN[key].trim()).not.toBe('')
      expect(SECURE_MCP_ZH_CN[key].match(/\{[^}]+\}/g) ?? [])
        .toEqual(SECURE_MCP_EN[key].match(/\{[^}]+\}/g) ?? [])
    }
    expect(translationsForLocale('zh-CN').secureMcp.commandSessions).toBe('命令会话')
    expect(translationsForLocale('de-DE').secureMcp.commandSessions).toBe('Command sessions')
  })

  it('translates every static UI text and accessibility label with existing catalog keys', () => {
    const modalTemplates = ['open-approval-modal.component.ts', 'pairing-approval-modal.component.ts']
      .map(file => readFileSync(resolve(import.meta.dirname, '../src/approval', file), 'utf8')
        .match(/template:\s*\x60([\s\S]*?)\x60/)![1]!)
    const templates = [secureMcpSettingsTemplate, ...modalTemplates]
    const keys = new Set(Object.keys(SECURE_MCP_EN).map(key => 'secureMcp.' + key))
    for (const template of templates) {
      const parsed = parseTemplate(template, 'secure-mcp-test.html')
      expect(parsed.errors).toBeNull()
      function visit(nodes: readonly any[]): void {
        for (const node of nodes) {
          if (node instanceof TmplAstText) {
            expect(node.value.trim(), 'untranslated UI text').toBe('')
          }
          for (const attribute of node.attributes ?? []) {
            expect(attribute.name).not.toBe('aria-label')
          }
          visit(node.children ?? [])
        }
      }
      visit(parsed.nodes)
      expect(template).not.toContain('[innerHTML]')
    }
    const settingsSource = readFileSync(resolve(
      import.meta.dirname, '../src/settings/secure-mcp-settings.component.ts',
    ), 'utf8')
    for (const source of [...templates, settingsSource]) {
      for (const match of source.matchAll(/'((?:secureMcp\.)[^']+)'/g)) {
        expect(keys.has(match[1]!)).toBe(true)
      }
    }
    for (const option of SETTINGS_OPERATION_TIER_OPTIONS) {
      expect(keys.has(option.labelKey)).toBe(true)
    }
  })
})
