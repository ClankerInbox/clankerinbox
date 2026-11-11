// Cloudflare: a Worker on the user's own account (template in cloudflare/) receives
// mail through Email Routing, keeps it in D1, and sends through Email Service. This
// adapter talks to that Worker's HTTP API. An inbox is listed by its address.

import { type Config, type InboxConfig, keyOrigin } from './config.ts'
import type { CallOptions, Check, Env, Mail, OutgoingMail, Provider } from './provider.ts'
import { plusTagOf } from './provider.ts'
import { parseMail } from './mime.ts'
import { trustedDmarc } from './auth-results.ts'
import { ClankerError, fetchWithin, kindOfStatus, retryAfterSeconds } from './errors.ts'
import { WORKER_VERSION } from '../cloudflare/worker.ts'

const REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_RETENTION_HOURS = 168
// Pages of /inbound in one listing. A listing that stops early is still correct: pages come
// oldest first, and the caller asks again from the oldest mail it has not read.
const MAX_PAGES = 50
const SIZE_HEADER = 'x-clankerinbox-size'

export interface CloudflareConfig {
  // The deployed Worker, e.g. https://clankerinbox.<account>.workers.dev
  url: string
  // Name of the env var that holds the Worker's API_TOKEN.
  tokenEnv: string
  // Whose Authentication-Results counts; Email Routing writes mx.cloudflare.net.
  trustedAuthservId?: string
  // The name of the Worker on the Cloudflare account, when it is not "clankerinbox".
  worker?: string
}

export const DEFAULT_CF_AUTHSERV_ID = 'mx.cloudflare.net'

export interface StoredMail {
  id: string
  rcpt: string
  mail_from: string | null
  auth_results: string | null
  raw_b64: string
  truncated: number
  size: number
  received_at: number
  // The Worker's order of mail stored in the same millisecond (older Workers do not send it).
  seq?: number
}

export function cloudflareMail(row: StoredMail, trusted = DEFAULT_CF_AUTHSERV_ID): Mail {
  const truncated = !!Number(row.truncated)
  const p = parseMail(Buffer.from(row.raw_b64 || '', 'base64'), truncated ? { sizeHeader: SIZE_HEADER } : {})
  const h = p.headers
  const list = (v: string | string[] | undefined) => (v == null ? [] : Array.isArray(v) ? v : [v])
  // Only the header the Worker took from Cloudflare is believed; any Authentication-Results
  // inside the raw mail could have been written by the sender.
  const dmarc = row.auth_results
    ? trustedDmarc({ 'authentication-results': row.auth_results, from: list(h.from) }, trusted)
    : null
  const mailFrom = (row.mail_from ?? '').trim().replace(/^<|>$/g, '')
  return {
    id: row.id,
    to: row.rcpt,
    from: null,
    subject: p.subject,
    // A mail that was too large keeps its text parts (or their start); attachments lost their body.
    text: p.text,
    ...(p.html ? { html: p.html } : {}),
    tag: plusTagOf(row.rcpt),
    inReplyTo: list(h['in-reply-to'])[0]?.match(/<[^>]+>/)?.[0] ?? null,
    headers: h,
    mailFrom,
    dmarc,
    attachments: p.attachments,
    receivedAt: Number.isFinite(Number(row.received_at)) ? Number(row.received_at) : null,
    ...(truncated ? { truncated: true } : {}),
  }
}

// A mail the caller has read before: only what it needs to know where the listing stands.
function knownMail(row: StoredMail): Mail {
  return {
    id: row.id, to: row.rcpt, from: null, subject: '', text: '', tag: plusTagOf(row.rcpt), inReplyTo: null, headers: {},
    dmarc: null, attachments: [], receivedAt: Number.isFinite(Number(row.received_at)) ? Number(row.received_at) : null,
  }
}

export interface Health { ok: boolean; version?: number; schema?: boolean; retentionHours?: number; problems?: string[] }

// What a recipient refused by Email Routing needs: on the free plan, mail goes only to
// verified destination addresses.
export function unverifiedAdvice(to: string[]): string {
  return `Cloudflare did not send the mail: ${to.join(', ')} is not a verified destination address. `
    + 'On the Workers Free plan, the Worker sends only to addresses verified in Email Routing. '
    + 'Verify the address at https://dash.cloudflare.com (your domain → Email → Email Routing → Destination addresses; '
    + 'Cloudflare mails a link to click), or get Workers Paid ($5 a month) to send to any address'
}

export class CloudflareProvider implements Provider {
  readonly name = 'cloudflare' as const
  config: Config
  env: Env
  private reportedRetention?: number

  constructor(config: Config, env: Env) {
    this.config = config
    this.env = env
  }

  get retentionHours(): number {
    return this.reportedRetention || this.config.retentionHours || DEFAULT_RETENTION_HOURS
  }

  private cf(): CloudflareConfig {
    const c = this.config.cloudflare
    if (!c) throw new Error('the config has no cloudflare section')
    return c
  }

  // `check`: what a real Worker answers with. A 2xx with anything else (another site at a
  // wrong URL) is an error, never "sent" or "no mail".
  private async call<T>(method: string, path: string, body: unknown, check: (data: any) => boolean, opts: CallOptions = {}): Promise<T> {
    const c = this.cf()
    const token = this.env[c.tokenEnv]
    if (!token) throw new ClankerError('config', `no Worker token: set ${c.tokenEnv}`)
    const base = c.url.replace(/\/+$/, '')
    const res = await fetchWithin(base + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }, Math.min(opts.timeoutMs ?? REQUEST_TIMEOUT_MS, REQUEST_TIMEOUT_MS))
    let text = ''
    try {
      text = await res.text()
    } catch (e: any) {
      throw new ClankerError('unavailable', `${base} stopped in the middle of its answer (${e?.message || e})`)
    }
    let data: any = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = undefined
    }
    if (!res.ok) {
      const detail = data?.message || data?.error || text.slice(0, 200).replace(/\s+/g, ' ')
      // The Worker refuses a sender other than its own with 403: that is the config, not the token.
      if (data?.error === 'from_not_allowed') {
        throw new ClankerError('config', `${detail}. Set "from" in the config to that address (the SENDER of the Worker)`, { status: res.status })
      }
      const hint = res.status === 401 || res.status === 403 ? `. The Worker did not accept the token in ${c.tokenEnv}: check that token` : ''
      throw Object.assign(new ClankerError(kindOfStatus(res.status), `Cloudflare Worker ${method} ${path.replace(/\?.*/, '')}: ${res.status} ${detail}${hint}`, {
        status: res.status, retryAfter: retryAfterSeconds(res.headers.get('retry-after')),
      }), { workerError: typeof data?.error === 'string' ? data.error : undefined })
    }
    if (!data || typeof data !== 'object' || !check(data)) {
      throw new ClankerError('config', `${base} did not answer like a clankerinbox Worker: check the URL (cloudflare.url in the config)`)
    }
    return data as T
  }

  async send(mail: OutgoingMail, opts: CallOptions = {}): Promise<{ messageId: string | null }> {
    // The Worker reports `messageId: null, sent: true` when Email Service gave no Message-ID:
    // the mail still went out.
    const res = await this.call<{ messageId: string | null }>('POST', '/send', {
      from: mail.from,
      to: mail.to,
      replyTo: mail.replyTo,
      subject: mail.subject,
      text: mail.text,
      ...(mail.html ? { html: mail.html } : {}),
      headers: mail.headers,
    }, (d) => (typeof d.messageId === 'string' && d.messageId !== '') || (d.messageId === null && (d as any).sent === true), opts).catch((e) => {
      if (e instanceof ClankerError && (e as any).workerError === 'recipient_not_verified') throw new ClankerError('refused', unverifiedAdvice(mail.to), { status: e.status })
      throw e
    })
    // Email Service reports the Message-ID in angle brackets; the CLI prints ids without them.
    return { messageId: res.messageId ? res.messageId.trim().replace(/^<|>$/g, '') || null : null }
  }

  checks(): Check[] {
    const tokenEnv = this.cf().tokenEnv
    let health: Health | undefined
    return [
      {
        label: this.env[tokenEnv] ? `Token found: ${tokenEnv} ${keyOrigin(this.env, tokenEnv)}` : `Token found in ${tokenEnv}`,
        run: async () => { if (!this.env[tokenEnv]) throw new Error('not set') },
      },
      {
        label: `Worker answers (${this.cf().url})`,
        run: async () => { health = await this.call<Health>('GET', '/health', undefined, (d) => typeof d.ok === 'boolean') },
      },
      {
        label: 'Worker is ready (database, settings, version)',
        run: async () => {
          const h = health || await this.call<Health>('GET', '/health', undefined, (d) => typeof d.ok === 'boolean')
          if (!h.ok) throw new Error((Array.isArray(h.problems) && h.problems.length ? h.problems : ['the Worker reports a problem']).join('; '))
          const version = Number(h.version)
          if (!(version >= WORKER_VERSION)) {
            return { warn: `the Worker runs older code (version ${Number.isFinite(version) ? version : 1}; this CLI has version ${WORKER_VERSION}). Run clankerinbox setup to update the Worker` }
          }
        },
      },
    ]
  }

  // All mail of the address since `opts.since`, oldest page first; each page stays small, so
  // a flood of mail never hides the oldest one. Returned newest first, like every provider.
  async listInbound(inbox: InboxConfig, opts: CallOptions = {}): Promise<Mail[]> {
    const started = Date.now()
    const rows: StoredMail[] = []
    const seen = new Set<string>()
    let after: string | null = null
    for (let page = 0; page < MAX_PAGES; page++) {
      const q = new URLSearchParams({ address: inbox.address, since: String(Math.max(0, Math.floor(opts.since ?? 0))) })
      if (after) q.set('after', after)
      const data = await this.call<{ messages: StoredMail[]; retentionHours?: number; more?: boolean; next?: string | null }>(
        'GET', `/inbound?${q}`, undefined, (d) => Array.isArray(d.messages), opts)
      // A Worker that says how long it keeps mail sets how long processed ids are kept.
      const hours = Number(data.retentionHours)
      if (Number.isFinite(hours) && hours > 0) this.reportedRetention = hours
      for (const r of data.messages) {
        if (r && typeof r.id === 'string' && r.id && !seen.has(r.id)) {
          seen.add(r.id)
          rows.push(r)
        }
      }
      if (data.more !== true || typeof data.next !== 'string' || data.next === after) break
      if (opts.timeoutMs !== undefined && Date.now() - started > opts.timeoutMs) break
      after = data.next
    }
    // An older Worker answers newest first; the order is set here either way.
    rows.sort((a, b) => Number(b.received_at) - Number(a.received_at) || Number(b.seq ?? 0) - Number(a.seq ?? 0))
    const trusted = this.cf().trustedAuthservId || DEFAULT_CF_AUTHSERV_ID
    const out: Mail[] = []
    for (const r of rows) {
      if (opts.known?.(r.id)) {
        out.push(knownMail(r))
        continue
      }
      // A mail that cannot be parsed is left out, so one hostile mail cannot stop every poll.
      try {
        out.push(cloudflareMail(r, trusted))
      } catch { /* skipped */ }
    }
    return out
  }
}
