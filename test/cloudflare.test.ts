import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeD1 } from './fake-d1.ts'
import worker, { SCHEMA, WORKER_VERSION, handleEmail, handleFetch, cleanup, firstAuthResults, baseAddress, type WorkerEnv } from '../cloudflare/worker.ts'
import { CloudflareProvider, cloudflareMail } from '../src/cloudflare-provider.ts'
import { validateConfig, type Config } from '../src/config.ts'
import { createProvider } from '../src/provider.ts'
import { ClankerInbox } from '../src/clankerinbox.ts'
import { parseMail } from '../src/mime.ts'

const TOKEN = 'worker-token-123'
const TOKEN_ENV = 'TEST_CF_TOKEN'
const OWNER = 'owner@example.org'
const CF_AR = (from = 'example.org', dmarc = 'pass') => `mx.cloudflare.net; spf=pass smtp.mailfrom=${from}; dkim=pass header.d=${from}; dmarc=${dmarc} header.from=${from}`

interface Sent { from: string; to: string[]; replyTo?: string; subject: string; text: string; headers?: Record<string, string> }

async function makeEnv(extra: Partial<WorkerEnv> = {}) {
  const db = new FakeD1()
  await db.exec(SCHEMA)
  const sent: Sent[] = []
  const env: WorkerEnv & { sent: Sent[]; failNext?: string } = {
    DB: db,
    EMAIL: {
      async send(m) {
        if (env.failNext) {
          const e: any = new Error('the send failed')
          e.code = env.failNext
          env.failNext = undefined
          throw e
        }
        // Email Service accepts only its own list of headers and X-*: a Message-ID is refused.
        const custom = Object.keys(m.headers || {}).find((k) => !/^(x-.*|in-reply-to|references|auto-submitted|list-unsubscribe)$/i.test(k))
        if (custom) throw Object.assign(new Error(`custom header '${custom}' is not allowed. Only whitelisted headers and X-* headers are accepted.`), { code: 'E_HEADER_NOT_ALLOWED' })
        sent.push(m as Sent)
        return { messageId: `<cf-${sent.length}@example.org>` }
      },
    },
    API_TOKEN: TOKEN,
    SENDER: 'bot@example.org',
    sent,
    ...extra,
  }
  return env
}

function raw(opts: { to: string; from?: string; subject?: string; body?: string; ar?: string[]; extra?: string[] }): string {
  return [
    ...(opts.ar || []).map((a) => `Authentication-Results: ${a}`),
    `From: Owner <${opts.from || OWNER}>`,
    `To: ${opts.to}`,
    `Subject: ${opts.subject ?? 'Re: question'}`,
    'Message-ID: <m1@example.org>',
    ...(opts.extra || []),
    'Content-Type: text/plain; charset=utf-8',
    '',
    opts.body ?? 'Yes',
    '',
  ].join('\r\n')
}

// An inbound mail as Email Routing hands it over: Cloudflare's header first, then the mail's own.
function inbound(opts: { to: string; mailFrom?: string; cfAr?: string | null; ar?: string[]; body?: string; from?: string; subject?: string; extra?: string[] }) {
  const own = opts.ar || []
  const cf = opts.cfAr === undefined ? CF_AR((opts.from || OWNER).split('@')[1]) : opts.cfAr
  const headers = new Headers()
  for (const v of [...(cf ? [cf] : []), ...own]) headers.append('Authentication-Results', v)
  const text = raw({ ...opts, ar: [...(cf ? [cf] : []), ...own] })
  return {
    from: opts.mailFrom ?? opts.from ?? OWNER,
    to: opts.to,
    headers,
    raw: new Blob([text]).stream(),
    rawSize: Buffer.byteLength(text),
    rejected: null as string | null,
    setReject(r: string) { this.rejected = r },
  }
}

function req(path: string, init: RequestInit & { token?: string | null } = {}): Request {
  const headers = new Headers(init.headers)
  if (init.token !== null) headers.set('Authorization', `Bearer ${init.token ?? TOKEN}`)
  return new Request('https://worker.example' + path, { ...init, headers })
}

// ---- Worker ----

test('worker: schema.sql and the SCHEMA the Worker uses are the same', () => {
  const norm = (s: string) => s.replace(/--.*$/gm, '').replace(/\s+/g, ' ').trim()
  assert.equal(norm(readFileSync(new URL('../cloudflare/schema.sql', import.meta.url), 'utf8')), norm(SCHEMA))
  assert.equal(typeof worker.email, 'function')
  assert.equal(typeof worker.fetch, 'function')
  assert.equal(typeof worker.scheduled, 'function')
})

test('worker: the first Authentication-Results field is stored as it came, and only when Cloudflare wrote it', () => {
  const head = (...ar: string[]) => [...ar.map((a) => `Authentication-Results: ${a}`), 'From: a@example.org', 'Subject: x'].join('\r\n')
  assert.equal(firstAuthResults(head()), null)
  assert.equal(firstAuthResults(head('mx.cloudflare.net; dmarc=pass')), 'mx.cloudflare.net; dmarc=pass')
  // Commas, comments and quotes are the core parser's business: the field is kept whole.
  const odd = 'mx.cloudflare.net; spf=pass (a, b) smtp.mailfrom="x, y"@example.org; dmarc=fail header.from=example.org, evil; dmarc=pass'
  assert.equal(firstAuthResults(head(odd, 'mx.cloudflare.net; dmarc=pass header.from=example.org')), odd)
  // Folded lines are unfolded, nothing else changes.
  assert.equal(firstAuthResults('Authentication-Results: mx.cloudflare.net;\r\n\tdmarc=pass header.from=example.org\r\nFrom: a@b.c'),
    'mx.cloudflare.net;\tdmarc=pass header.from=example.org')
  // The top field from another server means Cloudflare added none: nothing below it counts.
  assert.equal(firstAuthResults(head('evil.example; dmarc=pass', 'mx.cloudflare.net; dmarc=pass')), null)
  assert.equal(firstAuthResults(head('mx.cloudflare.net.evil.example; dmarc=pass')), null)
  assert.equal(firstAuthResults(head('Mx.Cloudflare.Net 1; dmarc=pass')), 'Mx.Cloudflare.Net 1; dmarc=pass')
  assert.equal(firstAuthResults(head('other.example; dmarc=pass'), 'other.example'), 'other.example; dmarc=pass')
  // ARC-Authentication-Results is another header.
  assert.equal(firstAuthResults(head().replace('From:', 'ARC-Authentication-Results: i=1; mx.cloudflare.net; dmarc=pass\r\nFrom:')), null)
  assert.equal(baseAddress('Bot+Q1@Example.org'), 'bot@example.org')
})

test('worker: a sender header after a Cloudflare one never reaches the stored header, and the core judges what is stored', async () => {
  const env = await makeEnv()
  const cf = 'mx.cloudflare.net; spf=pass (mx.cloudflare.net: domain of a@b.org, c designates 1.2.3.4) smtp.mailfrom=b.org'
  await handleEmail(inbound({ to: 'bot@example.org', cfAr: cf, ar: ['mx.cloudflare.net; dmarc=pass header.from=example.org'] }) as any, env)
  const row = (await env.DB.prepare('SELECT * FROM mail').first<any>())!
  assert.equal(row.auth_results, cf)
  assert.equal(cloudflareMail(row).dmarc, null)
})

test('worker: email stores the mail with the envelope and the Cloudflare header', async () => {
  const env = await makeEnv()
  const id = await worker.email(inbound({ to: 'bot+q1@example.org', ar: ['evil.example; dmarc=pass header.from=example.org'] }) as any, env).then(() => 'x')
  assert.equal(id, 'x')
  const rows = (await env.DB.prepare('SELECT * FROM mail').all<any>()).results
  assert.equal(rows.length, 1)
  assert.equal(rows[0].rcpt, 'bot+q1@example.org')
  assert.equal(rows[0].rcpt_base, 'bot@example.org')
  assert.equal(rows[0].mail_from, OWNER)
  assert.equal(rows[0].auth_results, CF_AR())
  assert.equal(rows[0].truncated, 0)
  assert.match(Buffer.from(rows[0].raw_b64, 'base64').toString(), /\r\n\r\nYes\r\n$/)
})

// A reply "1" with a large photo, as a phone sends it.
function bigReply(photoBytes: number): string {
  const photo = Buffer.alloc(photoBytes, 7).toString('base64').replace(/.{76}/g, '$&\r\n')
  return [
    `Authentication-Results: ${CF_AR()}`, `From: Owner <${OWNER}>`, 'To: bot+q1@example.org', 'Subject: Re: question',
    'Message-ID: <big@example.org>', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="b1"', '',
    '--b1', 'Content-Type: multipart/alternative; boundary="b2"', '',
    '--b2', 'Content-Type: text/plain; charset=utf-8', '', '1', '', 'Sent from my phone', '',
    '--b2', 'Content-Type: text/html; charset=utf-8', '', '<p>1</p>', '--b2--', '',
    '--b1', 'Content-Type: image/jpeg; name="IMG_0001.jpg"', 'Content-Disposition: attachment; filename="IMG_0001.jpg"',
    'Content-Transfer-Encoding: base64', '', photo, '--b1--', '',
  ].join('\r\n')
}

test('worker: a mail over the limit keeps its headers, its text and the name and size of each attachment', async () => {
  const env = await makeEnv({ MAX_STORED_BYTES: '20000' })
  const text = bigReply(300_000)
  await handleEmail({ ...inbound({ to: 'bot+q1@example.org' }), raw: text, rawSize: text.length } as any, env)
  const row = (await env.DB.prepare('SELECT * FROM mail').first<any>())!
  assert.equal(row.truncated, 1)
  assert.equal(row.size, text.length)
  assert.ok(Buffer.from(row.raw_b64, 'base64').length <= 20000)
  assert.equal(row.auth_results, CF_AR())
  const m = cloudflareMail(row)
  assert.equal(m.truncated, true)
  assert.match(m.text, /^1\n/)
  assert.equal(m.subject, 'Re: question')
  assert.deepEqual(m.attachments, [{ filename: 'IMG_0001.jpg', contentType: 'image/jpeg', size: 300_000 }])
  assert.deepEqual(m.dmarc, { result: 'pass', aligned: true })

  // A huge header block and a huge text are cut too: the stored value always stays under the limit.
  const env2 = await makeEnv({ MAX_STORED_BYTES: '50000' })
  const junk = Array.from({ length: 3000 }, (_, i) => `X-Junk-${i}: ${'y'.repeat(60)}`).join('\r\n')
  const huge = `${junk}\r\nFrom: Owner <${OWNER}>\r\nSubject: hi\r\n\r\n${'line of text\r\n'.repeat(20000)}`
  await handleEmail({ ...inbound({ to: 'bot@example.org' }), raw: huge, rawSize: huge.length } as any, env2)
  const row2 = (await env2.DB.prepare('SELECT * FROM mail').first<any>())!
  assert.equal(row2.truncated, 1)
  assert.ok(Buffer.from(row2.raw_b64, 'base64').length <= 50000)
  // A limit above what D1 can hold in a row is lowered to what fits.
  const env3 = await makeEnv({ MAX_STORED_BYTES: '50000000' })
  const giant = bigReply(2_000_000)
  await handleEmail({ ...inbound({ to: 'bot@example.org' }), raw: giant, rawSize: giant.length } as any, env3)
  const row3 = (await env3.DB.prepare('SELECT * FROM mail').first<any>())!
  assert.equal(row3.truncated, 1)
  assert.ok(row3.raw_b64.length < 2_000_000)
})

test('poll: a reply that was too large says so instead of "empty reply"', async () => {
  const env = await makeEnv({ MAX_STORED_BYTES: '5000' })
  const config = cfConfig(await serveWorker(env))
  const ci = new ClankerInbox({ config, stateDir: mkdtempSync(join(tmpdir(), 'ci-cf-')), env: { [TOKEN_ENV]: TOKEN } })
  const q = await ci.ask({ to: OWNER, question: 'Ship it?', options: ['Yes', 'No'] } as any)
  // Only the photo: no text part at all.
  const onlyPhoto = bigReply(100_000).replace(/--b1\r\nContent-Type: multipart\/alternative[\s\S]*?--b2--\r\n\r\n/, '').replace('bot+q1@', `bot+${q.tag}@`)
  await handleEmail({ ...inbound({ to: `bot+${q.tag}@example.org` }), raw: onlyPhoto, rawSize: onlyPhoto.length } as any, env)
  const r = await ci.poll()
  assert.deepEqual(r.skipped.map((s) => s.reason), ['the mail was too large: the Worker kept only its headers and the names of its attachments'])
  // With its text, the large reply is an answer.
  const q2 = await ci.ask({ to: OWNER, question: 'Again?', options: ['Yes', 'No'] } as any)
  const withText = bigReply(100_000).replace('bot+q1@', `bot+${q2.tag}@`).replace('<big@', '<big2@')
  await handleEmail({ ...inbound({ to: `bot+${q2.tag}@example.org` }), raw: withText, rawSize: withText.length } as any, env)
  const r2 = await ci.poll()
  assert.equal(r2.answers[0]?.option, 'Yes')
})

test('poll: unmatched mail says it was too large and names its attachments, as a request does', async () => {
  const env = await makeEnv({ MAX_STORED_BYTES: '5000' })
  const config = cfConfig(await serveWorker(env))
  const ci = new ClankerInbox({ config, stateDir: mkdtempSync(join(tmpdir(), 'ci-cf-')), env: { [TOKEN_ENV]: TOKEN } })
  const big = bigReply(100_000).replace('bot+q1@', 'bot@')
  await handleEmail({ ...inbound({ to: 'bot@example.org' }), raw: big, rawSize: big.length } as any, env)
  const r = await ci.poll()
  assert.equal(r.unmatched.length, 1)
  assert.equal(r.unmatched[0].truncated, true)
  assert.deepEqual(r.unmatched[0].attachments, [{ filename: 'IMG_0001.jpg', contentType: 'image/jpeg', size: 100_000 }])
  assert.match(r.unmatched[0].messageId, /^big@/)
})

test('worker: a mail that cannot be stored is refused with a temporary-failure text; a failed cleanup keeps the mail', async () => {
  const env = await makeEnv()
  const broken = { ...env, DB: { prepare: () => ({ bind: () => ({ run: async () => { throw new Error('D1 is down') } }) }) } } as any
  const m = inbound({ to: 'bot@example.org' })
  const errors: string[] = []
  const log = console.error
  console.error = (s: string) => errors.push(s)
  try {
    assert.equal(await handleEmail(m as any, broken), null)
    assert.match(m.rejected!, /^Temporary failure/)
    assert.match(errors.join('\n'), /D1 is down/)

    const flaky = { ...env, DB: { prepare: (sql: string) => (sql.startsWith('DELETE') ? { bind: () => ({ run: async () => { throw new Error('busy') } }) } : env.DB.prepare(sql)) } } as any
    const ok = inbound({ to: 'bot@example.org' })
    assert.ok(await handleEmail(ok as any, flaky))
    assert.equal(ok.rejected, null)
    assert.equal((await env.DB.prepare('SELECT count(*) AS n FROM mail').first<any>())!.n, 1)
    assert.match(errors.join('\n'), /cleanup failed: busy/)
  } finally {
    console.error = log
  }
})

test('worker: every route answers 401 the same way without the token, also with no API_TOKEN set; the scheme is case-insensitive', async () => {
  const env = await makeEnv()
  const shut = await makeEnv({ API_TOKEN: '' })
  const log = console.error
  const errors: string[] = []
  console.error = (s: string) => errors.push(s)
  try {
    const bodies = new Set<string>()
    for (const [path, init] of [['/health', {}], ['/inbound?address=a@b.c', {}], ['/send', { method: 'POST', body: '{}' }], ['/nope', {}]] as const) {
      for (const [e, token] of [[env, null], [env, 'worker-token-12'], [env, TOKEN + 'x'], [shut, null], [shut, '']] as const) {
        const res = await handleFetch(req(path, { ...init, token }), e)
        assert.equal(res.status, 401, `${path} ${token}`)
        bodies.add(await res.text())
      }
    }
    assert.deepEqual([...bodies], ['{"error":"unauthorized"}'])
    assert.match(errors.join('\n'), /API_TOKEN is not set/)
  } finally {
    console.error = log
  }
  for (const scheme of ['Bearer', 'bearer', 'BEARER']) {
    const r = new Request('https://worker.example/health', { headers: { Authorization: `${scheme} ${TOKEN}` } })
    assert.equal((await handleFetch(r, env)).status, 200)
  }
  assert.equal((await handleFetch(req('/nope'), env)).status, 404)
})

test('worker: /health runs a query on the mail table and reports the version, the schema and bad settings', async () => {
  const env = await makeEnv()
  assert.deepEqual(await (await handleFetch(req('/health'), env)).json(), { ok: true, version: WORKER_VERSION, schema: true, retentionHours: 168 })
  const empty = await makeEnv()
  await (empty.DB as FakeD1).exec('DROP TABLE mail')
  const h: any = await (await handleFetch(req('/health'), empty)).json()
  assert.equal(h.ok, false)
  assert.equal(h.schema, false)
  assert.match(h.problems[0], /no mail table .*Apply schema\.sql/)
  const bad: any = await (await handleFetch(req('/health'), await makeEnv({ RETENTION_HOURS: 'a week', SENDER: '' }))).json()
  assert.equal(bad.ok, false)
  assert.equal(bad.retentionHours, 168)
  assert.match(bad.problems.join('\n'), /RETENTION_HOURS "a week" is not a positive number/)
  assert.match(bad.problems.join('\n'), /SENDER/)
})

test('worker: /inbound lists one address (all its tags) inside the retention period, removes old mail, and reports the retention', async () => {
  const env = await makeEnv({ RETENTION_HOURS: '24' })
  const now = Date.now()
  await handleEmail(inbound({ to: 'bot+a@example.org', body: 'old' }) as any, env, now - 25 * 3600_000)
  await handleEmail(inbound({ to: 'bot+b@example.org', body: 'first' }) as any, env, now - 3600_000)
  await handleEmail(inbound({ to: 'Bot+C@example.org', body: 'second' }) as any, env, now - 60_000)
  await handleEmail(inbound({ to: 'other@example.org', body: 'other' }) as any, env, now - 60_000)
  // Without since: the newest first, as older CLIs expect.
  const res = await handleFetch(req('/inbound?address=bot%40example.org'), env, now)
  const data = (await res.json()) as any
  assert.deepEqual(data.messages.map((m: any) => m.rcpt), ['bot+c@example.org', 'bot+b@example.org'])
  assert.equal(data.retentionHours, 24)
  assert.equal((await handleFetch(req('/inbound'), env)).status, 400)
  // The list removed the old mail.
  const left = (await env.DB.prepare('SELECT rcpt FROM mail ORDER BY rcpt').all<any>()).results.map((r: any) => r.rcpt)
  assert.deepEqual(left, ['bot+b@example.org', 'bot+c@example.org', 'other@example.org'])
  await worker.scheduled({}, { ...env, RETENTION_HOURS: '0.001' })
  assert.equal((await env.DB.prepare('SELECT count(*) AS n FROM mail').first<any>())!.n, 0)
  // A wrong RETENTION_HOURS keeps the default instead of removing everything.
  await handleEmail(inbound({ to: 'bot@example.org' }) as any, env, now - 100 * 3600_000)
  await cleanup({ ...env, RETENTION_HOURS: '-1' }, now)
  assert.equal((await env.DB.prepare('SELECT count(*) AS n FROM mail').first<any>())!.n, 1)
})

test('worker: /inbound with since pages oldest first under a size budget, in the order mail arrived', async () => {
  const env = await makeEnv()
  const now = Date.now()
  for (let i = 0; i < 230; i++) await handleEmail(inbound({ to: `bot+x${i}@example.org`, body: `m${i}` }) as any, env, now - 1000 + (i < 5 ? 0 : i))
  const seen: string[] = []
  let after = ''
  let pages = 0
  for (;;) {
    const data: any = await (await handleFetch(req(`/inbound?address=bot%40example.org&since=0${after ? `&after=${after}` : ''}`), env, now)).json()
    pages++
    seen.push(...data.messages.map((m: any) => m.rcpt.replace(/^bot\+|@.*$/g, '')))
    if (!data.more) { assert.equal(data.next, null); break }
    after = data.next
  }
  assert.equal(pages, 3)
  assert.deepEqual(seen, Array.from({ length: 230 }, (_, i) => `x${i}`))
  const later: any = await (await handleFetch(req(`/inbound?address=bot%40example.org&since=${now - 1000 + 200}`), env, now)).json()
  assert.equal(later.messages.length, 30)
})

test('worker: /send sends only as its SENDER, only the headers the CLI sends, never a line break in a header', async () => {
  const env = await makeEnv()
  const headers = { 'Auto-Submitted': 'auto-generated', 'X-Loop': 'clankerinbox', 'In-Reply-To': '<a@b>', References: '<a@b>' }
  const body = { from: 'Bot <bot@example.org>', to: [OWNER], replyTo: 'bot+q1@example.org', subject: 'Hi', text: 'Hello', headers }
  const send = (b: unknown) => handleFetch(req('/send', { method: 'POST', body: JSON.stringify(b) }), env)
  const ok = await send(body)
  assert.equal(ok.status, 200)
  assert.deepEqual(await ok.json(), { messageId: '<cf-1@example.org>' })
  const { headers: sentHeaders, ...rest } = env.sent[0]
  assert.deepEqual(rest, { from: body.from, to: body.to, replyTo: body.replyTo, subject: body.subject, text: body.text })
  assert.deepEqual(sentHeaders, headers)

  // Another sender, a header the CLI never sends, a line break anywhere in a header value: refused.
  const refused = async (b: unknown, status: number, error: RegExp) => {
    const r = await send(b)
    assert.equal(r.status, status, JSON.stringify(b))
    assert.match(((await r.json()) as any).error, error)
  }
  await refused({ ...body, from: 'Bot <ceo@example.org>' }, 403, /from_not_allowed/)
  await refused({ ...body, from: 'bot@example.org.evil' }, 403, /from_not_allowed/)
  await refused({ ...body, from: 'a <bot@example.org> <x@evil.example>' }, 403, /from_not_allowed/)
  await refused({ ...body, headers: { ...headers, Bcc: 'x@evil.example' } }, 400, /header_not_allowed/)
  await refused({ ...body, headers: { From: 'ceo@example.org' } }, 400, /header_not_allowed/)
  for (const bad of [{ subject: 'Hi\r\nBcc: x@evil.example' }, { replyTo: 'a@b.c\nBcc: x@evil.example' }, { to: ['a@b.c\r\nX: y'] }, { from: 'Bot\r\n <bot@example.org>' }, { headers: { 'X-Loop': 'a\u0000' } }]) {
    await refused({ ...body, ...bad }, 400, /control_character/)
  }
  await refused({ ...body, headers: { a: 1 } }, 400, /headers must map/)
  await refused({ ...body, to: [] }, 400, /to is required/)
  assert.equal((await handleFetch(req('/send', { method: 'POST', body: '{' }), env)).status, 400)
  assert.equal(env.sent.length, 1)

  // No from: the Worker's own sender. A binding that reports no id: null, and the mail went out.
  const quiet = await makeEnv()
  quiet.EMAIL = { async send(m: any) { quiet.sent.push(m); return undefined } }
  const r = await handleFetch(req('/send', { method: 'POST', body: JSON.stringify({ ...body, from: undefined }) }), quiet)
  assert.equal(r.status, 200)
  assert.equal(quiet.sent[0].from, 'bot@example.org')
  assert.deepEqual(await r.json(), { messageId: null, sent: true })

  // No SENDER: nothing goes out.
  const none = await makeEnv({ SENDER: '' })
  const log = console.error
  console.error = () => {}
  try {
    assert.equal((await handleFetch(req('/send', { method: 'POST', body: JSON.stringify(body) }), none)).status, 500)
  } finally {
    console.error = log
  }
  assert.equal(none.sent.length, 0)
})

test('worker: /send reports an unverified recipient as a refusal with what to do, other errors as temporary', async () => {
  const env = await makeEnv()
  const body = JSON.stringify({ from: 'bot@example.org', to: [OWNER], subject: 'Hi', text: 'Hello' })
  const logged: string[] = []
  const log = console.error
  console.error = (m: string) => { logged.push(m) }
  try {
    env.failNext = 'E_RECIPIENT_NOT_ALLOWED'
    const bad = await handleFetch(req('/send', { method: 'POST', body }), env)
    assert.equal(bad.status, 422)
    assert.equal(((await bad.json()) as any).error, 'recipient_not_verified')
    env.failNext = 'E_INTERNAL'
    assert.equal((await handleFetch(req('/send', { method: 'POST', body }), env)).status, 502)
  } finally {
    console.error = log
  }
  // Each refusal is in the Worker's log with Email Service's own code.
  assert.deepEqual(logged.map((l) => l.split(': ').slice(0, 3).join(': ')), ['clankerinbox: send failed: E_RECIPIENT_NOT_ALLOWED', 'clankerinbox: send failed: E_INTERNAL'])

  const config = cfConfig(await serveWorker(env))
  // A config whose from is not the Worker's sender: a config problem, not a wrong token.
  const other = new ClankerInbox({ config: { ...config, from: 'Bot <ceo@example.org>' }, stateDir: mkdtempSync(join(tmpdir(), 'ci-cf-')), env: { [TOKEN_ENV]: TOKEN } })
  await assert.rejects(other.send({ subject: 'x', text: 'y' }), (e: any) => {
    assert.equal(e.kind, 'config')
    assert.match(e.message, /sends only as bot@example\.org\. Set "from" in the config/)
    return true
  })
  env.failNext = 'E_RECIPIENT_NOT_ALLOWED'
  const ci = new ClankerInbox({ config, stateDir: mkdtempSync(join(tmpdir(), 'ci-cf-')), env: { [TOKEN_ENV]: TOKEN } })
  await assert.rejects(ci.ask({ to: OWNER, question: 'Ship it?' } as any), (e: any) => {
    assert.equal(e.kind, 'refused')
    assert.match(e.message, /owner@example\.org is not a verified destination address\. On the Workers Free plan, .*Destination addresses.*Workers Paid/)
    return true
  })
})

test('poll: pages through every stored mail, so 150 strangers never hide the owner\'s answer, and reads each mail once', async () => {
  const env = await makeEnv()
  const config = cfConfig(await serveWorker(env))
  // A second inbox on the same Worker, with its own mail.
  config.inboxes.billing = { id: 'billing@example.org', address: 'billing@example.org', mode: 'answers', allow: [OWNER], send: [OWNER] }
  const ci = new ClankerInbox({ config, stateDir: mkdtempSync(join(tmpdir(), 'ci-cf-')), env: { [TOKEN_ENV]: TOKEN } })
  const q = await ci.ask({ to: OWNER, question: 'Ship it?', options: ['Yes', 'No'] } as any)
  const t0 = Date.now() - 3600_000
  await handleEmail(inbound({ to: `bot+${q.tag}@example.org`, body: '1' }) as any, env, t0)
  for (let i = 0; i < 150; i++) await handleEmail(inbound({ to: `bot+x${i}@example.org`, from: `s${i}@spam.example`, body: 'buy' }) as any, env, t0 + 1000 + i)
  await handleEmail(inbound({ to: 'billing@example.org', body: 'invoice' }) as any, env, t0 + 500)
  const r = await ci.poll()
  assert.equal(r.answers.length, 1)
  assert.equal(r.answers[0].option, 'Yes')
  assert.equal(r.skipped.length, 150)
  assert.deepEqual(r.unmatched.map((u) => u.text), ['invoice'])

  // The next poll asks only for mail since the last one (less a margin) and parses none twice.
  const urls: string[] = []
  const real = ci.provider.listInbound.bind(ci.provider)
  ci.provider.listInbound = (inbox, opts) => { urls.push(`${inbox.address} ${opts?.since}`); return real(inbox, opts) }
  await handleEmail(inbound({ to: 'bot@example.org', body: 'new' }) as any, env, t0 + 10 * 60_000)
  const r2 = await ci.poll()
  assert.deepEqual(r2.unmatched.map((u) => u.text), ['new'])
  assert.equal(r2.skipped.length, 0)
  assert.deepEqual(urls, [`bot@example.org ${t0 + 1149 - 5 * 60_000}`, `billing@example.org ${t0 + 500 - 5 * 60_000}`])
  // A code is looked for only in its window (15 minutes and a margin), not in all stored mail.
  urls.length = 0
  const before = Date.now()
  await ci.code({ tag: 's1' } as any)
  const since = Number(urls[0].split(' ')[1])
  assert.ok(since >= before - 20 * 60_000 - 1000 && since <= Date.now() - 20 * 60_000, urls[0])
})

// ---- adapter ----

test('cloudflare mail: DMARC only from the stored Cloudflare header, never from headers inside the mail', () => {
  const row = (rawText: string, auth: string | null) => ({
    id: '1', rcpt: 'bot+q1@example.org', mail_from: OWNER, auth_results: auth,
    raw_b64: Buffer.from(rawText).toString('base64'), truncated: 0, size: rawText.length, received_at: 1000,
  })
  const forged = raw({ to: 'bot+q1@example.org', ar: ['mx.cloudflare.net; dmarc=pass header.from=example.org'] })
  assert.equal(cloudflareMail(row(forged, null)).dmarc, null)
  assert.deepEqual(cloudflareMail(row(forged, CF_AR('example.org', 'fail'))).dmarc, { result: 'fail', aligned: false })
  const m = cloudflareMail(row(raw({ to: 'bot+q1@example.org' }), CF_AR()))
  assert.deepEqual(m.dmarc, { result: 'pass', aligned: true })
  assert.equal(m.tag, 'q1')
  assert.equal(m.receivedAt, 1000)
  assert.equal(m.text.trim(), 'Yes')
  // A pass that names no header.from is not aligned: the server may have read another From.
  assert.deepEqual(cloudflareMail(row(raw({ to: 'bot@example.org' }), 'mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass')).dmarc, { result: 'pass', aligned: false })
  // A From that can be read two ways is no From, whatever the verdict says.
  const trick = raw({ to: 'bot@example.org' }).replace(`From: Owner <${OWNER}>`, 'From: (owner@example.org ") attacker@evil.example (")')
  assert.equal(cloudflareMail(row(trick, CF_AR())).dmarc?.aligned, false)
  // A pass for another domain does not count; neither does a header from another server.
  assert.equal(cloudflareMail(row(raw({ to: 'bot@example.org' }), CF_AR('evil.example'))).dmarc?.aligned, false)
  assert.equal(cloudflareMail(row(raw({ to: 'bot@example.org' }), 'evil.example; dmarc=pass header.from=example.org')).dmarc, null)
  assert.equal(cloudflareMail({ ...row(raw({ to: 'bot@example.org' }), CF_AR()), mail_from: '<>' }).mailFrom, '')
})

test('cloudflare config: needs url and tokenEnv, https, and no token in the file', () => {
  const base = { provider: 'cloudflare', teamId: '', from: 'bot@example.org', inboxes: {} } as any
  assert.throws(() => validateConfig({ ...base }), /cloudflare needs url and tokenEnv/)
  assert.throws(() => validateConfig({ ...base, cloudflare: { url: 'http://worker.example', tokenEnv: 'T' } }), /https/)
  assert.throws(() => validateConfig({ ...base, cloudflare: { url: 'https://worker.example', tokenEnv: 'T', token: 'x' } }), /env var/)
  validateConfig({ ...base, cloudflare: { url: 'https://worker.example', tokenEnv: 'T' } })
  validateConfig({ ...base, cloudflare: { url: 'http://127.0.0.1:8787', tokenEnv: 'T' } })
})

// The real Worker code behind a local HTTP server, standing in for the deployed Worker.
const servers: Server[] = []
after(() => servers.forEach((s) => s.close()))

async function serveWorker(env: WorkerEnv): Promise<string> {
  const server = createServer(async (r, w) => {
    const chunks: Buffer[] = []
    for await (const c of r) chunks.push(c as Buffer)
    const body = chunks.length ? Buffer.concat(chunks) : undefined
    const res = await handleFetch(new Request('http://127.0.0.1' + r.url, { method: r.method, headers: r.headers as any, body }), env)
    w.writeHead(res.status, Object.fromEntries(res.headers))
    w.end(Buffer.from(await res.arrayBuffer()))
  })
  servers.push(server)
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  return `http://127.0.0.1:${(server.address() as any).port}`
}

function cfConfig(url: string): Config {
  return {
    provider: 'cloudflare',
    teamId: '',
    from: 'Bot <bot@example.org>',
    cloudflare: { url, tokenEnv: TOKEN_ENV },
    inboxes: {
      ask: { id: 'bot@example.org', address: 'bot@example.org', mode: 'answers', allow: [OWNER], send: [OWNER] },
      signup: { id: 'signup@example.org', address: 'signup@example.org', mode: 'codes', allow: '*', send: [] },
    },
  }
}

test('cloudflare end to end: ask through the Worker, a forged answer is ignored, the real one counts; codes work', async () => {
  const env = await makeEnv()
  const config = cfConfig(await serveWorker(env))
  validateConfig(config)
  const ENV = { [TOKEN_ENV]: TOKEN }
  assert.equal(createProvider(config, ENV).name, 'cloudflare')
  const ci = new ClankerInbox({ config, stateDir: mkdtempSync(join(tmpdir(), 'ci-cf-')), env: ENV })
  const q = await ci.ask({ to: OWNER, question: 'Ship it?', options: ['Yes', 'No'] } as any)
  assert.equal(env.sent.length, 1)
  assert.equal(env.sent[0].replyTo, `bot+${q.tag}@example.org`)
  assert.equal(env.sent[0].headers!['Auto-Submitted'], 'auto-generated')
  // Email Service's id comes back without its angle brackets, as on PostShiba.
  assert.equal(q.messageId, 'cf-1@example.org')

  // The sender wrote a passing Cloudflare-looking header; Cloudflare's own says fail.
  await handleEmail(inbound({ to: `bot+${q.tag}@example.org`, body: '1', cfAr: CF_AR('example.org', 'fail'), ar: ['mx.cloudflare.net; dmarc=pass header.from=example.org'] }) as any, env)
  const first = await ci.poll({} as any)
  assert.equal(JSON.stringify(first).includes('"answer"'), false)
  await handleEmail(inbound({ to: `bot+${q.tag}@example.org`, body: '1' }) as any, env)
  const second: any = await ci.poll({} as any)
  assert.match(JSON.stringify(second), /"Yes"/)

  await handleEmail(inbound({ to: 'signup+s1@example.org', from: 'no-reply@service.example', subject: 'Your code', body: 'Your code is 482913' }) as any, env)
  const code = await ci.code({ tag: 's1', from: 'service.example' } as any)
  assert.equal(code?.code, '482913')

  // Email Service sent the mail but reported no id: the send still counts as sent.
  const quiet = await makeEnv()
  quiet.EMAIL = { async send(m: any) { quiet.sent.push(m); return undefined } }
  const silent = await new CloudflareProvider(cfConfig(await serveWorker(quiet)), ENV).send({ from: 'bot@example.org', to: [OWNER], subject: 'x', text: 'y', headers: {} } as any)
  assert.deepEqual(silent, { messageId: null })
  assert.equal(quiet.sent.length, 1)

  await assert.rejects(new CloudflareProvider(config, {}).listInbound(config.inboxes.ask), /set TEST_CF_TOKEN/)
  await assert.rejects(new CloudflareProvider(config, { [TOKEN_ENV]: 'wrong' }).listInbound(config.inboxes.ask), /401/)
  assert.equal(parseMail(Buffer.from('Subject: x\r\n\r\ny')).subject, 'x')
})

test('poll: the HTML part of a Gmail reply marks its signature, so the answer is only what the owner wrote', async () => {
  const env = await makeEnv()
  const config = cfConfig(await serveWorker(env))
  const ci = new ClankerInbox({ config, stateDir: mkdtempSync(join(tmpdir(), 'ci-cf-')), env: { [TOKEN_ENV]: TOKEN } })
  const q = await ci.ask({ to: OWNER, question: 'Ship it?', options: ['Yes', 'No'] } as any)
  const html = '<div dir="auto">Yes</div><div><br clear="all"><div><div dir="ltr" class="gmail_signature" data-smartmail="gmail_signature">'
    + '<div dir="ltr">Owner Name<div>Founder at ExampleCo</div></div></div></div></div><br><div class="gmail_quote gmail_quote_container">'
    + '<div dir="ltr" class="gmail_attr">On Tue, Bot &lt;bot@example.org&gt; wrote:<br></div><blockquote class="gmail_quote">Ship it?</blockquote></div>'
  const text = 'Yes\r\n\r\n\r\nOwner Name\r\nFounder at ExampleCo\r\n\r\nOn Tue, Bot <bot@example.org> wrote:\r\n\r\n> Ship it?\r\n'
  const body = [
    'Content-Type: multipart/alternative; boundary="b1"', '', '--b1', 'Content-Type: text/plain; charset="UTF-8"', '', text,
    '--b1', 'Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: quoted-printable', '',
    html.replace(/=/g, '=3D').replace(/(.{70})/g, '$1=\r\n'), '--b1--', '',
  ].join('\r\n')
  const mail = raw({ to: `bot+${q.tag}@example.org`, ar: [CF_AR()], body: '' }).replace('Content-Type: text/plain; charset=utf-8\r\n\r\n\r\n', '') + body
  const headers = new Headers()
  headers.append('Authentication-Results', CF_AR())
  await handleEmail({ from: OWNER, to: `bot+${q.tag}@example.org`, headers, raw: new Blob([mail]).stream(), rawSize: mail.length, setReject() {} } as any, env)
  const r = await ci.poll()
  assert.deepEqual(r.answers.map((a) => [a.answer, a.option]), [['Yes', 'Yes']])
})
