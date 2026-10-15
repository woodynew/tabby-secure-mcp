import { Injectable } from '@angular/core'

@Injectable()
export class RuntimeLeaseState {
  private leaseEpoch: number | null = null

  getLeaseEpoch(): number | null {
    return this.leaseEpoch
  }

  grant(epoch: number): void {
    this.leaseEpoch = epoch
  }

  clear(): void {
    this.leaseEpoch = null
  }
}
