export interface ApprovalScheduler {
  schedule(delayMs: number, callback: () => void): () => void
}

export class SystemApprovalScheduler implements ApprovalScheduler {
  schedule(delayMs: number, callback: () => void): () => void {
    const timer = setTimeout(callback, delayMs)
    return () => clearTimeout(timer)
  }
}

export class FakeApprovalScheduler implements ApprovalScheduler {
  private tasks: Array<{ at: number; callback: () => void; cancelled: boolean }> = []

  constructor(private readonly now: () => number) {}

  schedule(delayMs: number, callback: () => void): () => void {
    const task = {
      at: this.now() + delayMs,
      callback,
      cancelled: false,
    }
    this.tasks.push(task)
    return () => {
      task.cancelled = true
    }
  }

  flush(): void {
    const now = this.now()
    const due = this.tasks.filter(task => !task.cancelled && task.at <= now)
    this.tasks = this.tasks.filter(task => task.cancelled || task.at > now)
    for (const task of due) {
      task.callback()
    }
  }
}
