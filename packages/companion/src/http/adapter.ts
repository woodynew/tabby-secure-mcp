import type { IncomingMessage, ServerResponse } from 'node:http'

export class HttpInputError extends Error {
  constructor(readonly status: number) { super('Invalid HTTP request') }
}

export function jsonResponse(res: ServerResponse, status: number, message: string): void {
  if (res.destroyed || res.writableEnded) return
  res.writeHead(status, { 'Content-Type': 'application/json', 'Connection': 'close' })
  res.end(JSON.stringify({ error: message }))
}

export async function readJson(req: IncomingMessage, signal: AbortSignal): Promise<Record<string, unknown>> {
  const length = req.headers['content-length']
  if (length && Number(length) > 65_536) throw new HttpInputError(413)
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const finish = (error?: HttpInputError) => {
      clearTimeout(timer)
      req.off('data', data); req.off('end', end); req.off('error', fail); req.off('aborted', fail)
      signal.removeEventListener('abort', fail)
      if (error) { req.pause(); reject(error) } else resolve(Buffer.concat(chunks))
    }
    const fail = () => finish(new HttpInputError(400))
    const data = (chunk: Buffer) => {
      size += chunk.length
      if (size > 65_536) finish(new HttpInputError(413))
      else chunks.push(chunk)
    }
    const end = () => finish()
    const timer = setTimeout(() => finish(new HttpInputError(408)), 10_000)
    timer.unref?.()
    req.on('data', data); req.once('end', end); req.once('error', fail); req.once('aborted', fail)
    signal.addEventListener('abort', fail, { once: true })
    if (signal.aborted) fail()
  })
  let body: unknown
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { throw new HttpInputError(400) }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpInputError(400)
  function validate(value: unknown, depth: number): void {
    if (typeof value === 'string' && Buffer.byteLength(value, 'utf8') > 8192) throw new HttpInputError(413)
    if (value && typeof value === 'object') {
      if (depth > 16) throw new HttpInputError(400)
      for (const [key, child] of Object.entries(value)) { validate(key, depth); validate(child, depth + 1) }
    }
  }
  validate(body, 1)
  return body as Record<string, unknown>
}

export async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  if (res.destroyed || res.writableEnded) return
  if (response.status >= 400) { jsonResponse(res, response.status, 'Invalid MCP request'); return }
  if (response.body && !response.headers.get('content-type')?.includes('application/json')) {
    await response.body.cancel()
    jsonResponse(res, 500, 'Invalid MCP response')
    return
  }
  const body = await response.text()
  if (res.destroyed || res.writableEnded) return
  response.headers.forEach((value, key) => res.setHeader(key, value))
  res.statusCode = response.status
  res.end(body)
}
