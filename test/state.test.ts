// The state folder under load and damage: parallel processes, broken files, old entries.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakePostShiba, SEND_KEY, FULL_KEY, TEAM } from './fake-postshiba.ts'
import { Store } from '../src/store.ts'
import { ClankerInbox } from '../src/clankerinbox.ts'
import type { Config } from '../src/config.ts'

const BIN = join(import.meta.dirname, '..', 'bin', 'clankerinbox.ts')
const OWNER = 'owner@example.org'
const DOMAIN = 'inbox.example.dev'

let fake: FakePostShiba
let dir: string
let askId: string

interface Run { code: number; stdout: string; stderr: string; json: any }

function run(args: string[], env: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: {
        PATH: process.env.PATH!, HOME: dir,
        CLANKERINBOX_CONFIG: join(dir, 'config.json'), CLANKERINBOX_STATE: join(dir, 'state'),
        POSTSHIBA_SEND_API_KEY: SEND_KEY, POSTSHIBA_FULL_API_KEY: FULL_KEY, ...env,
      },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => (stdout += c))
    child.stderr.on('data', (c) => (stderr += c))
    child.stdin.end()
    child.on('close', (code) => {
      let json: any = null
      try { json = JSON.parse(stdout) } catch {}
      resolve({ code: code ?? -1, stdout, stderr, json })
    })
  })
}

function config(over: Partial<Config> = {}): Config {
  return {
    teamId: TEAM, from: `Clanker Inbox <clankerinbox@${DOMAIN}>`, apiUrl: fake.url,
    caps: { sendPerHour: 1000, receivePerSenderPerHour: 1000 },
    inboxes: { agent: { id: askId, address: `agent@${DOMAIN}`, mode: 'answers', allow: [OWNER], send: [OWNER] } },
    ...over,
  }
}

before(async () => {
  fake = new FakePostShiba()
  await fake.start()
})
after(() => fake.stop())

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'clankerinbox-state-'))
  fake.inboxes = []
  fake.messages.clear()
  fake.sends = []
  askId = fake.addInbox(`agent@${DOMAIN}`).id
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config()))
})

test('24 parallel asks: every printed tag is stored', async () => {
  const runs = await Promise.all(Array.from({ length: 24 }, (_, i) => run(['ask', `Parallel ${i}?`])))
  for (const r of runs) assert.equal(r.code, 0, r.stderr)
  const stored = JSON.parse(readFileSync(join(dir, 'state', 'questions.json'), 'utf8'))
  for (const r of runs) assert.ok(stored[r.json.tag], `tag ${r.json.tag} is stored`)
  assert.equal(Object.keys(stored).length, 24)
  assert.equal(readdirSync(join(dir, 'state')).filter((n) => /\.tmp$|\.lock$/.test(n)).length, 0)
})

test('parallel sends: the hourly cap holds exactly', async () => {
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config({ caps: { sendPerHour: 5 } })))
  const runs = await Promise.all(Array.from({ length: 20 }, (_, i) => run(['send', '--subject', `S${i}`, '--text', 'x'])))
  assert.equal(runs.filter((r) => r.code === 0).length, 5)
  assert.equal(fake.sends.length, 5)
  const refused = runs.filter((r) => r.code !== 0)
  for (const r of refused) {
    assert.equal(r.code, 3, r.stderr)
    assert.equal(r.json.code, 'cap')
    assert.match(r.json.message, /caps\.sendPerHour/)
    assert.ok(r.json.retryAfter > 3000)
  }
})

test('parallel answer writes: a poll service and waiters keep every answer', async () => {
  const mail = new ClankerInbox({ config: config(), stateDir: join(dir, 'state'), env: { POSTSHIBA_SEND_API_KEY: SEND_KEY, POSTSHIBA_FULL_API_KEY: FULL_KEY } })
  const tags: string[] = []
  for (let i = 0; i < 12; i++) tags.push((await mail.ask({ question: `Q${i}?` })).tag)
  for (const t of tags) fake.deliver(askId, { from: OWNER, to: `agent+${t}@${DOMAIN}`, text: `answer ${t}` })
  await Promise.all([run(['poll']), run(['poll']), run(['poll']), ...tags.slice(0, 4).map((t) => run(['wait', t, '--timeout', '0']))])
  const stored = JSON.parse(readFileSync(join(dir, 'state', 'questions.json'), 'utf8'))
  for (const t of tags) assert.equal(stored[t].answer?.answer, `answer ${t}`)
})

test('a damaged state file is moved aside and the command fails before any mail goes out', async () => {
  const state = join(dir, 'state')
  assert.equal((await run(['ask', 'First?'])).code, 0)
  writeFileSync(join(state, 'questions.json'), '{"q1": {"tag": "q1"')
  const r = await run(['ask', 'Second?'])
  assert.equal(r.code, 1)
  assert.equal(r.json.status, 'error')
  assert.equal(r.json.code, 'state')
  assert.match(r.stderr, /questions\.json is damaged/)
  assert.match(r.stderr, /moved to .*questions\.json\.corrupt-/)
  assert.equal(fake.sends.length, 1)
  assert.equal(readdirSync(state).filter((n) => n.startsWith('questions.json.corrupt-')).length, 1)
  assert.equal(existsSync(join(state, 'questions.json')), false)
  // A damaged processed.json does not deliver every stored mail again.
  writeFileSync(join(state, 'processed.json'), 'not json')
  const p = await run(['poll'])
  assert.equal(p.code, 1)
  assert.match(p.stderr, /processed\.json is damaged/)
})

test('a read-only state folder fails before the mail is sent', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root writes anywhere')
  const state = join(dir, 'state')
  assert.equal((await run(['ask', 'First?'])).code, 0)
  chmodSync(state, 0o500)
  try {
    const r = await run(['ask', 'Q?', '--wait', '--timeout', '1'])
    assert.equal(r.code, 1)
    assert.equal(r.json.code, 'state')
    assert.equal(fake.sends.length, 1)
  } finally {
    chmodSync(state, 0o700)
  }
})

test('a lock left by a dead process is taken over', () => {
  const state = join(dir, 'state')
  const store = new Store(state)
  writeFileSync(join(state, 'state.lock'), '999999999 1\n')
  writeFileSync(join(state, 'questions.json.999999999.tmp'), '{')
  store.markProcessed(['a'], Date.now())
  assert.deepEqual(Object.keys(store.processed()), ['a'])
  assert.equal(existsSync(join(state, 'state.lock')), false)
  new Store(state)
  assert.equal(existsSync(join(state, 'questions.json.999999999.tmp')), false)
})

test('processed ids live as long as the provider keeps mail, plus a margin', () => {
  const env = { POSTSHIBA_SEND_API_KEY: SEND_KEY, POSTSHIBA_FULL_API_KEY: FULL_KEY }
  const long = new ClankerInbox({ config: config({ retentionHours: 720 }), stateDir: join(dir, 'state'), env })
  assert.equal(long.store.processedTtlMs, (720 + 24) * 3600_000)
  const now = Date.now()
  long.store.markProcessed(['old'], now - 600 * 3600_000)
  long.store.markProcessed(['new'], now)
  assert.ok(long.store.processed().old, 'a 25-day-old id stays under a 30-day retention')
  const plain = new ClankerInbox({ config: config(), stateDir: join(dir, 'state2'), env })
  assert.equal(plain.store.processedTtlMs, (168 + 24) * 3600_000)
})

test('limits: long log bodies are cut, old answered questions are pruned', () => {
  const store = new Store(join(dir, 'state'))
  store.log({ at: new Date().toISOString(), dir: 'sent', inbox: 'agent', thread: 't', from: 'a', to: 'b', subject: 's', text: 'x'.repeat(200_000) })
  const e = store.entries()[0]
  assert.ok(e.text!.length < 70_000)
  assert.match(e.text!, /\(cut\)$/)
  const old = new Date(Date.now() - 40 * 24 * 3600_000).toISOString()
  const base = { inbox: 'agent', question: 'Q', options: [], to: [OWNER], subject: 'Q', messageId: null, sentAt: old }
  store.saveQuestion({ ...base, tag: 'qold', answer: { tag: 'qold', question: 'Q', answer: 'a', option: null, from: OWNER, at: old, id: 'i', messageId: 'm' }, reported: true })
  store.saveQuestion({ ...base, tag: 'qopen' })
  assert.deepEqual(Object.keys(store.questions()), ['qopen'])
})

test('send: subject and body limits are checked before the provider sees the mail', async () => {
  const long = await run(['send', '--subject', 'x'.repeat(999), '--text', 'y'])
  assert.equal(long.code, 1)
  assert.match(long.stderr, /998/)
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config({ caps: { maxBodyBytes: 100 } })))
  const big = await run(['send', '--subject', 's', '--text', 'y'.repeat(101)])
  assert.equal(big.code, 1)
  assert.match(big.stderr, /caps\.maxBodyBytes/)
  assert.equal(fake.sends.length, 0)
})
