import { ApprovalGatekeeper as ProductionGatekeeper } from '../../src/approval/approval-gatekeeper'
import type { ClientConnectionContext } from '../../src/approval/approval-gatekeeper'
export { APPROVAL_WINDOW_MS } from '../../src/approval/approval-gatekeeper'

export class ApprovalGatekeeper extends ProductionGatekeeper {
  private readonly testConnection: ClientConnectionContext
  constructor(...args: ConstructorParameters<typeof ProductionGatekeeper>) {
    super(args[0], args[1], args[2], args[3], args[4], args[5], args[6], args[7] ?? {
      audit: { append: async () => undefined },
      closeTab: async () => undefined,
    }, args[8])
    // Existing single-client fixtures use their memory as that client's connection store.
    this.testConnection = {
      client: { id: 'fixture-client', name: 'Fixture client', generation: 1 }, revision: 0, isCurrent: () => true,
      permissions: {
        connectionGrants: () => [], connectionRevision: () => 0,
        hasConnectionPermission: (_client, id, digest) => args[6]?.effectiveGrant(id, digest).openSession ?? false,
        setConnectionPermission: async (_client, id, digest) => { if (digest) await args[6]?.rememberOpen(id, digest) },
      },
    }
  }

  override requestOpen(request: Parameters<ProductionGatekeeper['requestOpen']>[0]) {
    return super.requestOpen({ ...request, connection: request.connection ?? this.testConnection })
  }
  override runAuthorizedSshCommand(request: Parameters<ProductionGatekeeper['runAuthorizedSshCommand']>[0]) {
    return super.runAuthorizedSshCommand({ ...request, connection: request.connection ?? this.testConnection })
  }
  override describeOperationAuthorization(profileRef: string, connection = this.testConnection) {
    return super.describeOperationAuthorization(profileRef, connection)
  }
}
