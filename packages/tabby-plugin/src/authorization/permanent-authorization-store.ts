import { Inject, Injectable } from '@angular/core'
import { ConfigService, type PartialProfile, type Profile } from 'tabby-core'

import { stableProfileDigest } from '../approval/profile-security-snapshot'
import {
  effectivePermanentAuthorization,
  authorizationRevision,
  storedPermanentAuthorizations,
  updateSecureMcpConfig,
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
  revision?(): number
}

@Injectable()
export class PermanentAuthorizationStore implements AuthorizationMemory {
  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  revision(): number {
    return authorizationRevision(this.config.store, this.config)
  }

  list(): StoredPermanentAuthorization[] {
    return readPermanentAuthorizations(this.config.store, this.config)
  }

  effectiveGrant(profileId: string, profileDigest: string): EffectiveGrant {
    const grant = this.list().find((item) => item.profileId === profileId)
    return effectivePermanentAuthorization(grant, profileDigest)
  }

  async rememberOpen(profileId: string, profileDigest: string): Promise<void> {
    await this.change(profileId, current => {
      const existing = current.find(item => item.profileId === profileId)
      const digestChanged = existing !== undefined && existing.profileDigest !== profileDigest
      return {
      profileId,
      openSession: true,
      operationTier: digestChanged ? 'none' : existing?.operationTier ?? 'none',
      profileDigest,
      updatedAt: new Date().toISOString(),
      }
    })
  }

  async setManagedGrant(
    profileId: string,
    profile: PartialProfile<Profile>,
    update: { openSession: boolean; operationTier: GrantedOperationTier },
  ): Promise<void> {
    const previous = storedPermanentAuthorizations(this.config.store, this.config).find(item => item.profileId === profileId)
    const rank = { none: 0, readonly: 1, readwrite: 2, full: 3 }
    const revokes = !!previous && ((previous.openSession && !update.openSession) || rank[update.operationTier] < rank[previous.operationTier])
    await this.change(profileId, () => !update.openSession && update.operationTier === 'none' ? undefined : ({
      profileId,
      openSession: update.openSession,
      operationTier: update.operationTier,
      profileDigest: stableProfileDigest(profile),
      updatedAt: new Date().toISOString(),
    }), revokes)
  }

  async revokeOpen(profileId: string): Promise<void> {
    const confirmed = storedPermanentAuthorizations(this.config.store, this.config).find(item => item.profileId === profileId)
    await this.change(profileId, current => {
      const old = current.find(item => item.profileId === profileId) ?? confirmed
      return old && { ...old, openSession: false, updatedAt: new Date().toISOString() }
    }, true)
  }

  private async change(profileId: string, make: (current: StoredPermanentAuthorization[]) => StoredPermanentAuthorization | undefined, revokes = false): Promise<void> {
    await updateSecureMcpConfig(this.config, current => {
      const next = make(current.grants)
      const grants = current.grants.filter(item => item.profileId !== profileId)
      if (next) grants.push(next)
      return { ids: current.ids, grants }
    }, [profileId], revokes ? [profileId] : [])
  }
}
