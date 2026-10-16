import { kill } from 'node:process'

export type ProcessLivenessProbe = (pid: number) => boolean

export function defaultProcessLivenessProbe(pid: number): boolean {
  try {
    kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') {
      return false
    }
    return true
  }
}
