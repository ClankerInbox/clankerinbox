// A small in-memory PostShiba: enough of the REST API for every clankerinbox command.
// It enforces the key split the real service has: the send key can send but not read.
import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { InboundMessage, Inbox } from '../src/postshiba.ts'

export const SEND_KEY = 'test-send-key'
export const FULL_KEY = 'test-full-key'
export const TEAM = 'TeamX1'
export const RETENTION_MS = 168 * 3600_000

export interface FakeSend {
  body: any
  messageId: string
}

export class FakePostShiba {
  server: Server
  url = ''
  inboxes: Inbox[] = []
  messages = new Map<string, InboundMessage[]>()
  sends: FakeSend[] = []
  requests: { method: string; path: string; key: string }[] = []
  // Ids of single mails read (GET of one inbound message).
  reads: string[] = []
  domains: Record<string, any>[] = [
    { id: 'dom1', name: 'inbox.example.com', sending_allowed: true, dkim_status: 'verified' },
  ]
  // New inboxes start with this MX status; a verify call flips them when mxReady.
  newInboxMx = 'verified'
  mxReady = true
  // A sending-domain DNS check passes once this is set.
  dnsReady = false
  onDomainVerify?: () => void
  verifyCalls = 0
  // Mail to an address this fake does not hold goes here (another mail service in a test).
  outside?: (body: any, messageId: string) => void

  constructor() {
    this.server = createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        const key = (req.headers.authorization || '').replace(/^Bearer /, '')
        const path = (req.url || '').split('?')[0]
        this.requests.push({ method: req.method || '', path, key })
        const reply = (status: number, data: unknown) => {
          res.writeHead(status, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(data))
        }
        if (key !== SEND_KEY && key !== FULL_KEY) return reply(401, { error: 'unauthorized' })
        const body = raw ? JSON.parse(raw) : null

        if (req.method === 'POST' && path === '/api/v1/emails') return reply(201, this.acceptSend(body))
        if (key !== FULL_KEY) return reply(403, { error: 'forbidden', message: 'Send only key' })

        let m = path.match(/^\/api\/v1\/inboxes\/([^/]+)\/inbound_messages$/)
        if (req.method === 'GET' && m) {
          if (!this.inboxes.find((i) => i.id === m![1])) return reply(404, { error: 'not_found' })
          // Like PostShiba: a listing has no raw mail; a read of one mail has it.
          return reply(200, (this.messages.get(m[1]) || []).map(({ raw: _raw, ...rest }) => rest))
        }
        m = path.match(/^\/api\/v1\/inboxes\/([^/]+)\/inbound_messages\/([^/]+)$/)
        if (req.method === 'GET' && m) {
          this.reads.push(m[2])
          const found = (this.messages.get(m[1]) || []).find((x) => x.id === m![2])
          return found ? reply(200, found) : reply(404, { error: 'not_found' })
        }
        if (req.method === 'GET' && path === '/api/v1/teams') return reply(200, [{ id: TEAM, name: 'Test team' }])
        if (req.method === 'GET' && path === `/api/v1/teams/${TEAM}/sending_domains`) return reply(200, this.domains)
        if (req.method === 'POST' && path === `/api/v1/teams/${TEAM}/sending_domains`) {
          const name = body.sending_domain.name
          const d = {
            id: 'dom' + randomBytes(2).toString('hex'), name, sending_allowed: false, dkim_status: 'pending', return_path_status: 'pending', dmarc_status: 'pending',
            dkim_selector: 'ps1', dkim_manual: false, dkim_txt: 'v=DKIM1; k=rsa; p=AAAA', dkim_cname_host: `ps1._domainkey.${name}`, dkim_cname_target: '42.customers.postshiba.com',
            return_path_host: `rp.${name}`, return_path_target: 'rp.postshiba.com', dmarc_host: `_dmarc.${name}`, dmarc_record: 'v=DMARC1; p=none;',
          }
          this.domains.push(d)
          return reply(201, d)
        }
        m = path.match(/^\/api\/v1\/sending_domains\/([^/]+)\/verify$/)
        if (req.method === 'POST' && m) {
          const d = this.domains.find((x) => x.id === m![1])
          if (!d) return reply(404, { error: 'not_found' })
          this.onDomainVerify?.()
          if (this.dnsReady) Object.assign(d, { sending_allowed: true, dkim_status: 'verified', return_path_status: 'verified', dmarc_status: 'verified' })
          return reply(200, d)
        }
        m = path.match(/^\/api\/v1\/inboxes\/([^/]+)(\/verify)?$/)
        if (m) {
          const inbox = this.inboxes.find((i) => i.id === m![1])
          if (!inbox) return reply(404, { error: 'not_found' })
          if (m[2] && req.method === 'POST') { this.verifyCalls++; if (this.mxReady) inbox.mx_status = 'verified' }
          return reply(200, inbox)
        }
        m = path.match(/^\/api\/v1\/teams\/([^/]+)\/inboxes$/)
        if (m && m[1] !== TEAM) return reply(404, { error: 'not_found' })
        if (req.method === 'GET' && m) return reply(200, this.inboxes)
        if (req.method === 'POST' && m) {
          const { local_part, host, name } = body.inbox
          const inbox = this.addInbox(`${local_part}@${host}`, name)
          return reply(201, { ...inbox, webhook_secret: 'whsec_should_never_be_printed' })
        }
        reply(404, { error: 'not_found' })
      })
    })
  }

  async start(): Promise<string> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r))
    const addr = this.server.address() as { port: number }
    this.url = `http://127.0.0.1:${addr.port}/api/v1`
    return this.url
  }

  stop(): Promise<void> {
    return new Promise((r) => this.server.close(() => r()))
  }

  addInbox(address: string, name = address): Inbox {
    const [local_part, host] = address.split('@')
    const inbox: Inbox = {
      id: 'ib' + randomBytes(3).toString('hex'), name, address, local_part, host,
      mx_status: this.newInboxMx, mx_record: `${host} MX 10 inbound.postshiba.com`, mx_target: 'inbound.postshiba.com',
    }
    this.inboxes.push(inbox)
    this.messages.set(inbox.id, [])
    return inbox
  }

  // Store a message the way PostShiba does: newest first, thread id from the plus tag.
  deliver(inboxId: string, msg: Partial<InboundMessage> & { from: string; to: string }, receivedAt = Date.now()): InboundMessage {
    const local = msg.to.split('@')[0]
    const tag = local.includes('+') ? local.slice(local.indexOf('+') + 1) : null
    const full: InboundMessage = {
      id: 'in' + randomBytes(4).toString('hex'),
      inbox_id: inboxId,
      subject: '',
      text: '',
      thread_id: tag,
      in_reply_to: null,
      attachments: [],
      envelope: { rcpt_to: msg.to, plus_tag: tag ?? undefined, mail_from: 'bounce@rp.example.com' },
      authentication: { dmarc: { result: 'pass', aligned: true, policy: 'none' }, arc: { result: 'none' } },
      expires_at: new Date(receivedAt + RETENTION_MS).toISOString(),
      ...msg,
      headers: { from: msg.from, to: msg.to, 'message-id': `${randomBytes(6).toString('hex')}@mail.example.com`, ...(msg.headers || {}) },
    }
    this.messages.get(inboxId)!.unshift(full)
    return full
  }

  private acceptSend(body: any) {
    const fromAddr = (String(body.from).match(/<([^>]+)>/) || [null, body.from])[1]
    const messageId = `${randomBytes(8).toString('hex')}@${String(fromAddr).split('@')[1] || 'inbox.example.dev'}`
    this.sends.push({ body, messageId })
    const to: string[] = Array.isArray(body.to) ? body.to : [body.to]
    for (const addr of to) {
      const [local, host] = addr.toLowerCase().split('@')
      const base = `${local.split('+')[0]}@${host}`
      const inbox = this.inboxes.find((i) => i.address.toLowerCase() === base)
      if (!inbox) { this.outside?.({ ...body, to: [addr] }, messageId); continue }
      this.deliver(inbox.id, sentMail(body, addr, messageId))
    }
    return { queued: true, message_id: messageId, from: body.from, to, subject: body.subject }
  }
}

// A mail sent through PostShiba as another PostShiba inbox gets it: the listing's few headers
// (PostShiba adds Auto-Submitted to all it sends; Reply-To is not among them), and the raw mail.
export function sentMail(body: any, addr: string, messageId: string): Partial<InboundMessage> & { from: string; to: string } {
  const fromAddr = (String(body.from).match(/<([^>]+)>/) || [null, body.from])[1]
  const headers: Record<string, string> = { from: body.from, to: addr, 'message-id': messageId, subject: body.subject, 'auto-submitted': 'auto-generated' }
  for (const [k, v] of Object.entries(body.headers || {})) headers[k.toLowerCase()] = String(v)
  const raw = [
    `From: ${body.from}`, ...(body.reply_to ? [`Reply-To: <${body.reply_to}>`] : []), `To: <${addr}>`,
    `Message-ID: <${messageId}>`, `Subject: ${body.subject}`, 'MIME-Version: 1.0',
    ...Object.entries(headers).filter(([k]) => !['from', 'to', 'message-id', 'subject'].includes(k)).map(([k, v]) => `${k}: ${v}`),
    'Content-Type: text/plain; charset=utf-8', '', body.text, '',
  ].join('\r\n')
  return { from: fromAddr, to: addr, subject: body.subject, text: body.text, headers, in_reply_to: headers['in-reply-to'] ?? null, raw }
}
