// Talking to the bridge over its Unix socket.
import { request } from 'node:http'
import { SOCKET_PATH } from './config.ts'

export type BridgeReply = { status: number; body: Record<string, unknown> }

export function bridge(method: 'GET' | 'POST', path: string, timeoutMs: number, body?: unknown): Promise<BridgeReply> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = request(
      {
        socketPath: SOCKET_PATH,
        path,
        method,
        timeout: timeoutMs,
        headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {},
      },
      res => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
          } catch (err) {
            reject(err)
          }
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end(payload)
  })
}
