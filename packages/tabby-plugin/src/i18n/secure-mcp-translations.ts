import { Inject, Injectable, OnDestroy } from '@angular/core'
import { Subscription } from 'rxjs'
import { ConfigService, LocaleService, TranslateService } from 'tabby-core'

import { translationsForLocale } from './messages'

@Injectable()
export class SecureMcpTranslations implements OnDestroy {
  private readonly subscriptions = new Subscription()

  constructor(
    @Inject(ConfigService) config: ConfigService,
    @Inject(LocaleService) locale: LocaleService,
    @Inject(TranslateService) translate: TranslateService,
  ) {
    this.subscriptions.add(config.ready$.subscribe(() => {
      const register = (language: string): void => {
        translate.setTranslation(language, translationsForLocale(language), true)
      }
      // Tabby loads a new catalog before emitting its default-language change.
      this.subscriptions.add(translate.onTranslationChange.subscribe(
        (event: { lang: string; translations: Record<string, unknown> }) => {
          if (!event.translations.secureMcp) {
            register(event.lang)
          }
        },
      ))
      // Pre-registering languages would make Tabby skip loading its own catalogs.
      register(locale.getLocale())
      this.subscriptions.add(locale.localeChanged$.subscribe(register))
    }))
  }

  ngOnDestroy(): void {
    this.subscriptions.unsubscribe()
  }
}
