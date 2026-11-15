import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as ng from '@angular/core'
import '@angular/compiler'
import { of, isObservable, forkJoin, concat, defer } from 'rxjs'
import { take, shareReplay, map, concatMap, switchMap } from 'rxjs/operators'

// Exercise Tabby's bundled translator, without installing a second ngx-translate version.
const require = createRequire(import.meta.url)
const sourceMap = JSON.parse(readFileSync(require.resolve('tabby-core/dist/index.js.map'), 'utf8')) as {
  sources: string[]
  sourcesContent: string[]
}
function hostSource(suffix: string): string {
  const at = sourceMap.sources.findIndex(source => source.endsWith(suffix))
  if (at < 0) {
    throw new Error('Tabby translation source not found: ' + suffix)
  }
  return sourceMap.sourcesContent[at]!
}

const { Injectable, EventEmitter, InjectionToken, Inject, Directive, Input, Pipe, NgModule } = ng
const bindings = {
  i0: ng, Injectable, EventEmitter, InjectionToken, Inject, Directive, Input, Pipe, NgModule,
  of, isObservable, forkJoin, concat, defer, take, shareReplay, map, concatMap, switchMap,
}
const source = hostSource('ngx-translate-core.mjs')
  .replace(/^import .*?;\r?$/gm, '')
  .replace(/^export \{[^}]+\};?\r?$/gm, '')
const host = new Function(...Object.keys(bindings), source + '\nreturn {' +
  'TranslateStore, TranslateService, TranslatePipe, TranslateFakeLoader,' +
  'TranslateDefaultParser, FakeMissingTranslationHandler };')(...Object.values(bindings))
const module = { exports: {} as any }
new Function('module', 'exports', hostSource('messageformat/messageformat.js'))(module, module.exports)
const MessageFormat = module.exports

export function createHostTranslator() {
  const format = new MessageFormat(['en-US', 'en-GB', 'zh-CN', 'fr-FR', 'zh-TW'])
  const compiler = {
    compile: (value: string, lang: string) => format.compile(value, lang),
    compileTranslations: (value: unknown, lang: string) => format.compile(value, lang),
  }
  const translate = new host.TranslateService(
    new host.TranslateStore(), new host.TranslateFakeLoader(), compiler,
    new host.TranslateDefaultParser(), new host.FakeMissingTranslationHandler(),
    true, false, false, undefined,
  )
  return {
    translate,
    pipe: () => new host.TranslatePipe(translate, { markForCheck() {} }),
  }
}
