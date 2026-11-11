import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { toMail, PostShibaProvider } from '../src/postshiba.ts'
import { createProvider, plusTagOf, type Provider, type Mail, type OutgoingMail } from '../src/provider.ts'
import { validateConfig, type Config } from '../src/config.ts'
import { ClankerInbox } from '../src/clankerinbox.ts'

const OWNER = 'owner@example.org'

function baseConfig(over: Partial<Config> = {}): Config {
  return {
    teamId: 'T1',
    from: 'Bot <bot@inbox.example.dev>',
    inboxes: {
      ask: { id: 'ib1', address: 'ask@inbox.example.dev', mode: 'answers', allow: [OWNER], send: [OWNER] },
      signup: { id: 'ib2', address: 'signup@inbox.example.dev', mode: 'codes', allow: '*', send: [] },
    },
    ...over,
  }
}

test('config: no provider field means PostShiba', () => {
  const config = baseConfig()
  validateConfig(config)
  assert.equal(createProvider(config, {}).name, 'postshiba')
  assert.ok(createProvider(config, {}) instanceof PostShibaProvider)
})

test('config: an unknown provider is refused; teamId is only needed for PostShiba', () => {
  assert.throws(() => validateConfig(baseConfig({ provider: 'smoke-signals' as any })), /provider must be/)
  assert.throws(() => validateConfig(baseConfig({ teamId: '' })), /teamId is missing/)
  assert.throws(() => validateConfig(baseConfig({ provider: 'postshiba', teamId: '' })), /teamId is missing/)
  validateConfig(baseConfig({
    provider: 'cloudflare', teamId: '',
    cloudflare: { url: 'https://clankerinbox.example.org', tokenEnv: 'CF_TOKEN' },
  }))
})

test('postshiba: inbound messages normalize to the shared mail shape', () => {
  const m = toMail({
    id: 'in1', inbox_id: 'ib1', to: 'ask+q1@inbox.example.dev', from: OWNER, subject: null, text: null,
    thread_id: null, in_reply_to: '<a@b>',
    headers: { From: OWNER, 'Message-ID': 'x@y' },
    envelope: { plus_tag: 'q1', mail_from: '' },
    authentication: { dmarc: { result: 'pass', aligned: true } },
    attachments: [{ filename: 'a.pdf', content_type: 'application/pdf', byte_size: 12 }],
    expires_at: '2026-01-08T00:00:00.000Z',
  }, 168)
  assert.equal(m.tag, 'q1')
  assert.equal(m.subject, '')
  assert.equal(m.text, '')
  assert.equal(m.inReplyTo, '<a@b>')
  assert.equal(m.headers['message-id'], 'x@y')
  assert.equal(m.mailFrom, '')
  assert.deepEqual(m.dmarc, { result: 'pass', aligned: true })
  assert.deepEqual(m.attachments, [{ filename: 'a.pdf', contentType: 'application/pdf', size: 12 }])
  assert.equal(m.receivedAt, Date.parse('2026-01-01T00:00:00.000Z'))
  const bare = toMail({ id: 'in2', inbox_id: 'ib1', to: 'a@b.c', from: null, subject: 's', text: 't', thread_id: null, headers: {} })
  assert.equal(bare.dmarc, null)
  assert.equal(bare.mailFrom, undefined)
  assert.equal(bare.receivedAt, null)
})

test('plus tags are read from an address', () => {
  assert.equal(plusTagOf('ask+q1@x.dev'), 'q1')
  assert.equal(plusTagOf('ask@x.dev'), null)
  assert.equal(plusTagOf('ask+@x.dev'), null)
  assert.equal(plusTagOf(null), null)
})

// Any object with send and listInbound is a provider: the core never looks past it.
class MemoryProvider implements Provider {
  readonly name = 'postshiba' as const
  sent: OutgoingMail[] = []
  inbox: Mail[] = []
  async send(mail: OutgoingMail) {
    this.sent.push(mail)
    return { messageId: `m${this.sent.length}@inbox.example.dev` }
  }
  async listInbound() {
    return this.inbox
  }
}

test('the core sends and reads only through the provider', async () => {
  const provider = new MemoryProvider()
  const inbox = new ClankerInbox({ config: baseConfig(), provider, stateDir: mkdtempSync(join(tmpdir(), 'ci-prov-')), env: {} })
  const q = await inbox.ask({ question: 'Ship it?', options: ['Yes', 'No'] })
  assert.equal(provider.sent.length, 1)
  assert.equal(provider.sent[0].replyTo, `ask+${q.tag}@inbox.example.dev`)
  assert.equal(provider.sent[0].headers['Auto-Submitted'], 'auto-generated')
  provider.inbox.push({
    id: 'r1', to: `ask+${q.tag}@inbox.example.dev`, from: OWNER, subject: 'Re: Ship it?', text: '1\n\nOn Mon, Bot wrote:\n> Ship it?',
    tag: q.tag, inReplyTo: null, headers: { from: OWNER, 'message-id': 'r1@example.org' },
    mailFrom: OWNER, dmarc: { result: 'pass', aligned: true }, attachments: [], receivedAt: Date.now(),
  })
  const res = await inbox.poll()
  assert.equal(res.answers.length, 1)
  assert.equal(res.answers[0].option, 'Yes')
})

test('postshiba: an HTML-only mail gets its text from the HTML', () => {
  const base = { id: 'h1', inbox_id: 'ib1', to: 'ask+q1@inbox.example.dev', from: OWNER, subject: 'Re: q', thread_id: 'q1', headers: {} }
  const html = '<div dir="ltr">2</div><br><div class="gmail_quote">On Tue wrote:<blockquote>Ship?<br>1. Yes</blockquote></div>'
  assert.match(toMail({ ...base, text: null, html }).text, /^2\n/)
  assert.match(toMail({ ...base, text: '  \r\n', html }).text, /^2\n/)
  assert.equal(toMail({ ...base, text: 'plain', html }).text, 'plain')
})
