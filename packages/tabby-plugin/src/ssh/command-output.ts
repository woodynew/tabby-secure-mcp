import { Buffer } from 'node:buffer'

export class CommandOutputCollector {
  output = ''
  truncated = false
  complete = false
  private started = false
  private record: string | null = null
  private ansi: 'text' | 'escape' | 'csi' | 'osc' | 'osc_escape' = 'text'
  private ansiBytes = 0
  private outputBytes = 0

  constructor(private readonly nonce: string, private readonly limit: number) {
    if (!/^[0-9a-f]{1,64}$/.test(nonce)) throw new Error('invalid command marker')
  }

  push(chunk: string): void {
    for (const char of chunk) {
      if (this.complete || this.truncated) return
      if (char === '\u001e') {
        if (this.started && this.record !== null) for (const pending of this.record) this.appendText(pending)
        this.record = ''
        continue
      }
      if (this.record !== null) {
        if (char === '\u001f') {
          if (this.record === `${this.nonce}:start`) this.started = true
          else if (this.started && this.record === `${this.nonce}:end`) this.complete = true
          else if (this.started) for (const pending of this.record) this.appendText(pending)
          this.record = null
        } else {
          if (Buffer.byteLength(this.record, 'utf8') + Buffer.byteLength(char, 'utf8') > 128) this.truncated = true
          else this.record += char
        }
        continue
      }
      if (!this.started) continue
      this.appendText(char)
    }
  }

  private appendText(char: string): void {
    if (this.truncated) return
    if (this.ansi !== 'text') {
      this.ansiBytes += Buffer.byteLength(char, 'utf8')
      if (this.ansiBytes > 256) { this.truncated = true; return }
      if (this.ansi === 'escape') {
        this.ansi = char === '[' ? 'csi' : char === ']' ? 'osc' : 'text'
      } else if (this.ansi === 'csi') {
        if (char >= '@' && char <= '~') this.ansi = 'text'
      } else if (this.ansi === 'osc') {
        if (char === '\u0007') this.ansi = 'text'
        else if (char === '\u001b') this.ansi = 'osc_escape'
      } else {
        this.ansi = char === '\\' ? 'text' : 'osc'
      }
      return
    }
    if (char === '\u001b') { this.ansi = 'escape'; this.ansiBytes = 1; return }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(char)) return
    const bytes = Buffer.byteLength(char, 'utf8')
    if (this.outputBytes + bytes > this.limit) { this.truncated = true; return }
    this.output += char
    this.outputBytes += bytes
  }
}
