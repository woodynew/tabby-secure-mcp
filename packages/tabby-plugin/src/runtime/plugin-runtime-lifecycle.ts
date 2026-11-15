import { Inject, Injectable, OnDestroy } from '@angular/core'

import { PluginHttpRuntime } from './plugin-http-runtime'

@Injectable()
export class PluginRuntimeLifecycle implements OnDestroy {
  constructor(@Inject(PluginHttpRuntime) private readonly runtime: PluginHttpRuntime) {
    void this.runtime.start()
  }

  ngOnDestroy(): void {
    this.runtime.destroy()
  }
}
