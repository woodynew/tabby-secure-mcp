export class TargetUnavailableError extends Error {
  constructor() {
    super('target unavailable')
    this.name = 'TargetUnavailableError'
  }
}
