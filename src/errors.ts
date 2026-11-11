// Errors that say what kind of failure they are, so a caller can tell "try again later"
// from "the setup is broken" without reading the message.

export type ErrorKind =
  | 'usage' | 'config' | 'auth' | 'not_found' | 'rate_limited' | 'unavailable' | 'cap' | 'state' | 'refused' | 'error'

// Kinds that pass by themselves: the same call can work a bit later.
const TEMPORARY = new Set<ErrorKind>(['rate_limited', 'unavailable', 'cap'])

export class ClankerError extends Error {
  kind: ErrorKind
  // Seconds after which a try again makes sense, when the service or the cap says so.
  retryAfter?: number
  // The thread of a mail that this command already sent: sending it again would send it twice.
  tag?: string
  messageId?: string | null
  sent?: boolean
  // The HTTP status, when a service answered.
  status?: number

  constructor(kind: ErrorKind, message: string, extra: { retryAfter?: number; tag?: string; messageId?: string | null; sent?: boolean; status?: number; cause?: unknown } = {}) {
    super(message, extra.cause !== undefined ? { cause: extra.cause } : undefined)
    this.kind = kind
    if (extra.retryAfter !== undefined) this.retryAfter = extra.retryAfter
    if (extra.tag !== undefined) this.tag = extra.tag
    if (extra.messageId !== undefined) this.messageId = extra.messageId
    if (extra.sent !== undefined) this.sent = extra.sent
    if (extra.status !== undefined) this.status = extra.status
  }
}

export function errorKind(e: unknown): ErrorKind {
  return e instanceof ClankerError ? e.kind : 'error'
}

export function isTemporary(e: unknown): boolean {
  return TEMPORARY.has(errorKind(e))
}

// The kind an HTTP status means. A 2xx never comes here.
export function kindOfStatus(status: number): ErrorKind {
  if (status === 401 || status === 403) return 'auth'
  if (status === 404) return 'not_found'
  if (status === 429) return 'rate_limited'
  if (status === 408 || status >= 500) return 'unavailable'
  return 'refused'
}

// Retry-After in seconds, from a number of seconds or an HTTP date; undefined when absent or odd.
export function retryAfterSeconds(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined
  const v = value.trim()
  if (/^\d+$/.test(v)) return Math.min(Number(v), 86_400)
  const t = Date.parse(v)
  if (Number.isNaN(t)) return undefined
  return Math.max(0, Math.min(Math.ceil((t - now) / 1000), 86_400))
}

// One fetch with a time limit, whose failures name the URL and the cause instead of "fetch failed".
export async function fetchWithin(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(Math.max(1, timeoutMs)) })
  } catch (e: any) {
    const shown = url.replace(/\?.*/, '')
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      throw new ClankerError('unavailable', `no answer from ${shown} after ${Math.round(timeoutMs / 1000)} s`, { cause: e })
    }
    const cause = e?.cause?.code || e?.cause?.message || e?.message || String(e)
    throw new ClankerError('unavailable', `cannot reach ${shown} (${cause})`, { cause: e })
  }
}
