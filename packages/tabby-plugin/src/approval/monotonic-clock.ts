export interface MonotonicClock {
  now(): number
}

export class SystemMonotonicClock implements MonotonicClock {
  private readonly origin = performance.now()

  now(): number {
    return this.origin + performance.now()
  }
}
