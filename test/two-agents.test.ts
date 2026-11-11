// Two agents on two machines that mail each other: one asks, the other answers with
// `send --reply`, and the answer comes back as the answer to the question. Each machine runs on
// its own mail service (PostShiba, the Cloudflare Worker, or one of each), and a small network
// carries the mail between them the way the real services do: DMARC aligned, with the loop marks
// of the tool, PostShiba's own Auto-Submitted, and a Reply-To that PostShiba lists only in the
// raw mail.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { FakePostShiba, SEND_KEY, FULL_KEY, TEAM, sentMail } from './fake-postshiba.ts'
import { FakeD1 } from './fake-d1.ts'
import { SCHEMA, handleEmail, handleFetch, type WorkerEnv } from '../cloudflare/worker.ts'
import { ClankerInbox } from '../src/clankerinbox.ts'
import { validateConfig, type Config, type InboxConfig } from '../src/config.ts'
import type { ProviderName } from '../src/provider.ts'

const OWNER = 'owner@example.org'

const cleanup: (() => unknown)[] = []
after(async () => { for (const c of cleanup) await c() })

const addressOf = (v: string) => (String(v).match(/<([^>]+)>/) || [null, v])[1]!.toLowerCase()
const domainOf = (a: string) => a.slice(a.lastIndexOf('@') + 1)
const baseOf = (a: string) => { const [l, d] = a.toLowerCase().split('@'); return `${l.split('+')[0]}@${d}` }

// One mail between machines, in the shape every fake takes.
interface Wire { from: string; to: string; replyTo?: string; subject: string; text: string; headers: Record<string, string>; messageId: string }

// Where mail for an address is delivered: the machine that holds that inbox.
class Network {
  private routes = new Map<string, (w: Wire) => Promise<void>>()
  log: Wire[] = []
  add(address: string, deliver: (w: Wire) => Promise<void>) { this.routes.set(address.toLowerCase(), deliver) }
  async carry(w: Wire) {
    this.log.push(w)
    const route = this.routes.get(baseOf(w.to))
    if (route) await route(w)
  }
}

interface Machine { name: string; ci: ClankerInbox; address: string; from: string; requests?: string; sent(): number }

interface Spec {
  domain: string
  local?: string
  from?: string
  allow: string[]
  send: string[]
  // Also a requests inbox `do@<domain>` with the same lists.
  requests?: boolean
  caps?: Config['caps']
}

function inboxesFor(spec: Spec, id: (addr: string) => string): Record<string, InboxConfig> {
  const address = `${spec.local ?? 'agent'}@${spec.domain}`
  const out: Record<string, InboxConfig> = {
    agent: { id: id(address), address, mode: 'answers', allow: spec.allow, send: spec.send },
  }
  if (spec.requests) out.do = { id: id(`do@${spec.domain}`), address: `do@${spec.domain}`, mode: 'requests', allow: spec.allow, send: spec.send }
  return out
}

// A PostShiba machine. `shared`: the fake PostShiba of another machine of the same account.
async function postshibaMachine(net: Network, spec: Spec, shared?: FakePostShiba): Promise<Machine & { fake: FakePostShiba }> {
  const fake = shared ?? new FakePostShiba()
  if (!shared) {
    await fake.start()
    cleanup.push(() => fake.stop())
    fake.outside = (body, messageId) => void net.carry({
      from: body.from, to: body.to[0], replyTo: body.reply_to, subject: body.subject, text: body.text,
      headers: { 'Auto-Submitted': 'auto-generated', ...(body.headers || {}) }, messageId,
    })
  }
  const from = spec.from ?? `Clanker Inbox <clankerinbox@${spec.domain}>`
  const config: Config = { teamId: TEAM, from, apiUrl: fake.url, caps: spec.caps, inboxes: inboxesFor(spec, (a) => fake.addInbox(a).id) }
  validateConfig(config)
  for (const inbox of Object.values(config.inboxes)) {
    net.add(inbox.address, async (w) => {
      // Mail from another service: PostShiba checked DMARC, and lists only some headers.
      const body = { from: w.from, reply_to: w.replyTo, subject: w.subject, text: w.text, headers: w.headers }
      fake.deliver(inbox.id, sentMail(body, w.to, w.messageId))
    })
  }
  const ci = new ClankerInbox({ config, env: { POSTSHIBA_SEND_API_KEY: SEND_KEY, POSTSHIBA_FULL_API_KEY: FULL_KEY }, stateDir: mkdtempSync(join(tmpdir(), 'ci-two-')) })
  const fromAddr = addressOf(from)
  return {
    name: 'postshiba', ci, fake, address: config.inboxes.agent.address, from: fromAddr, requests: config.inboxes.do?.address,
    sent: () => fake.sends.filter((s) => addressOf(s.body.from) === fromAddr).length,
  }
}

async function cloudflareMachine(net: Network, spec: Spec): Promise<Machine> {
  const db = new FakeD1()
  await db.exec(SCHEMA)
  const sender = `clankerinbox@${spec.domain}`
  let sends = 0
  const workerEnv: WorkerEnv = {
    DB: db,
    EMAIL: {
      async send(m: any) {
        sends++
        const messageId = `${randomBytes(8).toString('hex')}@${spec.domain}`
        for (const to of [m.to].flat()) await net.carry({ from: m.from, to, replyTo: m.replyTo, subject: m.subject, text: m.text, headers: m.headers || {}, messageId })
        return { messageId: `<${messageId}>` }
      },
    },
    API_TOKEN: 'worker-token',
    SENDER: sender,
  }
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
    provider: 'cloudflare', teamId: '', from: `Clanker Inbox <${sender}>`, caps: spec.caps,
    cloudflare: { url: `http://127.0.0.1:${(server.address() as any).port}`, tokenEnv: 'TEST_CF_TOKEN' },
    inboxes: inboxesFor(spec, (a) => a),
  }
  validateConfig(config)
  for (const inbox of Object.values(config.inboxes)) {
    net.add(inbox.address, async (w) => {
      const fromDomain = domainOf(addressOf(w.from))
      const ar = `mx.cloudflare.net; spf=pass smtp.mailfrom=${fromDomain}; dkim=pass header.d=${fromDomain}; dmarc=pass header.from=${fromDomain}`
      const raw = [
        `Authentication-Results: ${ar}`, `From: ${w.from}`, ...(w.replyTo ? [`Reply-To: ${w.replyTo}`] : []), `To: ${w.to}`,
        `Subject: ${w.subject}`, `Message-ID: <${w.messageId}>`, ...Object.entries(w.headers).map(([k, v]) => `${k}: ${v}`),
        'Content-Type: text/plain; charset=utf-8', '', w.text, '',
      ].join('\r\n')
      const headers = new Headers()
      headers.append('Authentication-Results', ar)
      await handleEmail({
        from: `bounce@${fromDomain}`, to: w.to, headers, raw: new Blob([raw]).stream(), rawSize: Buffer.byteLength(raw), setReject() {},
      } as any, workerEnv)
    })
  }
  const ci = new ClankerInbox({ config, env: { TEST_CF_TOKEN: 'worker-token' }, stateDir: mkdtempSync(join(tmpdir(), 'ci-two-')) })
  return { name: 'cloudflare', ci, address: config.inboxes.agent.address, from: sender, requests: config.inboxes.do?.address, sent: () => sends }
}

const make = (kind: ProviderName) => (net: Network, spec: Spec) => (kind === 'postshiba' ? postshibaMachine(net, spec) : cloudflareMachine(net, spec))

// A on a.example and B on b.example, each with the other's sending address on its allow list and
// the other's inbox on its send list: the README's "Two agents" config.
async function pair(a: ProviderName, b: ProviderName, opts: { requests?: boolean; caps?: Config['caps'] } = {}) {
  const net = new Network()
  const A = await make(a)(net, { domain: 'a.example', allow: [OWNER, 'clankerinbox@b.example'], send: [OWNER, 'agent@b.example', 'do@b.example'], caps: opts.caps })
  const B = await make(b)(net, { domain: 'b.example', allow: [OWNER, 'clankerinbox@a.example'], send: [OWNER, 'agent@a.example'], requests: opts.requests, caps: opts.caps })
  return { net, A, B }
}

const PAIRS: [ProviderName, ProviderName][] = [['postshiba', 'postshiba'], ['cloudflare', 'cloudflare'], ['postshiba', 'cloudflare'], ['cloudflare', 'postshiba']]

for (const [a, b] of PAIRS) {
  const name = `${a} → ${b}`

  test(`${name}: A asks B, B answers with --reply, A gets the answer`, async () => {
    const { A, B, net } = await pair(a, b)
    const q = await A.ci.ask({ question: 'Is the build green?', options: ['Yes', 'No'], to: 'agent@b.example' })

    const atB = await B.ci.poll()
    assert.deepEqual(atB.skipped, [])
    assert.equal(atB.unmatched.length, 1)
    const mail = atB.unmatched[0]
    assert.equal(mail.from, 'clankerinbox@a.example')
    assert.equal(mail.agent, true)
    assert.equal(mail.reply, undefined)
    assert.equal(mail.messageId !== '', true)
    // PostShiba lists no Reply-To: B read that one mail whole to learn it.
    if (b === 'postshiba') assert.deepEqual((B as any).fake.reads, [mail.id])

    const sent = await B.ci.send({ reply: mail.id, text: 'Yes' })
    // To the tagged Reply-To of A's question, in B's thread of that mail.
    assert.deepEqual(sent.to, [`agent+${q.tag}@a.example`])
    assert.equal(sent.tag, mail.tag)
    const wire = net.log[net.log.length - 1]
    assert.equal(wire.subject, 'Re: Is the build green?')
    assert.match(JSON.stringify(wire.headers), new RegExp(mail.messageId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

    const answer = await A.ci.waitForAnswer(q.tag, { timeoutMs: 0 })
    assert.equal(answer?.option, 'Yes')
    assert.equal(answer?.from, 'clankerinbox@b.example')
    // The answer is a reply to A's own mail: answering it again is refused, which ends the exchange.
    await assert.rejects(A.ci.send({ reply: answer!.id, text: 'Thanks' }), /another agent's reply to mail from this machine/)
  })

  test(`${name}: a question to a requests inbox comes back answered`, async () => {
    const { A, B } = await pair(a, b, { requests: true })
    const q = await A.ci.ask({ question: 'Run the nightly job?', to: 'do@b.example' })
    const atB = await B.ci.poll()
    assert.equal(atB.requests.length, 1)
    assert.equal(atB.requests[0].agent, true)
    assert.equal(atB.requests[0].followUp, false)
    const sent = await B.ci.send({ reply: atB.requests[0].id, text: 'Done, it ran.' })
    assert.deepEqual(sent.to, [`agent+${q.tag}@a.example`])
    assert.equal(sent.tag, atB.requests[0].thread)
    const atA = await A.ci.poll()
    assert.deepEqual(atA.answers.map((x) => [x.tag, x.answer]), [[q.tag, 'Done, it ran.']])
  })

  test(`${name}: two agents that answer every mail with --reply stop after one round`, async () => {
    const { A, B } = await pair(a, b)
    await A.ci.send({ to: 'agent@b.example', subject: 'Status', text: 'Nightly build passed.' })
    let refused = 0
    for (let round = 0; round < 10; round++) {
      let sends = 0
      for (const m of [A, B]) {
        const r = await m.ci.poll()
        for (const u of r.unmatched) {
          try {
            await m.ci.send({ reply: u.id, text: 'Thanks, noted.' })
            sends++
          } catch (e: any) {
            assert.match(e.message, /mail loop/)
            refused++
          }
        }
      }
      if (!sends) break
    }
    // A's note, B's answer, and nothing more.
    assert.equal(A.sent() + B.sent(), 2)
    assert.equal(refused, 1)
  })

  test(`${name}: two agents that answer every mail with a new mail stop at the caps`, async () => {
    const caps = { sendPerHour: 5, receivePerSenderPerHour: 3 }
    const { A, B } = await pair(a, b, { caps })
    await A.ci.send({ to: 'agent@b.example', subject: 'Ping', text: 'ping' })
    const peer = new Map([[A, 'agent@b.example'], [B, 'agent@a.example']])
    let rounds = 0
    for (; rounds < 100; rounds++) {
      let sends = 0
      for (const m of [A, B]) {
        const r = await m.ci.poll()
        for (const _ of r.unmatched) {
          try {
            await m.ci.send({ to: peer.get(m)!, subject: 'Ping', text: 'ping' })
            sends++
          } catch (e: any) {
            assert.match(e.message, /limit of 5 sent mails in one hour/)
          }
        }
      }
      if (!sends) break
    }
    assert.ok(rounds < 100, 'the loop did not stop')
    // The caps stopped it, not a lack of mail: one side used up its sends or its receive count.
    assert.ok(A.sent() === caps.sendPerHour || B.sent() === caps.sendPerHour || (A.sent() + B.sent()) >= 2 * caps.receivePerSenderPerHour, `${A.sent()} and ${B.sent()} sent`)
    assert.ok(A.sent() <= caps.sendPerHour && B.sent() <= caps.sendPerHour, `${A.sent()} and ${B.sent()} sent`)
    // Each side handed out at most receivePerSenderPerHour mails of the other; the rest waits for the next hour.
    const received = (m: Machine) => m.ci.store.entries().filter((e) => e.dir === 'received').length
    assert.ok(received(A) <= caps.receivePerSenderPerHour && received(B) <= caps.receivePerSenderPerHour)
  })

  test(`${name}: auto-replies and list mail from the other agent's address are still skipped`, async () => {
    const { A, B, net } = await pair(a, b)
    const q = await A.ci.ask({ question: 'Deploy?', to: 'agent@b.example' })
    for (const headers of [{ 'Auto-Submitted': 'auto-replied' }, { 'List-Id': '<x.b.example>' }, { Precedence: 'bulk; x=y' }, { 'X-Loop': 'helpdesk' }]) {
      await net.carry({ from: 'Clanker Inbox <clankerinbox@b.example>', to: `agent+${q.tag}@a.example`, subject: 'Re: Deploy?', text: 'I am away', headers, messageId: `${randomBytes(6).toString('hex')}@b.example` })
    }
    const r = await A.ci.poll()
    assert.equal(r.answers.length + r.unmatched.length, 0)
    assert.equal(r.skipped.length, 4)
    assert.ok(r.skipped.every((s) => s.reason.startsWith('automated mail')))
    assert.ok(B)
  })
}

test('one domain, one From for both machines (one PostShiba account): the round trip works, and a machine never reads its own mail', async () => {
  const net = new Network()
  const shared = 'clankerinbox@inbox.example.dev'
  const A = await postshibaMachine(net, { domain: 'inbox.example.dev', local: 'rptest', allow: [OWNER, shared], send: [OWNER, 'rptest2@inbox.example.dev'] })
  const B = await postshibaMachine(net, { domain: 'inbox.example.dev', local: 'rptest2', allow: [shared], send: ['rptest@inbox.example.dev'] }, A.fake)
  const q = await A.ci.ask({ question: 'Ready?', options: ['Yes', 'No'], to: 'rptest2@inbox.example.dev' })
  const atB = await B.ci.poll()
  assert.equal(atB.unmatched.length, 1)
  const sent = await B.ci.send({ reply: atB.unmatched[0].id, text: '1' })
  assert.deepEqual(sent.to, [`rptest+${q.tag}@inbox.example.dev`])
  const atA = await A.ci.poll()
  assert.deepEqual(atA.answers.map((x) => [x.tag, x.option, x.from]), [[q.tag, 'Yes', shared]])

  // A's own mail to its own inbox: the same From that A allows for B, but A sent it.
  await A.ci.send({ to: 'rptest@inbox.example.dev', subject: 'Note to self', text: 'x' })
  const self = await A.ci.poll()
  assert.equal(self.unmatched.length, 0)
  assert.deepEqual(self.skipped.map((s) => s.reason), ['our own mail'])
})

test('a person\'s answer keeps the exact rule; another agent may answer only from the domain the question went to', async () => {
  const { A, net } = await pair('postshiba', 'postshiba')
  A.ci.config.inboxes.agent.allow = [OWNER, 'colleague@example.org', 'clankerinbox@b.example', 'clankerinbox@c.example']
  const human = await A.ci.ask({ question: 'Ship?', to: OWNER })
  const deliver = (from: string, tag: string, headers: Record<string, string> = {}) =>
    (A as any).fake.deliver(A.ci.config.inboxes.agent.id, {
      from, to: `agent+${tag}@a.example`, subject: 'Re: Ship?', text: 'yes', headers: { from, ...headers },
    })
  // A colleague on the owner's domain is no answer to the owner's question, as before.
  deliver('colleague@example.org', human.tag)
  // Agent marks change nothing for a mail from a domain the question did not go to.
  const agentQ = await A.ci.ask({ question: 'Build?', to: 'agent@b.example' })
  deliver('clankerinbox@c.example', agentQ.tag, { 'auto-submitted': 'auto-generated', 'x-loop': 'clankerinbox' })
  // Without the agent marks, mail from B's sending address is no answer to a question to B's inbox.
  deliver('clankerinbox@b.example', agentQ.tag)
  const r = await A.ci.poll()
  assert.equal(r.answers.length, 0)
  assert.deepEqual(r.skipped.map((s) => s.reason), Array(3).fill('the question was not sent to this sender'))
  assert.ok(net)
})

test('--reply uses only a Reply-To on the domain of the checked From, and the send list still decides', async () => {
  const { A, B, net } = await pair('cloudflare', 'cloudflare')
  // A mail from A's sending address whose Reply-To points elsewhere: B answers the From, which is not on its send list.
  await net.carry({ from: 'Clanker Inbox <clankerinbox@a.example>', to: 'agent@b.example', replyTo: 'mallory@evil.example', subject: 'Hi', text: 'Hello', headers: { 'Auto-Submitted': 'auto-generated', 'X-Loop': 'clankerinbox' }, messageId: `${randomBytes(6).toString('hex')}@a.example` })
  const r = await B.ci.poll()
  assert.equal(r.unmatched.length, 1)
  await assert.rejects(B.ci.send({ reply: r.unmatched[0].id, text: 'x' }), /send allowlist: clankerinbox@a.example/)
  assert.equal(net.log.length, 1)
  // --reply sets the recipient, the tag and the thread itself, and finds only mail this machine received.
  await assert.rejects(B.ci.send({ reply: r.unmatched[0].id, text: 'x', to: 'agent@a.example' }), /--reply sets --to itself/)
  await assert.rejects(B.ci.send({ reply: 'nosuchmail', text: 'x' }), /received no mail with the id or messageId nosuchmail/)
  assert.ok(A)
})
