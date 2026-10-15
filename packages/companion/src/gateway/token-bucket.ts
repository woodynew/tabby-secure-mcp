export interface TokenBucketOptions {
  capacity: number
  perMinute: number
  now?: () => number
}

export class TokenBucket {
  private readonly capacity: number
  private readonly refillPerMs: number
  private readonly now: () => number
  private tokens: number
  private lastRefill: number

  constructor(options: TokenBucketOptions) {
    this.capacity = options.capacity
    this.refillPerMs = options.perMinute / 60_000
    this.now = options.now ?? (() => Date.now())
    this.tokens = this.capacity
    this.lastRefill = this.now()
  }

  tryTake(amount = 1): boolean {
    this.refill()
    if (this.tokens < amount) {
      return false
    }
    this.tokens -= amount
    return true
  }

  private refill(): void {
    const current = this.now()
    const elapsed = current - this.lastRefill
    if (elapsed <= 0) {
      return
    }
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs)
    this.lastRefill = current
  }
}
