import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const SRC_ROOT = resolve(import.meta.dirname, '../src')

function readProductionSources(): string {
  const files = [
    'index.ts',
    'approval/approval-deadline.ts',
    'approval/approval-gatekeeper.ts',
    'approval/approval-presenter.ts',
    'approval/approval-scheduler.ts',
    'approval/ng-bootstrap-approval-presenter.ts',
    'approval/profile-security-snapshot.ts',
    'approval/display-sanitizer.ts',
    'approval/open-approval-modal.component.ts',
    'approval/pairing-approval-modal.component.ts',
    'authorization/operation-tier-policy.ts',
    'authorization/permanent-authorization-store.ts',
    'services/authorized-profiles.service.ts',
    'runtime/plugin-runtime-service.ts',
    'audit/audit-service.ts',
  ]
  return files.map(file => readFileSync(resolve(SRC_ROOT, file), 'utf8')).join('\n')
}

describe('approval production capability guard', () => {
  it('does not reference sendInput, terminal output streams, or arbitrary command APIs', () => {
    const source = readProductionSources()
    expect(source).not.toMatch(/\bsendInput\b/)
    expect(source).not.toMatch(/\boutput\$\b/)
    expect(source).not.toMatch(/\bbinaryOutput\$\b/)
    expect(source).not.toMatch(/\bconnect_and_run_command\b/)
    expect(source).not.toMatch(/\brunCommand\b/)
  })
})
