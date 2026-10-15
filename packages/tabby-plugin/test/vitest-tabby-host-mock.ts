import { vi } from 'vitest'

vi.mock('tabby-core', () => {
  class ProfilesService {
    getProfiles = async () => []
  }
  class ConfigService {
    store: Record<string, unknown> = {}
    save = async () => undefined
  }
  class ConfigProvider {}
  class BootstrapData {}
  return {
    ProfilesService,
    ConfigService,
    ConfigProvider,
    BootstrapData,
    BOOTSTRAP_DATA: 'BOOTSTRAP_DATA',
  }
})

vi.mock('@ng-bootstrap/ng-bootstrap', () => {
  class NgbModal {
    open = async () => ({ componentInstance: {}, result: Promise.resolve('deny') })
  }
  class NgbActiveModal {
    close = () => undefined
    dismiss = () => undefined
  }
  class NgbModule {}
  return { NgbModal, NgbActiveModal, NgbModule }
})
