import { Inject, Injectable } from '@angular/core'
import { ConfigService, ProfilesService, type PartialProfile, type Profile } from 'tabby-core'

import { readAuthorizedSshProfileIds } from '../config/secure-mcp-config'
import { TargetUnavailableError } from '../profiles/errors'
import { isEligibleSshProfile, readEligibleSshDisplayName } from '../profiles/profile-eligibility'
import { generateProfileRef, isProfileRef } from '../profiles/profile-ref'

export interface AuthorizedProfileView {
  profile_ref: string
  display_name: string
}

@Injectable()
export class AuthorizedProfilesService {
  private readonly refToId = new Map<string, string>()
  private readonly idToRef = new Map<string, string>()

  constructor(
    @Inject(ProfilesService) private readonly profilesService: ProfilesService,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  async listAuthorizedProfiles(): Promise<AuthorizedProfileView[]> {
    const profiles = await this.profilesService.getProfiles({ includeBuiltin: false, clone: true })
    const whitelist = new Set(readAuthorizedSshProfileIds(this.config.store))
    const eligibleById = this.indexEligibleProfiles(profiles)
    this.syncRefs(whitelist, eligibleById)

    const views: AuthorizedProfileView[] = []
    for (const id of whitelist) {
      const displayName = eligibleById.get(id)
      const profileRef = this.idToRef.get(id)
      if (!displayName || !profileRef) {
        continue
      }
      views.push({ profile_ref: profileRef, display_name: displayName })
    }
    return views
  }

  clearRefCache(): void {
    this.refToId.clear()
    this.idToRef.clear()
  }

  async resolveAuthorizedProfile(profileRef: string): Promise<PartialProfile<Profile>> {
    if (!isProfileRef(profileRef)) {
      throw new TargetUnavailableError()
    }

    const profileId = this.refToId.get(profileRef)
    if (!profileId) {
      throw new TargetUnavailableError()
    }

    const profiles = await this.profilesService.getProfiles({ includeBuiltin: false, clone: true })
    const whitelist = new Set(readAuthorizedSshProfileIds(this.config.store))
    const eligibleById = this.indexEligibleProfiles(profiles)
    this.syncRefs(whitelist, eligibleById)

    if (!whitelist.has(profileId) || !eligibleById.has(profileId)) {
      throw new TargetUnavailableError()
    }

    const profile = profiles.find(candidate => candidate.id === profileId)
    if (!profile || !isEligibleSshProfile(profile)) {
      throw new TargetUnavailableError()
    }

    return profile
  }

  private indexEligibleProfiles(profiles: PartialProfile<Profile>[]): Map<string, string> {
    const eligibleById = new Map<string, string>()
    for (const profile of profiles) {
      const displayName = readEligibleSshDisplayName(profile)
      const id = profile.id
      if (!displayName || typeof id !== 'string') {
        continue
      }
      eligibleById.set(id, displayName)
    }
    return eligibleById
  }

  private syncRefs(whitelist: Set<string>, eligibleById: Map<string, string>): void {
    for (const id of whitelist) {
      if (!eligibleById.has(id)) {
        this.removeRefForId(id)
        continue
      }
      if (!this.idToRef.has(id)) {
        const profileRef = generateProfileRef()
        this.idToRef.set(id, profileRef)
        this.refToId.set(profileRef, id)
      }
    }

    for (const id of [...this.idToRef.keys()]) {
      if (!whitelist.has(id) || !eligibleById.has(id)) {
        this.removeRefForId(id)
      }
    }
  }

  private removeRefForId(profileId: string): void {
    const profileRef = this.idToRef.get(profileId)
    if (profileRef) {
      this.refToId.delete(profileRef)
    }
    this.idToRef.delete(profileId)
  }
}
