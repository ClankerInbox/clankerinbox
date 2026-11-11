// Minimal PostShiba REST client: only the calls clankerinbox needs, and the
// provider adapter built on it. Keys are passed in and never appear in errors or logs.

import { resolveMx } from 'node:dns/promises'
import {
  type Config, type InboxConfig, postshibaApi, keyOrigin, DEFAULT_SEND_KEY_ENV, DEFAULT_READ_KEY_ENV,
} from './config.ts'
import { type Provider, type Check, type Mail, type OutgoingMail, type Env, type CallOptions, attachmentInfo } from './provider.ts'
import { htmlToText, parseHeaderBlock } from './mime.ts'
import { ClankerError, fetchWithin, kindOfStatus, retryAfterSeconds } from './errors.ts'

const DEFAULT_RETENTION_HOURS = 168

export interface InboundMessage {
  id: string
  inbox_id: string
  to: string
  from: string | null
  subject: string | null
  text: string | null
  html?: string | null
  thread_id: string | null
  in_reply_to?: string | null
  headers: Record<string, string | string[]>
  envelope?: { rcpt_to?: string; plus_tag?: string; mail_from?: string | null }
  authentication?: {
    spf?: { result?: string; domain?: string }
    dkim?: { result?: string; domain?: string; selector?: string }[]
    dmarc?: { result?: string; policy?: string; aligned?: boolean }
    arc?: { result?: string }
  }
  attachments?: unknown[]
  expires_at?: string
  // The whole mail as it arrived; only a read of one mail has it.
  raw?: string
}

export interface Inbox {
  id: string
  name?: string
  address: string
  local_part?: string
  host?: string
  // Whether the domain's MX points at PostShiba, and the record that makes it so.
  mx_status?: string
  mx_record?: string | null
  mx_target?: string | null
}

export interface SendingDomain {
  id: string
  name: string
  sending_allowed?: boolean
  dkim_status?: string
  return_path_status?: string
  dmarc_status?: string
  // The DNS records PostShiba wants for sending.
  dkim_selector?: string
  dkim_manual?: boolean
  dkim_txt?: string
  dkim_cname_host?: string
  dkim_cname_target?: string | null
  return_path_host?: string
  return_path_target?: string
  dmarc_host?: string
  dmarc_record?: string
}

export interface SendRequest {
  from: string
  to: string[]
  reply_to?: string
  subject: string
  text: string
  html?: string
  headers?: Record<string, string>
  tenant?: string
}

export interface SendResult {
  queued: boolean
  message_id?: string
}

export class PostShibaError extends ClankerError {
  // PostShiba's own error code, such as not_found.
  code?: string
  constructor(status: number, code: string | undefined, message: string, retryAfter?: number) {
    super(kindOfStatus(status), message, { status, ...(retryAfter !== undefined ? { retryAfter } : {}) })
    this.code = code
  }
}

const REQUEST_TIMEOUT_MS = 30_000

export class PostShiba {
  baseUrl: string
  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
  }

  // `expect`: the JSON shape a real PostShiba answers with. A 2xx with anything else (an HTML
  // page, a proxy's own reply) is a wrong URL, never "no mail" or "sent".
  async request<T>(
    key: string | undefined, method: string, path: string, body?: unknown,
    opts: { timeoutMs?: number; expect?: 'array' | 'object' } = {},
  ): Promise<T> {
    if (!key) throw new ClankerError('auth', 'the API key is missing')
    const res = await fetchWithin(this.baseUrl + path, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    }, Math.min(opts.timeoutMs ?? REQUEST_TIMEOUT_MS, REQUEST_TIMEOUT_MS))
    let text = ''
    try {
      text = await res.text()
    } catch (e: any) {
      throw new ClankerError('unavailable', `${this.baseUrl} stopped in the middle of its answer (${e?.message || e})`)
    }
    let data: any = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = undefined
    }
    if (!res.ok) {
      const code = data?.error
      const detail = data?.message || code || text.slice(0, 200).replace(/\s+/g, ' ')
      const retry = retryAfterSeconds(res.headers.get('retry-after'))
      throw new PostShibaError(res.status, typeof code === 'string' ? code : undefined, `PostShiba ${method} ${path.replace(/\?.*/, '')}: ${res.status} ${detail}`, retry)
    }
    const expect = opts.expect ?? 'object'
    const shaped = expect === 'array' ? Array.isArray(data) : !!data && typeof data === 'object' && !Array.isArray(data)
    if (!shaped) throw new ClankerError('config', `${this.baseUrl} did not answer like PostShiba: check the URL (apiUrl in the config, or CLANKERINBOX_POSTSHIBA_API)`)
    return data as T
  }

  send(key: string | undefined, req: SendRequest, opts: { timeoutMs?: number } = {}): Promise<SendResult> {
    return this.request<SendResult>(key, 'POST', '/emails', req, opts)
  }

  listInbound(key: string | undefined, inboxId: string, opts: { timeoutMs?: number } = {}): Promise<InboundMessage[]> {
    return this.request<InboundMessage[]>(key, 'GET', `/inboxes/${encodeURIComponent(inboxId)}/inbound_messages`, undefined, { ...opts, expect: 'array' })
  }

  getInbound(key: string | undefined, inboxId: string, id: string, opts: { timeoutMs?: number } = {}): Promise<InboundMessage> {
    return this.request<InboundMessage>(key, 'GET', `/inboxes/${encodeURIComponent(inboxId)}/inbound_messages/${encodeURIComponent(id)}`, undefined, opts)
  }

  listTeams(key: string | undefined): Promise<{ id: string; name: string }[]> {
    return this.request<{ id: string; name: string }[]>(key, 'GET', '/teams', undefined, { expect: 'array' })
  }

  listInboxes(key: string | undefined, teamId: string): Promise<Inbox[]> {
    return this.request<Inbox[]>(key, 'GET', `/teams/${encodeURIComponent(teamId)}/inboxes`, undefined, { expect: 'array' })
  }

  listSendingDomains(key: string | undefined, teamId: string): Promise<SendingDomain[]> {
    return this.request<SendingDomain[]>(key, 'GET', `/teams/${encodeURIComponent(teamId)}/sending_domains`, undefined, { expect: 'array' })
  }

  createSendingDomain(key: string | undefined, teamId: string, name: string): Promise<SendingDomain> {
    return this.request<SendingDomain>(key, 'POST', `/teams/${encodeURIComponent(teamId)}/sending_domains`, { sending_domain: { name } })
  }

  // Runs PostShiba's DNS check now and returns the statuses.
  verifySendingDomain(key: string | undefined, id: string): Promise<SendingDomain> {
    return this.request<SendingDomain>(key, 'POST', `/sending_domains/${encodeURIComponent(id)}/verify`)
  }

  getInbox(key: string | undefined, id: string): Promise<Inbox> {
    return this.request<Inbox>(key, 'GET', `/inboxes/${encodeURIComponent(id)}`)
  }

  // Asks PostShiba to look at the MX record again (a background job).
  verifyInbox(key: string | undefined, id: string): Promise<Inbox> {
    return this.request<Inbox>(key, 'POST', `/inboxes/${encodeURIComponent(id)}/verify`)
  }

  createInbox(key: string | undefined, teamId: string, inbox: { name: string; local_part: string; host: string; tenant_id?: string }): Promise<Inbox> {
    return this.request<Inbox>(key, 'POST', `/teams/${encodeURIComponent(teamId)}/inboxes`, { inbox })
  }
}

// PostShiba keeps inbound mail for the retention period and gives no received-at
// field, so the arrival time is the expiry minus that period.
export function toMail(msg: InboundMessage, retentionHours = DEFAULT_RETENTION_HOURS): Mail {
  const headers: Record<string, string | string[]> = {}
  for (const [k, v] of Object.entries(msg.headers || {})) headers[k.toLowerCase()] = v
  let receivedAt: number | null = null
  if (msg.expires_at) {
    const t = Date.parse(msg.expires_at)
    if (!Number.isNaN(t)) receivedAt = t - retentionHours * 3600_000
  }
  const d = msg.authentication?.dmarc
  return {
    id: msg.id,
    to: msg.to,
    from: msg.from ?? null,
    subject: msg.subject || '',
    // An HTML-only reply (or one whose plain part is empty) still has an answer or a code in it.
    text: msg.text?.trim() || !msg.html ? msg.text || '' : htmlToText(msg.html),
    ...(typeof msg.html === 'string' && msg.html ? { html: msg.html } : {}),
    // Tags are lowercase everywhere, as a mail system may change the case of an address.
    tag: (msg.thread_id || msg.envelope?.plus_tag || '').toLowerCase() || null,
    inReplyTo: msg.in_reply_to ?? null,
    headers,
    // Unknown when PostShiba sent no envelope; null or '' when it saw a null sender.
    mailFrom: msg.envelope ? msg.envelope.mail_from : undefined,
    dmarc: d ? { result: String(d.result ?? ''), aligned: d.aligned === true } : null,
    attachments: (Array.isArray(msg.attachments) ? msg.attachments : []).map(attachmentInfo),
    receivedAt,
  }
}

// The DNS records a sending domain still needs, as Type / Name / Value rows.
export function missingRecords(d: SendingDomain): string[][] {
  const rows: string[][] = []
  if (d.dkim_status !== 'verified') {
    if (!d.dkim_manual && d.dkim_cname_host && d.dkim_cname_target) rows.push(['CNAME', d.dkim_cname_host, d.dkim_cname_target])
    else if (d.dkim_txt) rows.push(['TXT', `${d.dkim_selector || 'ps1'}._domainkey.${d.name}`, d.dkim_txt])
  }
  if (d.return_path_status !== 'verified' && d.return_path_host && d.return_path_target) rows.push(['CNAME', d.return_path_host, d.return_path_target])
  if (d.dmarc_status !== 'verified' && d.dmarc_host && d.dmarc_record) rows.push(['TXT', d.dmarc_host, d.dmarc_record])
  return rows
}

export class PostShibaProvider implements Provider {
  readonly name = 'postshiba' as const
  client: PostShiba
  config: Config
  env: Env

  constructor(config: Config, env: Env) {
    this.config = config
    this.env = env
    this.client = new PostShiba(postshibaApi(config, env))
  }

  get retentionHours(): number {
    return this.config.retentionHours || DEFAULT_RETENTION_HOURS
  }

  private keyName(kind: 'send' | 'read'): string {
    return kind === 'send' ? this.config.sendKeyEnv || DEFAULT_SEND_KEY_ENV : this.config.readKeyEnv || DEFAULT_READ_KEY_ENV
  }

  // The env var of a key and where its value comes from, for a check line.
  private keyLabel(kind: 'send' | 'read'): string {
    const name = this.keyName(kind)
    const origin = keyOrigin(this.env, name)
    return origin === 'not set' ? name : `${name} ${origin}`
  }

  private key(kind: 'send' | 'read'): string {
    const name = this.keyName(kind)
    const key = this.env[name]
    if (!key) throw new ClankerError('config', `no ${kind === 'send' ? 'send' : 'full-access'} key: set ${name}`)
    return key
  }

  // A refused key is named by its env var, so the fix is clear without ever showing the key.
  private refused(e: unknown, kind: 'send' | 'read'): never {
    if (e instanceof PostShibaError && (e.status === 401 || e.status === 403)) {
      const what = kind === 'send' ? 'send' : 'full-access'
      e.message = `${e.message}. PostShiba did not accept the ${what} key in ${this.keyName(kind)}: check that key`
    }
    throw e
  }

  async send(mail: OutgoingMail, opts: CallOptions = {}): Promise<{ messageId: string | null }> {
    const res = await this.client.send(this.key('send'), {
      from: mail.from,
      to: mail.to,
      reply_to: mail.replyTo,
      subject: mail.subject,
      text: mail.text,
      ...(mail.html ? { html: mail.html } : {}),
      headers: mail.headers,
      ...(this.config.tenant ? { tenant: this.config.tenant } : {}),
    }, opts).catch((e) => this.refused(e, 'send'))
    if (!res || res.queued !== true) throw new ClankerError('refused', 'PostShiba did not queue the mail (possibly the recipient is on the suppression list)')
    return { messageId: res.message_id || null }
  }

  checks(): Check[] {
    const first = Object.values(this.config.inboxes)[0]
    const sender = (this.config.from.match(/@([^\s>]+)>?\s*$/)?.[1] || '').toLowerCase()
    return [
      { label: `Send key (${this.keyLabel('send')})`, run: () => this.sendKeyCheck(first) },
      {
        label: `Read mail from PostShiba (${this.keyLabel('read')})`,
        run: async () => {
          if (first) await this.listInbound(first)
        },
      },
      ...[...new Map(Object.values(this.config.inboxes).map((i) => [i.address.split('@')[1], i])).entries()].map(([host, inbox]) => ({
        label: `Mail for ${host} reaches PostShiba`,
        run: () => this.mxCheck(host, inbox.id),
      })),
      ...(sender ? [{ label: `PostShiba lets ${sender} send`, run: () => this.sendingCheck(sender) }] : []),
    ]
  }

  // Proves the send key without sending mail: an inbox read with it. PostShiba refuses a
  // Send only key there with 403 and a key it does not know with 401; a Full access key reads.
  // Any other answer proves nothing, so the key is then only present, not verified.
  private async sendKeyCheck(inbox: InboxConfig | undefined): Promise<void | { warn: string }> {
    const key = this.key('send')
    if (!inbox) return { warn: 'present, not verified (the config has no inbox to test it with)' }
    try {
      await this.client.listInbound(key, inbox.id, { timeoutMs: 10_000 })
    } catch (e) {
      if (e instanceof PostShibaError && e.status === 403) return
      if (e instanceof PostShibaError && e.status === 401) {
        throw new ClankerError('auth', `PostShiba did not accept the key in ${this.keyName('send')} (401)`, { status: 401 })
      }
      return { warn: `present, not verified (${(e as Error)?.message || e})` }
    }
  }

  // The domain of the sender must be verified on PostShiba, or no mail goes out. PostShiba's
  // DNS check runs again when it is not, as setup does.
  private async sendingCheck(domain: string): Promise<void | { warn: string }> {
    const key = this.key('read')
    const all = await this.client.listSendingDomains(key, this.config.teamId)
    let d = all.find((x) => x && x.name?.toLowerCase() === domain)
    if (!d) throw new ClankerError('config', `the team ${this.config.teamId} has no sending domain ${domain}. Add it in PostShiba (Domains → Add domain), or run setup`)
    if (d.sending_allowed === false) d = await this.client.verifySendingDomain(key, d.id).catch(() => d!)
    if (d.sending_allowed === true) return
    if (d.sending_allowed === undefined) return { warn: 'PostShiba did not say whether the domain may send' }
    const open = [['DKIM', d.dkim_status], ['return path', d.return_path_status], ['DMARC', d.dmarc_status]].filter(([, st]) => st && st !== 'verified')
    const records = missingRecords(d)
    throw Object.assign(new ClankerError('config', `PostShiba has not verified the DNS records of ${domain} yet${open.length ? ` (${open.map(([n, st]) => `${n} ${st}`).join(', ')})` : ''}`), { records })
  }

  // PostShiba's own MX check, or the DNS itself when PostShiba has not looked again yet.
  private async mxCheck(host: string, inboxId: string): Promise<void> {
    const key = this.key('read')
    const inbox = await this.client.getInbox(key, inboxId)
    if (!inbox.mx_status || inbox.mx_status === 'verified') return
    const target = (inbox.mx_target || 'inbound.postshiba.com').toLowerCase()
    const records = await resolveMx(host).catch(() => [])
    await this.client.verifyInbox(key, inboxId).catch(() => {})
    const hosts = records.map((r) => r.exchange.toLowerCase().replace(/\.$/, ''))
    if (hosts.includes(target)) return
    const record = inbox.mx_record || `${host} MX 10 ${target}`
    throw new Error(hosts.length
      ? `the MX records of ${host} point at ${hosts.join(', ')}, not at PostShiba. Add this DNS record: ${record}`
      : `there is no MX record. Add this DNS record: ${record}`)
  }

  // PostShiba's listing has only some headers, and Reply-To is not one of them: the mail as it
  // arrived (a read of the one mail) has it.
  async replyTo(inbox: InboxConfig, mail: Mail, opts: CallOptions = {}): Promise<string | null> {
    const listed = mail.headers['reply-to']
    if (listed !== undefined) return Array.isArray(listed) ? listed.join(', ') : String(listed)
    const one = await this.client.getInbound(this.key('read'), inbox.id, mail.id, opts).catch((e) => this.refused(e, 'read'))
    if (typeof one?.raw !== 'string') return null
    const head = one.raw.split(/\r?\n\r?\n/)[0]
    const found = parseHeaderBlock(head).filter(([k]) => k === 'reply-to').map(([, v]) => v)
    return found.length ? found.join(', ') : null
  }

  async listInbound(inbox: InboxConfig, opts: CallOptions = {}): Promise<Mail[]> {
    const messages = await this.client.listInbound(this.key('read'), inbox.id, opts).catch((e) => this.refused(e, 'read'))
    return messages.filter((m) => m && m.id).map((m) => toMail(m, this.config.retentionHours))
  }
}
