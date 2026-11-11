// How replies become answers, with an in-memory provider: which question a reply belongs to,
// who may answer, and how one bad mail is kept from blocking the rest.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Provider, Mail, OutgoingMail } from '../src/provider.ts'
import type { Config, InboxConfig } from '../src/config.ts'
import { ClankerInbox } from '../src/clankerinbox.ts'

const OWNER = 'owner@example.org'
const ASK = 'ask@inbox.example.dev'

class MemoryProvider implements Provider {
  readonly name = 'postshiba' as const
  sent: OutgoingMail[] = []
  mail = new Map<string, Mail[]>()
  async send(mail: OutgoingMail) {
    this.sent.push(mail)
    return { messageId: `out${this.sent.length}@inbox.example.dev` }
  }
  async listInbound(inbox: InboxConfig) {
    return [...(this.mail.get(inbox.id) || [])].reverse()
  }
}

let n = 0
function reply(over: Partial<Mail> & { tag?: string | null } = {}): Mail {
  const id = `r${++n}`
  const from = over.from ?? OWNER
  const tag = over.tag ?? null
  return {
    id, to: tag ? ASK.replace('@', `+${tag}@`) : ASK, from, subject: 'Re: q', text: '1', tag, inReplyTo: null,
    headers: { from, 'message-id': `<${id}@example.org>` },
    mailFrom: from, dmarc: { result: 'pass', aligned: true }, attachments: [], receivedAt: Date.now(),
    ...over,
  }
}

function setup(inboxes?: Record<string, InboxConfig>) {
  const provider = new MemoryProvider()
  const config: Config = {
    teamId: 'T1', from: `Bot <${ASK}>`,
    inboxes: inboxes || {
      ask: { id: 'ask', address: ASK, mode: 'answers', allow: [OWNER, 'colleague@example.org'], send: [OWNER, 'colleague@example.org'] },
      signup: { id: 'signup', address: 'signup@inbox.example.dev', mode: 'codes', allow: '*', send: [] },
    },
  }
  const ci = new ClankerInbox({ config, provider, stateDir: mkdtempSync(join(tmpdir(), 'ci-answers-')), env: {} })
  const deliver = (m: Mail, inbox = 'ask') => {
    const list = provider.mail.get(inbox) || []
    list.push(m)
    provider.mail.set(inbox, list)
    return m
  }
  return { ci, provider, deliver }
}

test('plus tags named like object members match no question and block nothing', async () => {
  const { ci, deliver } = setup()
  const q = await ci.ask({ question: 'Ship it?', options: ['Yes', 'No'] })
  for (const tag of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) deliver(reply({ tag, text: '1' }))
  deliver(reply({ tag: q.tag, text: '2' }))
  const r = await ci.poll()
  assert.deepEqual(r.answers.map((a) => a.option), ['No'])
  assert.equal(r.unmatched.length, 4)
  assert.equal(ci.store.question('constructor'), undefined)
  assert.deepEqual(await ci.poll(), { answers: [], unmatched: [], requests: [], skipped: [] })
})

test('a mail that throws while it is read is skipped with a reason and never read again', async () => {
  const { ci, deliver } = setup()
  const q = await ci.ask({ question: 'Ship it?', options: ['Yes', 'No'] })
  const bad = reply({ tag: q.tag })
  Object.defineProperty(bad, 'text', { get() { throw new Error('boom') } })
  deliver(bad)
  deliver(reply({ tag: q.tag, text: '2' }))
  const r = await ci.poll()
  assert.deepEqual(r.answers.map((a) => a.option), ['No'])
  assert.deepEqual(r.skipped.map((s) => [s.id, s.reason]), [[bad.id, 'could not be read: boom']])
  assert.deepEqual((await ci.poll()).skipped, [])
})

test('the receive cap: unmatched mail does not use up answers, and mail over the cap comes back later', async () => {
  const { ci, deliver } = setup()
  ci.config.caps = { sendPerHour: 100, receivePerSenderPerHour: 2 }
  let now = Date.now()
  ci.now = () => now
  for (let i = 0; i < 3; i++) deliver(reply({ tag: `mnote${i}`, text: `thanks ${i}` }))
  const q = await ci.ask({ question: 'Deploy?', options: ['Yes', 'No'] })
  deliver(reply({ tag: q.tag, text: '1' }))
  let r = await ci.poll()
  assert.deepEqual(r.answers.map((a) => a.option), ['Yes'])
  assert.equal(r.unmatched.length, 2)
  assert.deepEqual(r.skipped.map((s) => s.reason), ['hourly cap for this sender'])
  // Not marked processed: the same mail is read again once the hour is over.
  now += 2 * 3600_000
  r = await ci.poll()
  assert.deepEqual(r.unmatched.map((u) => u.text), ['thanks 2'])
  assert.deepEqual(r.skipped, [])
})

test('a waiter hears about skipped mail for its own question', async () => {
  const { ci, deliver } = setup()
  const q = await ci.ask({ question: 'Deploy?', options: ['Yes', 'No'] })
  deliver(reply({ tag: q.tag, from: 'owner.alias@example.org', text: '1' }))
  deliver(reply({ tag: 'other1', from: 'stranger@evil.example', text: '1' }))
  const seen: { reason: string; from?: string }[] = []
  const a = await ci.waitForAnswer(q.tag, { timeoutMs: 0, onSkipped: (s) => seen.push(s) })
  assert.equal(a, null)
  assert.deepEqual(seen.map((s) => [s.from, s.reason]), [['owner.alias@example.org', 'sender not on allowlist']])
})

test('a line break or other control character never reaches a header', async () => {
  const { ci, provider } = setup()
  for (const subject of ['Hi\nBcc: x@evil.example', 'Hi\rBcc: x', 'a\u0000b', 'a\u001b[2Jb', 'a\u0085b', 'a\u2028b']) {
    await assert.rejects(ci.send({ subject, text: 'x' }), /control character/, JSON.stringify(subject))
  }
  await assert.rejects(ci.ask({ question: 'Ship?\u001b[2J' }), /control character/)
  // A question may have paragraphs; only its first line becomes the default subject.
  await ci.ask({ question: 'Ship?\nBcc: x@evil.example' })
  assert.equal(provider.sent.at(-1)!.subject, 'Ship?')
  provider.sent.length = 0
  await assert.rejects(ci.ask({ question: 'Ship?', subject: 'S\r\nBcc: x' }), /control character/)
  ci.config.from = 'Bot\r\nBcc: x@evil.example <ask@inbox.example.dev>'
  await assert.rejects(ci.send({ subject: 'Hi', text: 'x' }), /control character/)
  assert.equal(provider.sent.length, 0)
  // The body is not a header: line breaks there are fine.
  ci.config.from = `Bot <${ASK}>`
  await ci.send({ subject: 'Hi', text: 'line 1\nline 2' })
  assert.equal(provider.sent.length, 1)
})

test('attachment names of a request are labels: no path separators, no control characters', async () => {
  const { ci, deliver } = setup({ do: { id: 'do', address: 'do@inbox.example.dev', mode: 'requests', allow: [OWNER], send: [OWNER] } })
  deliver(reply({ to: 'do@inbox.example.dev', text: 'see attached', attachments: [
    { filename: '../../.ssh/authorized_keys', contentType: 'text/plain', size: 5 },
    { filename: 'a\u001b[31m.txt', contentType: 'text/plain', size: 1 },
  ] }), 'do')
  const r = await ci.poll()
  assert.deepEqual(r.requests[0].attachments.map((a) => a.filename), ['.._.._.ssh_authorized_keys', 'a.txt'])
})

test('code --from: an address or URL works, and a link must point at that domain', async () => {
  const { ci, deliver } = setup()
  const from = 'no-reply@service.example'
  deliver(reply({ tag: 's1', from, to: 'signup+s1@inbox.example.dev', subject: 'Your code', text: 'Your verification code is 111111' }), 'signup')
  for (const f of [from, 'SERVICE.EXAMPLE.', 'https://service.example/login']) {
    assert.deepEqual(await ci.code({ tag: 's1', from: f }), { tag: 's1', code: '111111' }, f)
  }
  await assert.rejects(ci.code({ tag: 's1', from: 'not a domain' }), /invalid --from/)
  deliver(reply({ tag: 's2', from, to: 'signup+s2@inbox.example.dev', subject: 'Sign in', text: 'Sign in: https://evil.example/login?t=1' }), 'signup')
  assert.equal(await ci.code({ tag: 's2', from: 'service.example' }), null)
  assert.deepEqual(await ci.code({ tag: 's2' }), { tag: 's2', link: 'https://evil.example/login?t=1' })
})

test('a reply without its plus tag goes to the question it answers: In-Reply-To first, then the newest reference', async () => {
  const { ci, deliver } = setup()
  const a = await ci.ask({ question: 'Run the migration on staging?', options: ['Yes', 'No'] })
  const ma = ci.store.question(a.tag)!.messageId!
  const b = await ci.ask({ question: 'Drop the old table in PROD?', options: ['Yes', 'No'], inReplyTo: ma })
  const mb = ci.store.question(b.tag)!.messageId!
  deliver(reply({ text: '2', inReplyTo: `<${mb}>`, headers: { from: OWNER, 'in-reply-to': `<${mb}>`, references: `<${ma}> <${mb}>` } }))
  let r = await ci.poll()
  assert.deepEqual(r.answers.map((x) => [x.tag, x.option]), [[b.tag, 'No']])
  // No In-Reply-To: the last entry of References is the mail replied to.
  const c = await ci.ask({ question: 'Tag the release?', options: ['Yes', 'No'], inReplyTo: mb })
  const mc = ci.store.question(c.tag)!.messageId!
  deliver(reply({ text: '1', headers: { from: OWNER, references: `<${ma}> <${mb}> <${mc}>` } }))
  r = await ci.poll()
  assert.deepEqual(r.answers.map((x) => [x.tag, x.option]), [[c.tag, 'Yes']])
})

test('only someone the question went to can answer it', async () => {
  const { ci, deliver } = setup()
  const q = await ci.ask({ question: 'Deploy prod?', options: ['Yes', 'No'], to: OWNER })
  deliver(reply({ tag: q.tag, from: 'colleague@example.org', text: '1' }))
  let r = await ci.poll()
  assert.deepEqual(r.answers, [])
  assert.deepEqual(r.skipped.map((s) => [s.from, s.reason]), [['colleague@example.org', 'the question was not sent to this sender']])
  deliver(reply({ tag: q.tag, from: 'owner+phone@example.org', text: '2' }))
  r = await ci.poll()
  assert.deepEqual(r.answers.map((a) => a.option), ['No'])
})

test('an answer to a question of another inbox counts only when that inbox allows the sender', async () => {
  const { ci, deliver } = setup({
    ask: { id: 'ask', address: ASK, mode: 'answers', allow: [OWNER, 'colleague@example.org'], send: [OWNER, 'colleague@example.org'] },
    ops: { id: 'ops', address: 'ops@inbox.example.dev', mode: 'answers', allow: [OWNER], send: [OWNER] },
  })
  const q = await ci.ask({ question: 'Restart?', options: ['Yes', 'No'], inbox: 'ops' })
  // Made-up record: the question lists the colleague, but the ops inbox never allowed them.
  ci.store.saveQuestion({ ...ci.store.question(q.tag)!, to: ['colleague@example.org'] })
  deliver(reply({ tag: q.tag, from: 'colleague@example.org', text: '1' }))
  const r = await ci.poll()
  assert.deepEqual(r.answers, [])
  assert.deepEqual(r.skipped.map((s) => s.reason), ['the inbox of the question does not allow this sender'])
})

test('code --wait after "send the code again" waits for the new mail, not the one it returned before', async () => {
  const { ci, deliver } = setup()
  const from = 'no-reply@service.example'
  const mail = (code: string) => reply({ tag: 's1', from, to: 'signup+s1@inbox.example.dev', subject: 'Your code', text: `Your verification code is ${code}` })
  deliver(mail('111111'), 'signup')
  assert.deepEqual(await ci.waitForCode({ tag: 's1', timeoutMs: 0 }), { tag: 's1', code: '111111' })
  assert.equal(await ci.waitForCode({ tag: 's1', timeoutMs: 0 }), null)
  // Without --wait the newest code is still there to read again.
  assert.deepEqual(await ci.code({ tag: 's1' }), { tag: 's1', code: '111111' })
  deliver(mail('222222'), 'signup')
  assert.deepEqual(await ci.waitForCode({ tag: 's1', timeoutMs: 0 }), { tag: 's1', code: '222222' })
  // Another tag is not affected.
  deliver(reply({ tag: 's2', from, to: 'signup+s2@inbox.example.dev', subject: 'Your code', text: 'Your code is 333333' }), 'signup')
  assert.deepEqual(await ci.waitForCode({ tag: 's2', timeoutMs: 0 }), { tag: 's2', code: '333333' })
})

test('an answer carries the RFC Message-ID as messageId, so send --in-reply-to takes it; the provider id is id', async () => {
  const { ci, deliver, provider } = setup()
  const q = await ci.ask({ question: 'Ship?', options: ['Yes', 'No'] })
  const m = deliver(reply({ tag: q.tag, text: '1', headers: { from: OWNER, 'message-id': '<CAF+abc.123@mail.example.org>' } }))
  const [a] = (await ci.poll()).answers
  assert.equal(a.id, m.id)
  // The case stays: mail clients compare Message-IDs exactly, so a lowercased one breaks the thread.
  assert.equal(a.messageId, 'CAF+abc.123@mail.example.org')
  await ci.send({ subject: 'Re: Ship?', text: 'Shipping.', inReplyTo: a.messageId })
  assert.equal(provider.sent.at(-1)!.headers['In-Reply-To'], '<CAF+abc.123@mail.example.org>')
})
