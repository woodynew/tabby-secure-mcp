export class ConcurrencyLimiter {
  constructor(private readonly maxConcurrent: number) {}

  private active = 0

  tryAcquire(): (() => void) | undefined {
    if (this.active >= this.maxConcurrent) {
      return undefined
    }
    this.active += 1
    return () => {
      this.active = Math.max(0, this.active - 1)
    }
  }
}
