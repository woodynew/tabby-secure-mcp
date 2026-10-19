import { Inject, Injectable } from '@angular/core'
import { ConfigService, type PartialProfile, type Profile } from 'tabby-core'

import { stableProfileDigest } from '../approval/profile-security-snapshot'
import {
  effectivePermanentAuthorization,
  persistPermanentAuthorizations,
  readPermanentAuthorizations,
  type StoredPermanentAuthorization,
} from '../config/secure-mcp-config'
import type { GrantedOperationTier } from './operation-tier-policy'

export interface EffectiveGrant {
  openSession: boolean
  operationTier: GrantedOperationTier
}

export interface AuthorizationMemory {
  effectiveGrant(profileId: string, profileDigest: string): EffectiveGrant
  rememberOpen(profileId: string, profileDigest: string): Promise<void>
}

@Injectable()
export class PermanentAuthorizationStore implements AuthorizationMemory {
  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  list(): StoredPermanentAuthorization[] {
    return readPermanentAuthorizations(this.config.store)
  }

  effectiveGrant(profileId: string, profileDigest: string): EffectiveGrant {
    const grant = this.list().find((item) => item.profileId === profileId)
    return effectivePermanentAuthorization(grant, profileDigest)
  }

  async rememberOpen(profileId: string, profileDigest: string): Promise<void> {
    const current = this.list()
    const existing = current.find((item) => item.profileId === profileId)
    const digestChanged = existing !== undefined && existing.profileDigest !== profileDigest
    await this.replace({
      profileId,
      openSession: true,
      operationTier: digestChanged ? 'none' : existing?.operationTier ?? 'none',
      profileDigest,
      updatedAt: new Date().toISOString(),
    })
  }

  async setManagedGrant(
    profileId: string,
    profile: PartialProfile<Profile>,
    update: { openSession: boolean; operationTier: GrantedOperationTier },
  ): Promise<void> {
    if (!update.openSession && update.operationTier === 'none') {
      await persistPermanentAuthorizations(
        this.config,
        this.list().filter((item) => item.profileId !== profileId),
      )
      return
    }
    await this.replace({
      profileId,
      openSession: update.openSession,
      operationTier: update.operationTier,
      profileDigest: stableProfileDigest(profile),
      updatedAt: new Date().toISOString(),
    })
  }

  private async replace(next: StoredPermanentAuthorization): Promise<void> {
    const others = this.list().filter((item) => item.profileId !== next.profileId)
    await persistPermanentAuthorizations(this.config, [...others, next])
  }
}
