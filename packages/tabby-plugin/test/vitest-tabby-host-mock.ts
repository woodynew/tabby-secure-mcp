import { vi } from 'vitest'

vi.mock('@tabby-secure-mcp/companion', () => ({ APPROVAL_WINDOW_MS: 60_000, CredentialStore: class {}, EmbeddedMcpServer: class {} }))

vi.mock('tabby-core', () => {
  class ProfilesService {
    getProfiles = async () => []
  }
  class AppService { closeTab = async () => undefined }
  class HostWindowService { bringToFront() {} }
  class ConfigService {
    store: Record<string, unknown> = {}
    save = async () => undefined
  }
  class ConfigProvider {}
  class BootstrapData {}
  return {
    ProfilesService,
    AppService,
    HostWindowService,
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
