// One safety suite for every provider. Each provider gets a harness that delivers the same
// mails through its own fake (PostShiba's API, the Cloudflare Worker on D1), and every rule
// must hold the same way for both.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakePostShiba, SEND_KEY, FULL_KEY, TEAM } from './fake-postshiba.ts'
import { FakeD1 } from './fake-d1.ts'
import { SCHEMA, handleEmail, handleFetch, type WorkerEnv } from '../cloudflare/worker.ts'
import { ClankerInbox } from '../src/clankerinbox.ts'
import { validateConfig, type Config, type InboxConfig } from '../src/config.ts'
import type { ProviderName } from '../src/provider.ts'

const OWNER = 'owner@example.org'
const STRANGER = 'mallory@evil.example'
const SERVICE = 'no-reply@service.example'
const ASK = 'bot@inbox.example.dev'
const SIGNUP = 'signup@inbox.example.dev'

// How a trusted party judged the mail's DMARC:
// pass = aligned pass; unaligned = pass for another domain; fail; none = no trusted result;
// forged = the trusted party says fail, and the sender wrote its own passing header.
type Auth = 'pass' | 'unaligned' | 'fail' | 'none' | 'forged'

interface Delivery {
  from: string
  to: string
  subject?: string
  text: string
  auth?: Auth
  headers?: Record<string, string>
  // An empty envelope sender: a bounce.
  bounce?: boolean
}

interface SentMail { to: string[]; headers: Record<string, string> }

interface Harness {
  name: ProviderName
  ci: ClankerInbox
  deliver(d: Delivery): Promise<void>
  sent(): SentMail[]
}

function inboxes(): Record<string, InboxConfig> {
  return {
    ask: { id: '', address: ASK, mode: 'answers', allow: [OWNER], send: [OWNER] },
    signup: { id: '', address: SIGNUP, mode: 'codes', allow: '*', send: [] },
  }
}

const stateDir = () => mkdtempSync(join(tmpdir(), 'ci-shared-'))
const domain = (a: string) => a.split('@')[1]
const lower = (h: Record<string, unknown>) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), String(v)]))

// The raw mail the Cloudflare harness stores, with the given Authentication-Results on top.
function rawMail(d: Delivery, ar: string[], extra: string[] = []): string {
  return [
    ...extra,
    ...ar.map((a) => `Authentication-Results: ${a}`),
    `From: Sender <${d.from}>`,
    `To: ${d.to}`,
    `Subject: ${d.subject ?? 'Re: question'}`,
    `Message-ID: <${Math.random().toString(36).slice(2)}@${domain(d.from)}>`,
    ...Object.entries(d.headers || {}).map(([k, v]) => `${k}: ${v}`),
    'Content-Type: text/plain; charset=utf-8',
    '',
    d.text,
    '',
  ].join('\r\n')
}

// The trusted server's header for each Auth case, plus what the sender wrote under it.
function authHeaders(trusted: string, d: Delivery): { server: string | null; sender: string[] } {
  const own = domain(d.from)
  const ar = (result: string, from = own) => `${trusted}; spf=pass smtp.mailfrom=${from}; dkim=pass header.d=${from}; dmarc=${result} header.from=${from}`
  switch (d.auth ?? 'pass') {
    case 'pass': return { server: ar('pass'), sender: [] }
    case 'unaligned': return { server: ar('pass', 'other.example'), sender: [] }
    case 'fail': return { server: ar('fail'), sender: [] }
    case 'none': return { server: null, sender: [] }
    case 'forged': return { server: ar('fail'), sender: [`${trusted}; dmarc=pass header.from=${own}`] }
  }
}

const cleanup: (() => unknown)[] = []
after(async () => { for (const c of cleanup) await c() })

async function postshiba(): Promise<Harness> {
  const fake = new FakePostShiba()
  await fake.start()
  cleanup.push(() => fake.stop())
  const config: Config = { teamId: TEAM, from: `Bot <${ASK}>`, apiUrl: fake.url, inboxes: inboxes() }
  config.inboxes.ask.id = fake.addInbox(ASK).id
  config.inboxes.signup.id = fake.addInbox(SIGNUP).id
  validateConfig(config)
  const env = { POSTSHIBA_SEND_API_KEY: SEND_KEY, POSTSHIBA_FULL_API_KEY: FULL_KEY }
  const ci = new ClankerInbox({ config, env, stateDir: stateDir() })
  return {
    name: 'postshiba',
    ci,
    async deliver(d) {
      const inbox = d.to.split('+')[0].split('@')[0] === 'signup' ? config.inboxes.signup : config.inboxes.ask
      const auth = d.auth ?? 'pass'
      const dmarc = auth === 'pass' ? { result: 'pass', aligned: true }
        : auth === 'unaligned' ? { result: 'pass', aligned: false }
        : auth === 'none' ? null
        : { result: 'fail', aligned: false }
      // PostShiba checks DMARC itself; a header the sender wrote changes nothing.
      const forgedHeader = auth === 'forged' ? { 'authentication-results': `mx.postshiba.com; dmarc=pass header.from=${domain(d.from)}` } : {}
      fake.deliver(inbox.id, {
        from: d.from, to: d.to, subject: d.subject ?? 'Re: question', text: d.text,
        headers: { ...forgedHeader, ...lower(d.headers || {}) } as any,
        authentication: { dmarc: dmarc as any, arc: { result: 'none' } } as any,
        envelope: { rcpt_to: d.to, mail_from: d.bounce ? '' : `bounce@${domain(d.from)}` } as any,
      })
    },
    sent: () => fake.sends.map((s) => ({ to: [s.body.to].flat(), headers: lower(s.body.headers || {}) })),
  }
}

async function cloudflare(): Promise<Harness> {
  const db = new FakeD1()
  await db.exec(SCHEMA)
  const sent: { to: string[]; headers?: Record<string, string> }[] = []
  const workerEnv: WorkerEnv = {
    DB: db,
    EMAIL: { async send(m: any) { sent.push(m); return { messageId: `<cf-${sent.length}@inbox.example.dev>` } } },
    API_TOKEN: 'worker-token',
    SENDER: ASK,
  }
  // The real Worker code behind a local HTTP server, standing in for the deployed Worker.
  const server: Server = createServer(async (r, w) => {
    const chunks: Buffer[] = []
    for await (const c of r) chunks.push(c as Buffer)
    const body = chunks.length ? Buffer.concat(chunks) : undefined
    const res = await handleFetch(new Request('http://127.0.0.1' + r.url, { method: r.method, headers: r.headers as any, body }), workerEnv)
    w.writeHead(res.status, Object.fromEntries(res.headers))
    w.end(Buffer.from(await res.arrayBuffer()))
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  cleanup.push(() => new Promise((r) => server.close(r)))
  const config: Config = {
    provider: 'cloudflare',
    teamId: '',
    from: `Bot <${ASK}>`,
    cloudflare: { url: `http://127.0.0.1:${(server.address() as any).port}`, tokenEnv: 'TEST_CF_TOKEN' },
    inboxes: inboxes(),
  }
  config.inboxes.ask.id = ASK
  config.inboxes.signup.id = SIGNUP
  validateConfig(config)
  const ci = new ClankerInbox({ config, env: { TEST_CF_TOKEN: 'worker-token' }, stateDir: stateDir() })
  return {
    name: 'cloudflare',
    ci,
    async deliver(d) {
      const { server: cf, sender } = authHeaders('mx.cloudflare.net', d)
      // Email Routing prepends its own Authentication-Results to the mail's headers.
      const ar = [...(cf ? [cf] : []), ...sender]
      const headers = new Headers()
      for (const v of ar) headers.append('Authentication-Results', v)
      const text = rawMail(d, ar)
      await handleEmail({
        from: d.bounce ? '<>' : d.from, to: d.to, headers,
        raw: new Blob([text]).stream(), rawSize: Buffer.byteLength(text),
        setReject() {},
      } as any, workerEnv)
    },
    sent: () => sent.map((m) => ({ to: m.to, headers: lower(m.headers || {}) })),
  }
}

const HARNESSES: [ProviderName, () => Promise<Harness>][] = [['postshiba', postshiba], ['cloudflare', cloudflare]]

// The plus-tagged reply address of a question, as the owner's mail client writes back to it.
const replyTo = (tag: string) => ASK.replace('@', `+${tag}@`)

for (const [name, make] of HARNESSES) {
  test(`${name}: receive allowlist — a stranger's reply is no answer; an empty allowlist lets nobody in`, async () => {
    const h = await make()
    const q = await h.ci.ask({ question: 'Ship it?', options: ['Yes', 'No'] })
    await h.deliver({ from: STRANGER, to: replyTo(q.tag), text: '1' })
    let r = await h.ci.poll()
    assert.equal(r.answers.length, 0)
    assert.match(r.skipped.map((s) => s.reason).join('|'), /not on the allowlist|allowlist/)

    h.ci.config.inboxes.ask.allow = []
    await h.deliver({ from: OWNER, to: replyTo(q.tag), text: '1' })
    r = await h.ci.poll()
    assert.equal(r.answers.length, 0)
    assert.match(r.skipped.map((s) => s.reason).join('|'), /allowlist is empty/)
  })

  test(`${name}: DMARC must pass aligned — unaligned, fail, missing and forged results are no answer`, async () => {
    const h = await make()
    const q = await h.ci.ask({ question: 'Ship it?', options: ['Yes', 'No'] })
    for (const auth of ['unaligned', 'fail', 'none', 'forged'] as Auth[]) {
      await h.deliver({ from: OWNER, to: replyTo(q.tag), text: '1', auth })
      const r = await h.ci.poll()
      assert.equal(r.answers.length, 0, `${auth} mail became an answer`)
      assert.deepEqual(r.skipped.map((s) => s.reason), ['DMARC did not pass aligned'], auth)
    }
    await h.deliver({ from: OWNER, to: replyTo(q.tag), text: '1' })
    const r = await h.ci.poll()
    assert.deepEqual(r.answers.map((a) => [a.tag, a.option]), [[q.tag, 'Yes']])
  })

  test(`${name}: send allowlist — only allowlisted recipients and own inboxes; plus tags widen nothing`, async () => {
    const h = await make()
    await assert.rejects(h.ci.send({ to: STRANGER, subject: 'Hi', text: 'x' }), /send allowlist/)
    await assert.rejects(h.ci.send({ to: `${OWNER}, ${STRANGER}`, subject: 'Hi', text: 'x' }), /refused/)
    await assert.rejects(h.ci.send({ to: 'mallory+owner@evil.example', subject: 'Hi', text: 'x' }), /send allowlist/)
    assert.equal(h.sent().length, 0)
    await h.ci.send({ to: 'owner+note@example.org', subject: 'Hi', text: 'x' })
    await h.ci.send({ to: SIGNUP.replace('@', '+t1@'), subject: 'Hi', text: 'x' })
    assert.deepEqual(h.sent().map((s) => s.to), [['owner+note@example.org'], ['signup+t1@inbox.example.dev']])
  })

  test(`${name}: loop headers — every mail out carries them; auto-replies, list, bulk and bounced mail in are no answer`, async () => {
    const h = await make()
    const q = await h.ci.ask({ question: 'Ship it?', options: ['Yes', 'No'] })
    const out = h.sent()
    assert.equal(out.length, 1)
    assert.equal(out[0].headers['auto-submitted'], 'auto-generated')
    assert.equal(out[0].headers['x-loop'], 'clankerinbox')

    const marks: Record<string, string>[] = [
      { 'Auto-Submitted': 'auto-replied' },
      { 'Auto-Submitted': 'auto-notified' },
      { 'X-Loop': 'someone' },
      { 'X-Loop': 'clankerinbox', 'Auto-Submitted': 'auto-replied' },
      { Precedence: 'bulk' },
      { Precedence: 'bulk; x=1' },
      { Precedence: 'junk' },
      { Precedence: 'list' },
      { 'X-Autoreply': 'yes' },
      { 'X-Autorespond': 'yes' },
      { 'List-Id': '<team.lists.example.org>' },
      { 'List-Unsubscribe': '<mailto:leave@example.org>' },
    ]
    for (const headers of marks) await h.deliver({ from: OWNER, to: replyTo(q.tag), text: '1', headers })
    await h.deliver({ from: OWNER, to: replyTo(q.tag), text: '1', bounce: true })
    const r = await h.ci.poll()
    assert.equal(r.answers.length, 0)
    assert.equal(r.unmatched.length, 0)
    const reasons = r.skipped.map((s) => s.reason)
    assert.equal(reasons.length, marks.length + 1)
    assert.equal(reasons.filter((x) => x.startsWith('automated mail')).length, marks.length)
    assert.ok(reasons.includes('bounce'))
    assert.ok(reasons.includes('automated mail (a mailing list)'))
    assert.ok(reasons.includes('automated mail (an auto-reply)'))

    // The marks of another agent of this tool alone (PostShiba adds Auto-Submitted to all it sends)
    // are no reason to skip the mail of an allowed sender.
    await h.deliver({ from: OWNER, to: replyTo(q.tag), text: '2', headers: { 'Auto-Submitted': 'auto-generated', 'X-Loop': 'clankerinbox' } })
    const agent = await h.ci.poll()
    assert.deepEqual(agent.answers.map((a) => [a.tag, a.option]), [[q.tag, 'No']])
  })

  test(`${name}: allowAutomated — every automated mail of an allowed sender counts`, async () => {
    const h = await make()
    h.ci.config.inboxes.ask.allowAutomated = true
    const q = await h.ci.ask({ question: 'Ship it?', options: ['Yes', 'No'] })
    await h.deliver({ from: OWNER, to: replyTo(q.tag), text: '1', headers: { 'Auto-Submitted': 'auto-replied', Precedence: 'bulk' } })
    const r = await h.ci.poll()
    assert.deepEqual(r.answers.map((a) => [a.tag, a.option]), [[q.tag, 'Yes']])
  })

  test(`${name}: caps — the hourly send cap and the per-sender receive cap hold`, async () => {
    const h = await make()
    h.ci.config.caps = { sendPerHour: 2, receivePerSenderPerHour: 1 }
    await h.ci.send({ subject: 'One', text: 'x' })
    await h.ci.send({ subject: 'Two', text: 'x' })
    await assert.rejects(h.ci.send({ subject: 'Three', text: 'x' }), /limit of 2 sent mails in one hour/)
    assert.equal(h.sent().length, 2)

    await h.deliver({ from: OWNER, to: ASK, subject: 'Hello', text: 'first' })
    await h.deliver({ from: OWNER, to: ASK, subject: 'Hello again', text: 'second' })
    const r = await h.ci.poll()
    assert.deepEqual(r.unmatched.map((u) => u.text), ['first'])
    assert.deepEqual(r.skipped.map((s) => s.reason), ['hourly cap for this sender'])
  })

  test(`${name}: a waiter handles only mail of its own question; refused mail of others stays for poll`, async () => {
    const h = await make()
    const mine = await h.ci.ask({ question: 'Mine?', options: ['Yes', 'No'] })
    const other = await h.ci.ask({ question: 'Other?', options: ['Yes', 'No'] })
    await h.deliver({ from: STRANGER, to: replyTo(other.tag), text: '1' })
    await h.deliver({ from: OWNER, to: replyTo(other.tag), text: '2', auth: 'fail' })
    await h.deliver({ from: STRANGER, to: ASK, text: 'hello' })
    await h.deliver({ from: STRANGER, to: replyTo(mine.tag), text: '1' })
    const told: string[] = []
    assert.equal(await h.ci.waitForAnswer(mine.tag, { timeoutMs: 0, onSkipped: (s) => told.push(s.reason) }), null)
    // It tells of refused mail to its tag or from the person it asked (the README's rule), but handles only its own.
    assert.deepEqual(told.sort(), ['DMARC did not pass aligned', 'sender not on allowlist'])
    // The poll after the waiter shows each refused mail of the other questions, and not the waiter's own again.
    const r = await h.ci.poll()
    assert.deepEqual(r.skipped.map((s) => [s.tag ?? null, s.reason]).sort(), [
      [null, 'sender not on allowlist'], [other.tag, 'DMARC did not pass aligned'], [other.tag, 'sender not on allowlist'],
    ].sort())
    // Handled once: the next poll is empty, and a later answer still arrives.
    assert.deepEqual((await h.ci.poll()).skipped, [])
    await h.deliver({ from: OWNER, to: replyTo(mine.tag), text: '1' })
    assert.equal((await h.ci.waitForAnswer(mine.tag, { timeoutMs: 0 }))?.option, 'Yes')
  })

  test(`${name}: wait for an answer that poll handed out gives it again, marked delivered`, async () => {
    const h = await make()
    const q = await h.ci.ask({ question: 'Ship it?', options: ['Yes', 'No'] })
    await h.deliver({ from: OWNER, to: replyTo(q.tag), text: '1' })
    assert.equal((await h.ci.poll()).answers.length, 1)
    const again = await h.ci.waitForAnswer(q.tag, { timeoutMs: 0 })
    assert.equal(again?.option, 'Yes')
    assert.equal(again?.delivered, true)
    const q2 = await h.ci.ask({ question: 'Again?', options: ['Yes', 'No'] })
    await h.deliver({ from: OWNER, to: replyTo(q2.tag), text: '2' })
    const first = await h.ci.waitForAnswer(q2.tag, { timeoutMs: 0 })
    assert.equal(first?.delivered, undefined)
    assert.equal((await h.ci.waitForAnswer(q2.tag, { timeoutMs: 0 }))?.delivered, true)
  })

  test(`${name}: codes — only the code leaves, only from the expected domain with DMARC pass`, async () => {
    const h = await make()
    const to = SIGNUP.replace('@', '+s1@')
    const body = 'Hi! Your verification code is 482913. Private note: account 99887766 is yours.'
    await h.deliver({ from: 'no-reply@phish.example', to, subject: 'Your code', text: 'Your code is 111111' })
    await h.deliver({ from: SERVICE, to, subject: 'Your code', text: 'Your code is 222222', auth: 'forged' })
    assert.equal(await h.ci.code({ tag: 's1', from: 'service.example' }), null)
    await h.deliver({ from: SERVICE, to, subject: 'Your code', text: body })
    assert.deepEqual(await h.ci.code({ tag: 's1', from: 'service.example' }), { tag: 's1', code: '482913' })
    assert.equal(await h.ci.code({ tag: 's2', from: 'service.example' }), null)
    const log = JSON.stringify(h.ci.store.entries())
    assert.equal(log.includes('99887766'), false)
    assert.equal(log.includes('Private note'), false)
  })

  test(`${name}: quoted text is stripped — the quoted options are not read as the answer`, async () => {
    const h = await make()
    const q = await h.ci.ask({ question: 'Ship it?', options: ['Yes', 'No'] })
    const text = ['2', '', 'On Tue, 10 Nov 2026 at 10:00, Bot <bot@inbox.example.dev> wrote:', '> Ship it?', '>', '> 1. Yes', '> 2. No', ''].join('\n')
    await h.deliver({ from: OWNER, to: replyTo(q.tag), text })
    const r = await h.ci.poll()
    assert.equal(r.answers.length, 1)
    assert.equal(r.answers[0].answer, '2')
    assert.equal(r.answers[0].option, 'No')
  })
  test(`${name}: tags are case-insensitive — a tag with capitals matches the reply and the code`, async () => {
    const h = await make()
    const q = await h.ci.ask({ question: 'Deploy?', tag: 'Deploy42' })
    assert.equal(q.tag, 'deploy42')
    await h.deliver({ from: OWNER, to: ASK.replace('@', '+DEPLOY42@'), text: 'yes' })
    const r = await h.ci.poll()
    assert.deepEqual(r.answers.map((a) => [a.tag, a.answer]), [['deploy42', 'yes']])
    await h.deliver({ from: SERVICE, to: SIGNUP.replace('@', '+GH1@'), subject: 'Your code', text: 'Your code is 482913' })
    assert.deepEqual(await h.ci.code({ tag: 'GH1', from: 'service.example' }), { tag: 'gh1', code: '482913' })
  })
}
