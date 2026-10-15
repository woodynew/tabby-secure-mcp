import { Inject, Injectable, OnDestroy } from '@angular/core'

import { PluginRuntimeService } from './plugin-runtime-service'

@Injectable()
export class PluginRuntimeLifecycle implements OnDestroy {
  constructor(@Inject(PluginRuntimeService) private readonly runtime: PluginRuntimeService) {
    this.runtime.start()
  }

  ngOnDestroy(): void {
    this.runtime.destroy()
  }
}
