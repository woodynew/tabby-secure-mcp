import { describe, expect, it } from 'vitest'

import { ConcurrencyLimiter } from '../src/gateway/concurrency.js'
import { TokenBucket } from '../src/gateway/token-bucket.js'

describe('TokenBucket', () => {
  it('allows burst traffic then enforces the per-minute refill rate', () => {
    let now = 0
    const bucket = new TokenBucket({ capacity: 5, perMinute: 20, now: () => now })

    for (let index = 0; index < 5; index += 1) {
      expect(bucket.tryTake()).toBe(true)
    }
    expect(bucket.tryTake()).toBe(false)

    now += 3_000
    expect(bucket.tryTake()).toBe(true)
    expect(bucket.tryTake()).toBe(false)
  })
})

describe('ConcurrencyLimiter', () => {
  it('caps concurrent work and releases slots when callers finish', () => {
    const limiter = new ConcurrencyLimiter(4)
    const releases = [
      limiter.tryAcquire(),
      limiter.tryAcquire(),
      limiter.tryAcquire(),
      limiter.tryAcquire(),
    ]
    expect(releases.every(Boolean)).toBe(true)
    expect(limiter.tryAcquire()).toBeUndefined()

    releases[0]?.()
    expect(limiter.tryAcquire()).toBeDefined()
  })
})
