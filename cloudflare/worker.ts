// clankerinbox mail Worker. Deploy it on your own Cloudflare account; the CLI's
// cloudflare provider talks to its HTTP API.
//
// - email: Email Routing hands over each inbound mail. It is stored in D1 with the first
//   Authentication-Results header, the one Cloudflare puts on top (the only one that counts).
//   Mail over the size limit keeps its headers and text; attachments keep only name and size.
// - fetch: an API behind a bearer token: list stored mail for an address (oldest first, in
//   pages), send mail through Cloudflare Email Service as the one configured sender.
// - Each new mail and each list removes the mail older than the retention period. A cron
//   trigger is not necessary: on an account without a workers.dev name, a cron stops the deploy.
// - scheduled: the same cleanup, if you add a cron trigger yourself.
//
// The Worker only moves mail. Who may write, who may be written to, DMARC alignment,
// loop headers and caps are all checked by the CLI, the same as for every provider.
// It has no imports, so wrangler deploys this one file as it is.

export interface D1Statement {
  bind(...values: unknown[]): D1Statement
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>
  first<T = Record<string, unknown>>(): Promise<T | null>
  run(): Promise<unknown>
}

export interface D1 {
  prepare(sql: string): D1Statement
}

export interface SendBinding {
  send(mail: {
    from: string
    to: string[]
    replyTo?: string
    subject: string
    text: string
    html?: string
    headers?: Record<string, string>
  }): Promise<{ messageId?: string } | undefined>
}

export interface WorkerEnv {
  DB: D1
  EMAIL: SendBinding
  // Bearer token for the HTTP API (`wrangler secret put API_TOKEN`).
  API_TOKEN?: string
  // The one address the Worker sends as (also in allowed_sender_addresses).
  SENDER?: string
  RETENTION_HOURS?: string
  // Mail larger than this keeps its headers and text parts only.
  MAX_STORED_BYTES?: string
  // The server whose Authentication-Results header is kept; Email Routing writes mx.cloudflare.net.
  TRUSTED_AUTHSERV_ID?: string
}

export interface InboundEmail {
  readonly from: string
  readonly to: string
  readonly headers: Headers
  readonly raw: ReadableStream | ArrayBuffer | Uint8Array | string
  readonly rawSize: number
  setReject(reason: string): void
}

// The CLI compares this with the Worker code it ships, and asks for a new deploy when the
// Worker is older.
export const WORKER_VERSION = 3

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS mail (
  id TEXT PRIMARY KEY,
  rcpt TEXT NOT NULL,
  rcpt_base TEXT NOT NULL,
  mail_from TEXT,
  auth_results TEXT,
  raw_b64 TEXT NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mail_rcpt ON mail (rcpt_base, received_at);
CREATE INDEX IF NOT EXISTS mail_received ON mail (received_at);
`

const DEFAULT_RETENTION_HOURS = 168
const DEFAULT_TRUSTED_AUTHSERV_ID = 'mx.cloudflare.net'
// D1 keeps at most 2,000,000 bytes in one row, and the mail is stored as base64 (a third
// more). 1,400,000 bytes of mail is 1,866,668 of base64, which leaves room for the other columns.
const DEFAULT_MAX_STORED_BYTES = 1_000_000
const HARD_MAX_STORED_BYTES = 1_400_000
// The header block of a mail that is too large; a part's own header block.
const MAX_HEADER_BYTES = 64_000
const MAX_PART_HEADER_BYTES = 8_000
// Longer than any header Cloudflare writes; a longer one is not believed.
const MAX_AUTH_RESULTS = 8_000
const MAX_ADDRESS = 1_000
const MAX_LIST = 100
// Base64 characters in one /inbound answer. The CLI asks for the next page for the rest.
const LIST_BUDGET = 6_000_000
const MAX_DEPTH = 10
// Headers the CLI sends; any other is refused, so a leaked token cannot shape the mail.
const ALLOWED_HEADERS = ['in-reply-to', 'references', 'auto-submitted', 'x-loop']
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/

// user+tag@Example.com → user@example.com, so all tags of an inbox list together.
export function baseAddress(address: string): string {
  const a = address.trim().toLowerCase().replace(/^<|>$/g, '')
  const at = a.lastIndexOf('@')
  if (at < 0) return a
  const local = a.slice(0, at)
  const plus = local.indexOf('+')
  return (plus < 0 ? local : local.slice(0, plus)) + a.slice(at)
}

// Bytes as a string with one char per byte, so a MIME walk never changes a byte.
function bytesToLatin1(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return s
}

function latin1ToUtf8(s: string): string {
  const bytes = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff
  return new TextDecoder().decode(bytes)
}

async function readRaw(raw: InboundEmail['raw']): Promise<Uint8Array> {
  if (typeof raw === 'string') return new TextEncoder().encode(raw)
  if (raw instanceof Uint8Array) return raw
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw)
  return new Uint8Array(await new Response(raw).arrayBuffer())
}

// [header block, the blank line, body]. No blank line: the whole text is the header block.
function splitHead(text: string): [string, string, string] {
  const crlf = text.indexOf('\r\n\r\n')
  const lf = text.indexOf('\n\n')
  if (crlf < 0 && lf < 0) return [text, '', '']
  if (lf >= 0 && (crlf < 0 || lf < crlf)) return [text.slice(0, lf), '\n\n', text.slice(lf + 2)]
  return [text.slice(0, crlf), '\r\n\r\n', text.slice(crlf + 4)]
}

// Header fields top down as [lowercase name, unfolded value].
function headerFields(head: string): [string, string][] {
  const out: [string, string][] = []
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && out.length) {
      out[out.length - 1][1] += line
      continue
    }
    const i = line.indexOf(':')
    if (i > 0) out.push([line.slice(0, i).trim().toLowerCase(), line.slice(i + 1)])
  }
  return out
}

// The first Authentication-Results field of the mail exactly as it came (unfolded), when the
// trusted server wrote it. Email Routing puts its own on top; when the top one names another
// server, Cloudflare added none, and a header further down was written by someone else. The
// CLI reads the value; here it is only cut out, never interpreted.
export function firstAuthResults(head: string, trusted = DEFAULT_TRUSTED_AUTHSERV_ID): string | null {
  const field = headerFields(head).find(([name]) => name === 'authentication-results')
  if (!field) return null
  const value = latin1ToUtf8(field[1]).trim()
  if (value.length > MAX_AUTH_RESULTS) return null
  const id = trusted.trim().toLowerCase()
  const lower = value.toLowerCase()
  if (!lower.startsWith(id) || !/^($|[\s;])/.test(lower.slice(id.length))) return null
  return value
}

// Whole header fields only, at most `max` characters in all.
function capHeader(head: string, max: number): string {
  if (head.length <= max) return head
  const out: string[] = []
  let size = 0
  let field: string[] = []
  const flush = () => {
    const s = field.join('\r\n')
    if (field.length && size + s.length + 2 <= max) {
      out.push(s)
      size += s.length + 2
    }
    field = []
  }
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && field.length) field.push(line)
    else {
      flush()
      field = [line]
    }
  }
  flush()
  return out.join('\r\n')
}

// The parts of a multipart body, without the delimiter lines.
function splitMultipart(body: string, boundary: string): string[] {
  const delim = '--' + boundary
  const parts: string[] = []
  let start = -1
  let i = body.startsWith(delim) ? 0 : body.indexOf('\n' + delim)
  if (i > 0) i += 1
  while (i >= 0) {
    const after = i + delim.length
    const end = body.indexOf('\n', after)
    const rest = body.slice(after, end < 0 ? body.length : end).replace(/[\r \t]+$/, '')
    if (rest === '' || rest === '--') {
      if (start >= 0) parts.push(body.slice(start, i).replace(/\r?\n$/, ''))
      if (rest === '--') return parts
      start = end < 0 ? body.length : end + 1
    }
    const next = body.indexOf('\n' + delim, after)
    i = next < 0 ? -1 : next + 1
  }
  if (start >= 0) parts.push(body.slice(start))
  return parts
}

function param(value: string, name: string): string | undefined {
  const m = new RegExp(`;\\s*${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, 'i').exec(value)
  return m ? (m[1] ?? m[2]) : undefined
}

// The size of a body once decoded, without decoding it.
function decodedSize(body: string, cte: string): number {
  if (cte.trim().toLowerCase() !== 'base64') return body.length
  let n = 0
  for (let i = 0; i < body.length; i++) {
    const c = body.charCodeAt(i)
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 47) n++
  }
  return Math.floor((n * 3) / 4)
}

// On a part whose body was left out: its size before. The CLI reads it only on mail the
// Worker marked truncated.
export const SIZE_HEADER = 'X-Clankerinbox-Size'

// One MIME part of a mail that is too large: text parts stay while the budget lasts, every
// other part keeps its headers and its decoded size in SIZE_HEADER, but not its body.
function reducePart(fields: [string, string][], body: string, budget: { left: number }, depth: number): { body: string; dropped: number | null } {
  const get = (n: string) => fields.find(([k]) => k === n)?.[1] || ''
  const ct = get('content-type') || 'text/plain'
  const type = ct.split(';')[0].trim().toLowerCase()
  const disp = get('content-disposition')
  const boundary = param(ct, 'boundary')
  if (type.startsWith('multipart/') && boundary && depth < MAX_DEPTH) {
    const out: string[] = []
    for (const part of splitMultipart(body, boundary)) {
      const [h0, sep, b] = splitHead(part)
      const h = capHeader(h0, MAX_PART_HEADER_BYTES)
      const r = reducePart(headerFields(h), b, budget, depth + 1)
      out.push(`--${boundary}\r\n${h}${r.dropped !== null ? `\r\n${SIZE_HEADER}: ${r.dropped}` : ''}${sep || '\r\n\r\n'}${r.body}\r\n`)
    }
    return { body: `${out.join('')}--${boundary}--\r\n`, dropped: null }
  }
  const isText = type === 'text/plain' || type === 'text/html'
  const filename = param(disp, 'filename') || param(disp, 'filename\\*') || param(ct, 'name')
  const dispType = disp.split(';')[0].trim().toLowerCase()
  const attachment = dispType === 'attachment' || !isText || (!!filename && dispType !== 'inline')
  if (attachment) return { body: '', dropped: decodedSize(body, get('content-transfer-encoding')) }
  if (body.length <= budget.left) {
    budget.left -= body.length
    return { body, dropped: null }
  }
  // Cut at a line end, so base64 and quoted-printable stay readable.
  const cut = body.slice(0, Math.max(0, budget.left))
  budget.left = 0
  const nl = cut.lastIndexOf('\n')
  return { body: nl >= 0 ? cut.slice(0, nl + 1) : '', dropped: null }
}

// A mail over the limit, made smaller: the header block (whole fields, at most
// MAX_HEADER_BYTES), every text part that fits, and the names and sizes of the others.
export function shrinkMail(text: string, max: number): string {
  const [head0, sep, body] = splitHead(text)
  const head = capHeader(head0, Math.min(MAX_HEADER_BYTES, Math.floor(max / 2)))
  // Room for the delimiter lines and size headers of the parts.
  const budget = { left: Math.max(0, max - head.length - Math.min(64_000, Math.floor(max / 4))) }
  const r = reducePart(headerFields(head), body, budget, 0)
  const out = `${head}${r.dropped !== null ? `\r\n${SIZE_HEADER}: ${r.dropped}` : ''}${sep || '\r\n\r\n'}${r.body}`
  return out.length <= max ? out : out.slice(0, max)
}

function retention(env: WorkerEnv): { hours: number; problem?: string } {
  if (env.RETENTION_HOURS === undefined || env.RETENTION_HOURS === '') return { hours: DEFAULT_RETENTION_HOURS }
  const h = Number(env.RETENTION_HOURS)
  if (Number.isFinite(h) && h > 0) return { hours: h }
  // Mail is still kept for the default time; /health says the setting is wrong.
  return { hours: DEFAULT_RETENTION_HOURS, problem: `RETENTION_HOURS "${String(env.RETENTION_HOURS).slice(0, 40)}" is not a positive number of hours. The Worker keeps mail for ${DEFAULT_RETENTION_HOURS} hours until you correct it` }
}

function maxStored(env: WorkerEnv): number {
  const n = Number(env.MAX_STORED_BYTES)
  return Number.isFinite(n) && n > 0 ? Math.min(n, HARD_MAX_STORED_BYTES) : DEFAULT_MAX_STORED_BYTES
}

const INSERT = 'INSERT INTO mail (id, rcpt, rcpt_base, mail_from, auth_results, raw_b64, truncated, size, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'

// Returns the id, or null when the mail could not be stored. Then the sender's server gets a
// refusal with a temporary-failure text: the mail is never dropped without a word.
export async function handleEmail(message: InboundEmail, env: WorkerEnv, now?: number): Promise<string | null> {
  let id: string
  let at: number
  try {
    const bytes = await readRaw(message.raw)
    const text = bytesToLatin1(bytes)
    const max = maxStored(env)
    const truncated = text.length > max
    const stored = truncated ? shrinkMail(text, max) : text
    id = crypto.randomUUID()
    // The time of the insert, after the mail was read: the CLI pages by this time.
    at = now ?? Date.now()
    await env.DB.prepare(INSERT).bind(
      id,
      String(message.to || '').toLowerCase().slice(0, MAX_ADDRESS),
      baseAddress(String(message.to || '')).slice(0, MAX_ADDRESS),
      String(message.from ?? '').slice(0, MAX_ADDRESS),
      firstAuthResults(splitHead(text)[0], env.TRUSTED_AUTHSERV_ID || DEFAULT_TRUSTED_AUTHSERV_ID),
      btoa(stored),
      truncated ? 1 : 0,
      bytes.length,
      at,
    ).run()
  } catch (e: any) {
    console.error(`clankerinbox: could not store a mail to ${message.to}: ${e?.message || e}`)
    message.setReject('Temporary failure: the mailbox cannot store mail right now. Please try again later.')
    return null
  }
  // Old mail stays a while longer when the cleanup fails; the new mail is stored either way.
  try {
    await cleanup(env, at)
  } catch (e: any) {
    console.error(`clankerinbox: cleanup failed: ${e?.message || e}`)
  }
  return id
}

export async function cleanup(env: WorkerEnv, now = Date.now()): Promise<void> {
  await env.DB.prepare('DELETE FROM mail WHERE received_at < ?').bind(now - retention(env).hours * 3600_000).run()
}

// Compares in time independent of where the strings differ.
function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a)
  const y = new TextEncoder().encode(b)
  let diff = x.length ^ y.length
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function isStringMap(v: unknown): v is Record<string, string> {
  return !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string')
}

// "Name <a@b>" or "a@b" → [name, lowercase address]; null for anything else.
function splitFrom(from: string): [string, string] | null {
  const m = /^\s*(?:([^<>]*?)\s*<([^<>\s]+@[^<>\s]+)>|([^<>\s]+@[^<>\s]+))\s*$/.exec(from)
  if (!m) return null
  return [(m[1] || '').trim(), (m[2] || m[3]).toLowerCase()]
}

type Row = { id: string; received_at: number; seq: number }

// GET /inbound?address=&since=&after=: the mail of one address, oldest first, in pages that
// stay under LIST_BUDGET. `after` (`<received_at>:<seq>`, from `next`) continues a page; `seq`
// (the rowid) keeps the order of mail stored in the same millisecond. Without `since` and
// `after`: the newest 100, newest first, as older CLIs expect.
async function listInbound(url: URL, env: WorkerEnv, now: number): Promise<Response> {
  const address = url.searchParams.get('address')
  if (!address) return json({ error: 'address is required' }, 400)
  const { hours } = retention(env)
  try {
    await cleanup(env, now)
  } catch (e: any) {
    console.error(`clankerinbox: cleanup failed: ${e?.message || e}`)
  }
  const paged = url.searchParams.has('since') || url.searchParams.has('after')
  const oldest = now - hours * 3600_000
  const since = Math.max(Number(url.searchParams.get('since')) || 0, oldest)
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || MAX_LIST, 1), MAX_LIST)
  const after = /^(\d+):(\d+)$/.exec(url.searchParams.get('after') || '')
  const afterAt = after ? Number(after[1]) : -1
  const afterSeq = after ? Number(after[2]) : -1
  const where = paged
    ? 'rcpt_base = ? AND received_at >= ? AND (received_at > ? OR (received_at = ? AND rowid > ?)) ORDER BY received_at ASC, rowid ASC'
    : 'rcpt_base = ? AND received_at >= ? ORDER BY received_at DESC, rowid DESC'
  const binds = paged ? [baseAddress(address), since, afterAt, afterAt, afterSeq] : [baseAddress(address), since]
  // Sizes first, so one answer never holds more than the budget (a Worker has little memory).
  const { results: sizes } = await env.DB.prepare(`SELECT id, received_at, rowid AS seq, length(raw_b64) AS n FROM mail WHERE ${where} LIMIT ?`)
    .bind(...binds, limit + 1).all<Row & { n: number }>()
  let take = 0
  let used = 0
  for (const r of sizes.slice(0, limit)) {
    if (take > 0 && used + Number(r.n) > LIST_BUDGET) break
    used += Number(r.n)
    take++
  }
  const { results } = take
    ? await env.DB.prepare(`SELECT id, rcpt, mail_from, auth_results, raw_b64, truncated, size, received_at, rowid AS seq FROM mail WHERE ${where} LIMIT ?`)
      .bind(...binds, take).all<Row>()
    : { results: [] as Row[] }
  const more = sizes.length > results.length
  const last = results[results.length - 1]
  return json({
    messages: results,
    retentionHours: hours,
    ...(paged ? { more, next: more && last ? `${last.received_at}:${last.seq}` : null } : {}),
  })
}

async function health(env: WorkerEnv): Promise<Response> {
  const problems: string[] = []
  let schema = true
  try {
    await env.DB.prepare('SELECT id FROM mail LIMIT 1').all()
  } catch (e: any) {
    schema = false
    problems.push(`the database has no mail table (${String(e?.message || e).slice(0, 200)}). Apply schema.sql`)
  }
  const r = retention(env)
  if (r.problem) problems.push(r.problem)
  if (!splitFrom(env.SENDER || '')) problems.push('SENDER in [vars] of wrangler.toml is not an address, so the Worker sends no mail')
  return json({ ok: problems.length === 0, version: WORKER_VERSION, schema, retentionHours: r.hours, ...(problems.length ? { problems } : {}) })
}

async function send(request: Request, env: WorkerEnv): Promise<Response> {
  const sender = splitFrom(env.SENDER || '')
  if (!sender) {
    console.error('clankerinbox: SENDER is not set; the Worker refuses to send')
    return json({ error: 'no_sender', message: 'the Worker has no SENDER. Set SENDER in [vars] of wrangler.toml to the address it sends as, and deploy again' }, 500)
  }
  let body: any
  try {
    body = await request.json()
  } catch {
    return json({ error: 'body must be JSON' }, 400)
  }
  const to = Array.isArray(body?.to) ? body.to : [body?.to]
  if (!to.length || !to.every((t: unknown) => typeof t === 'string' && t)) return json({ error: 'to is required' }, 400)
  if (typeof body.subject !== 'string' || typeof body.text !== 'string') return json({ error: 'subject and text are required' }, 400)
  for (const k of ['from', 'replyTo', 'html']) {
    if (body[k] !== undefined && typeof body[k] !== 'string') return json({ error: `${k} must be a string` }, 400)
  }
  if (body.headers !== undefined && !isStringMap(body.headers)) return json({ error: 'headers must map names to strings' }, 400)
  const headers: Record<string, string> = body.headers || {}
  const extra = Object.keys(headers).filter((k) => !ALLOWED_HEADERS.includes(k.toLowerCase()))
  if (extra.length) return json({ error: 'header_not_allowed', message: `the Worker does not send these headers: ${extra.join(', ').slice(0, 200)}` }, 400)
  // Each of these becomes a header: a line break would add headers or recipients.
  const values = [body.from, body.replyTo, body.subject, ...to, ...Object.values(headers)]
  if (values.some((v) => typeof v === 'string' && CONTROL.test(v))) {
    return json({ error: 'control_character', message: 'a header value has a line break or another control character' }, 400)
  }
  // The Worker sends as its own sender only. A name may come with it.
  const given = body.from === undefined ? sender : splitFrom(body.from)
  if (!given || given[1] !== sender[1]) return json({ error: 'from_not_allowed', message: `this Worker sends only as ${sender[1]}` }, 403)
  const from = given[0] ? `${given[0]} <${sender[1]}>` : sender[1]
  // Email Service refuses a Message-ID header (it accepts only its own list and X-*), and
  // reports the Message-ID it gave the mail.
  try {
    const res = await env.EMAIL.send({
      from,
      to,
      ...(body.replyTo ? { replyTo: body.replyTo } : {}),
      subject: body.subject,
      text: body.text,
      ...(typeof body.html === 'string' ? { html: body.html } : {}),
      ...(Object.keys(headers).length ? { headers } : {}),
    })
    // `sent` tells the CLI that a null id still means the mail went out.
    return json(typeof res?.messageId === 'string' && res.messageId ? { messageId: res.messageId } : { messageId: null, sent: true })
  } catch (e: any) {
    const code = String(e?.code || 'send_failed')
    const message = String(e?.message || e)
    // Workers Logs (and `wrangler tail`) show why Email Service refused the mail.
    console.error(`clankerinbox: send failed: ${code}: ${message}`.slice(0, 500))
    // A recipient that Email Routing has not verified is refused for good, not for now.
    if (/RECIPIENT|DESTINATION|not verified|unverified/i.test(`${code} ${message}`)) return json({ error: 'recipient_not_verified', code, message }, 422)
    if (/SENDER/i.test(code)) return json({ error: 'sender_not_allowed', code, message }, 422)
    return json({ error: code, message }, 502)
  }
}

export async function handleFetch(request: Request, env: WorkerEnv, now = Date.now()): Promise<Response> {
  const m = /^bearer\s+(\S+)\s*$/i.exec(request.headers.get('authorization') || '')
  if (!env.API_TOKEN) console.error('clankerinbox: API_TOKEN is not set, so every request is refused. Run: wrangler secret put API_TOKEN')
  // The same answer for a wrong token, no token and a Worker without one: visitors learn nothing.
  if (!env.API_TOKEN || !m || !sameSecret(m[1], env.API_TOKEN)) return json({ error: 'unauthorized' }, 401)

  const url = new URL(request.url)
  if (request.method === 'GET' && url.pathname === '/health') return health(env)
  if (request.method === 'GET' && url.pathname === '/inbound') return listInbound(url, env, now)
  if (request.method === 'POST' && url.pathname === '/send') return send(request, env)
  return json({ error: 'not found' }, 404)
}

export default {
  async email(message: InboundEmail, env: WorkerEnv): Promise<void> {
    await handleEmail(message, env)
  },
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    return handleFetch(request, env)
  },
  async scheduled(_controller: unknown, env: WorkerEnv): Promise<void> {
    await cleanup(env)
  },
}
