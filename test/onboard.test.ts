import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { onboard, waitForClicks, Prompter, type OnboardOptions } from '../src/onboard.ts'
import { loadConfig, loadSecrets, secretsPath, type Config } from '../src/config.ts'
import { ClankerInbox } from '../src/clankerinbox.ts'
import type { Env } from '../src/provider.ts'
import { FakeD1 } from './fake-d1.ts'
import { SCHEMA, handleFetch, type WorkerEnv } from '../cloudflare/worker.ts'
import { FakePostShiba, FULL_KEY, SEND_KEY } from './fake-postshiba.ts'
import { fakeCloudflareApi, type CfCall, type FakeApiOptions } from './fake-cloudflare-api.ts'

const BIN = join(import.meta.dirname, '..', 'bin', 'clankerinbox.ts')
const OWNER = 'owner@example.org'
const servers: { server: { close(): void } }[] = []
after(() => servers.forEach((s) => s.server.close()))

let dir: string
let path: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'clankerinbox-onboard-'))
  path = join(dir, 'config.json')
})

type RunOpts = Partial<Pick<OnboardOptions, 'provider' | 'apiUrl' | 'workerOnline' | 'cloudflareApi' | 'replyWait' | 'mxLookup' | 'verifyWait' | 'tokenCheck' | 'flags'>> & { env?: Env }

// Feeds the answers as lines (no terminal), and returns what the questions printed.
// State goes to the test's own folder, never the real one.
async function run(answers: string[], opts: RunOpts = {}) {
  const input = new PassThrough()
  const output = new PassThrough()
  let text = ''
  output.on('data', (c) => (text += c))
  input.end(answers.map((a) => a + '\n').join(''))
  const { env, ...hooks } = opts
  let code: number
  try {
    // No DNS lookups from tests: a domain has no MX record unless the test says so.
    code = await onboard({ input, output, configPath: path, env: { CLANKERINBOX_STATE: join(dir, 'state'), ...env }, mxLookup: async () => [], ...hooks })
  } catch (e) {
    // Out of answers: what was printed so far still counts.
    code = -1
    text += `\n[stopped: ${(e as Error).message}]`
  }
  return { code, text }
}

const TOKEN = 'worker-token-123'

// The real Worker code behind a local HTTP server, standing in for a Worker deployed before.
async function fakeWorker(token = TOKEN): Promise<string> {
  const db = new FakeD1()
  await db.exec(SCHEMA)
  const workerEnv: WorkerEnv = { DB: db, EMAIL: { async send() { return { messageId: '<m@mail.example.com>' } } }, API_TOKEN: token, SENDER: 'clankerinbox@mail.example.com' }
  const server = createServer(async (r, w) => {
    const res = await handleFetch(new Request('http://127.0.0.1' + r.url, { method: r.method, headers: r.headers as any }), workerEnv)
    w.writeHead(res.status, Object.fromEntries(res.headers))
    w.end(Buffer.from(await res.arrayBuffer()))
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  servers.push({ server })
  return `http://127.0.0.1:${(server.address() as any).port}`
}

const tokenEnv = { CLANKERINBOX_CF_TOKEN: TOKEN }
// Cloudflare, "It's already deployed", the mail domain, the default name, the owner.
const HAVE = ['2', '2', 'mail.example.com', '', OWNER]

test('Cloudflare, deployed before: the token is typed, saved next to the config, and the Worker answers', async () => {
  const url = await fakeWorker()
  // ..., Worker URL, token, save, no test mail.
  const { code, text } = await run([...HAVE, url, TOKEN, '', 'n'])
  assert.equal(code, 0, text)
  const c = loadConfig(path)
  assert.equal(c.provider, 'cloudflare')
  assert.deepEqual(c.cloudflare, { url, tokenEnv: 'CLANKERINBOX_CF_TOKEN' })
  assert.deepEqual(c.inboxes.agent.allow, [OWNER])
  assert.match(text, /✓ Token found: CLANKERINBOX_CF_TOKEN in /)
  assert.match(text, /✓ Worker answers/)
  assert.match(text, /Setup is complete\. Your agent's addresses:\n {4}agent@mail\.example\.com +asks you questions/)
  assert.match(text, /signup@mail\.example\.com +receives verification codes/)
  // The token is next to the config, not in it, and never printed.
  assert.ok(!text.includes(TOKEN) && !readFileSync(path, 'utf8').includes(TOKEN))
  assert.deepEqual(loadSecrets(path), { CLANKERINBOX_CF_TOKEN: TOKEN })
  assert.equal(statSync(secretsPath(path)).mode & 0o777, 0o600)
  // Later commands find it there; an env var with the same name wins.
  assert.equal(new ClankerInbox({ configPath: path, env: { CLANKERINBOX_STATE: dir } }).env.CLANKERINBOX_CF_TOKEN, TOKEN)
  assert.equal(new ClankerInbox({ configPath: path, env: { CLANKERINBOX_STATE: dir, CLANKERINBOX_CF_TOKEN: 'env' } }).env.CLANKERINBOX_CF_TOKEN, 'env')
})

test('a token already in the environment is not asked for', async () => {
  const url = await fakeWorker()
  const { code, text } = await run([...HAVE, url, 'n'], { env: tokenEnv })
  assert.equal(code, 0, text)
  assert.ok(!/Worker token:|Save the key/.test(text))
  assert.ok(!existsSync(secretsPath(path)))
})

test('bad answers are asked again; a token not saved says to set it', async () => {
  const url = await fakeWorker()
  const { code, text } = await run(['9', '2', '2', 'no domain', 'mail.example.com', '', 'not-an-address', OWNER, 'ftp://x', url, '', TOKEN, 'n', 'n'])
  assert.equal(code, 0, text)
  assert.match(text, /Type a number from 1 to 2\./)
  assert.match(text, /The domain "no domain" is not a domain name, such as inbox\.example\.com\./)
  assert.match(text, /The address "not-an-address" is not one email address\./)
  assert.match(text, /Must be an https:\/\/ URL\./)
  assert.match(text, /Enter a value\./)
  assert.match(text, /The keys were not saved\. Set CLANKERINBOX_CF_TOKEN/)
  assert.ok(!existsSync(secretsPath(path)))
})

test('a wrong token: setup says what the Worker wants and lets you type it again', async () => {
  const url = await fakeWorker()
  // ..., wrong token, save, then "Enter the token again", the right one, no test mail.
  const { code, text } = await run([...HAVE, url, 'wrong', '', '1', TOKEN, 'n'])
  assert.equal(code, 0, text)
  assert.match(text, /✗ Worker answers .*401/)
  assert.match(text, /The Worker rejected the token\./)
  assert.match(text, /What do you want to do\?\n {2}1\. Enter the token again\n {2}2\. Check again - once it's fixed\n {2}3\. Stop here/)
  assert.match(text, /✓ Worker answers/)
  assert.deepEqual(loadSecrets(path), { CLANKERINBOX_CF_TOKEN: TOKEN }, 'the new token is saved')
})

test('a wrong token from the environment can\'t be retyped here; stopping says how to check again', async () => {
  const url = await fakeWorker()
  const { code, text } = await run([...HAVE, url, '2'], { env: { CLANKERINBOX_CF_TOKEN: 'wrong' } })
  assert.equal(code, 1)
  assert.ok(existsSync(path))
  assert.match(text, /✓ Token found: CLANKERINBOX_CF_TOKEN in /)
  assert.match(text, /✗ Worker answers/)
  assert.match(text, /CLANKERINBOX_CF_TOKEN is set in your environment, which wins over the saved one\. Fix it there/)
  assert.ok(!/Enter the token again/.test(text))
  assert.match(text, /Fix that, then run: CLANKERINBOX_CONFIG=\S+ clankerinbox check\n\(with the same CLANKERINBOX_STATE\)/)
})

test('an existing setup can be checked, left alone, or replaced with a backup', async () => {
  const url = await fakeWorker()
  await run([...HAVE, url, 'n'], { env: tokenEnv })
  const before = readFileSync(path, 'utf8')

  const kept = await run(['3'], { env: tokenEnv })
  assert.equal(kept.code, 0)
  assert.match(kept.text, /Already set up: Cloudflare Worker/)
  assert.match(kept.text, /Your config is unchanged/)

  const checked = await run(['1', 'n'], { env: tokenEnv })
  assert.equal(checked.code, 0, checked.text)
  assert.match(checked.text, /✓ Worker answers/)
  assert.match(checked.text, /Setup is complete\./)
  assert.equal(readFileSync(path, 'utf8'), before)

  const replaced = await run(['2', ...HAVE, 'http://localhost:1', 'other-token', 'n', '3'])
  assert.equal(replaced.code, 1)
  assert.equal(readFileSync(path + '.bak', 'utf8'), before)
  assert.equal(loadConfig(path).cloudflare?.url, 'http://localhost:1')
  assert.match(replaced.text, /✓ Token found: CLANKERINBOX_CF_TOKEN typed in setup/)
  assert.match(replaced.text, /✗ Worker answers/)
  assert.match(replaced.text, /Check the Worker URL\. `wrangler deploy` prints it\./)
  assert.ok(!replaced.text.includes('other-token'))
})

test('deployed before: a wrong Worker URL can be typed again', async () => {
  const url = await fakeWorker()
  // ..., a wrong URL, the token, save; the check fails: "Enter the URL again", the right URL, no test mail.
  const { code, text } = await run([...HAVE, 'http://localhost:1', TOKEN, '', '1', url, 'n'])
  assert.equal(code, 0, text)
  assert.match(text, /✗ Worker answers \(http:\/\/localhost:1\)/)
  assert.match(text, /What do you want to do\?\n {2}1\. Enter the URL again\n {2}2\. Check again/)
  assert.match(text, /✓ Worker answers \(http:\/\/127\.0\.0\.1/)
  assert.equal(loadConfig(path).cloudflare?.url, url)
  // Setup did not deploy from this machine, so check does not run wrangler for the rules, and it says so.
  assert.match(text, /! Routing rules send agent@mail\.example\.com and signup@mail\.example\.com to the Worker "clankerinbox": not checked: the Worker was not deployed from this machine, so check does not run wrangler \(to check them with your wrangler login, run the check with CLANKERINBOX_WRANGLER="npx wrangler"\)/)
})

test('PostShiba: links to sign up and the key, re-asks a wrong key, picks team and domain from the key', async () => {
  const api = new FakePostShiba()
  const apiUrl = await api.start()
  try {
    // PostShiba, a wrong key, the right one, send key = full key, domain 1, owner, save, no test mail.
    const { code, text } = await run(['1', 'wrong-key', FULL_KEY, '', '1', '', OWNER, '', 'n'], { apiUrl })
    assert.equal(code, 0, text)
    assert.match(text, /Sign up at https:\/\/app\.postshiba\.com\/users\/sign_up/)
    assert.match(text, /API keys → Create API key → Access: Full access/)
    assert.match(text, /That key doesn't work: .*401/)
    assert.match(text, /✓ Team: Test team/)
    assert.match(text, /Which domain\?\n {2}1\. inbox\.example\.com/)
    assert.ok(!text.includes('wrong-key'))
    assert.match(text, /✓ Saved the keys/)
    assert.match(text, /✓ Send key \(POSTSHIBA_SEND_API_KEY in \S+config\.secrets\.json\)/)
    assert.match(text, /✓ Read mail from PostShiba \(POSTSHIBA_FULL_API_KEY in \S+config\.secrets\.json\)/)
    assert.match(text, /✓ Mail for inbox\.example\.com reaches PostShiba/)
    assert.match(text, /signup@inbox\.example\.com +receives verification codes/)
    assert.ok(!text.includes(FULL_KEY))
    assert.deepEqual(loadSecrets(path), { POSTSHIBA_FULL_API_KEY: FULL_KEY, POSTSHIBA_SEND_API_KEY: FULL_KEY })

    // A wrong key from the environment stops setup and says where it comes from.
    const wrong = await run(['2', '1'], { env: { POSTSHIBA_FULL_API_KEY: 'bad', POSTSHIBA_SEND_API_KEY: SEND_KEY }, apiUrl })
    assert.equal(wrong.code, 1)
    assert.match(wrong.text, /That key doesn't work: .*401/)
    assert.match(wrong.text, /comes from POSTSHIBA_FULL_API_KEY in your environment/)
  } finally {
    await api.stop()
  }
})

test('PostShiba: a domain without its MX record gets the exact DNS record, then "Check again" passes', async () => {
  const api = new FakePostShiba()
  const apiUrl = await api.start()
  api.domains.push({ id: 'dom2', name: 'new.invalid', sending_allowed: false, dkim_status: 'pending' })
  api.newInboxMx = 'pending'
  try {
    const env = { POSTSHIBA_FULL_API_KEY: FULL_KEY, POSTSHIBA_SEND_API_KEY: SEND_KEY }
    // PostShiba, domain 2, go on without the sending records, owner, then "Check again" once the MX is in.
    const { code, text } = await run(['1', '2', '2', '', OWNER, '1'], { env, apiUrl })
    // The sending records are still missing: setup says so and is not complete, with no test mail.
    assert.equal(code, 1, text)
    assert.match(text, /Continuing\. Once the records are added, run: CLANKERINBOX_CONFIG=\S+ clankerinbox check/)
    assert.match(text, /Setup isn't finished\.[^]*✗ PostShiba lets new\.invalid send: not yet\n {2}PostShiba has not verified the DNS records of new\.invalid yet \(DKIM pending\)/)
    assert.equal(api.sends.length, 0)
    assert.match(text, /2\. new\.invalid - not verified/)
    assert.match(text, /✗ Mail for new\.invalid reaches PostShiba: there is no MX record\. Add this DNS record: new\.invalid MX 10 inbound\.postshiba\.com/)
    assert.match(text, /Add this DNS record:\n {4}Type +Name +Value\n {4}MX +new\.invalid +inbound\.postshiba\.com \(priority 10\)/)
    assert.match(text, /✓ Mail for new\.invalid reaches PostShiba/)
    assert.ok(api.verifyCalls >= 1, 'asks PostShiba to look at the record again')
  } finally {
    await api.stop()
  }
})

test('PostShiba: setup adds a new domain, lists its DNS records and checks them until they pass', async () => {
  const api = new FakePostShiba()
  const apiUrl = await api.start()
  let checks = 0
  api.onDomainVerify = () => { if (++checks === 2) api.dnsReady = true }
  try {
    const env = { POSTSHIBA_FULL_API_KEY: FULL_KEY, POSTSHIBA_SEND_API_KEY: SEND_KEY }
    // PostShiba, "Add a new domain", its name, check (too early), check again (passes), owner, no test mail.
    const { code, text } = await run(['1', '2', 'agents.invalid', '1', '1', '', OWNER, 'n'], { env, apiUrl })
    assert.equal(code, 0, text)
    assert.match(text, /2\. Add a new domain - setup adds it and shows the DNS records/)
    assert.match(text, /✓ Added agents\.invalid to PostShiba/)
    assert.match(text, /MX +agents\.invalid +inbound\.postshiba\.com \(priority 10\)/)
    assert.match(text, /CNAME +ps1\._domainkey\.agents\.invalid +42\.customers\.postshiba\.com/)
    assert.match(text, /CNAME +rp\.agents\.invalid +rp\.postshiba\.com/)
    assert.match(text, /TXT +_dmarc\.agents\.invalid +v=DMARC1; p=none;/)
    assert.match(text, /✗ PostShiba checks the records: not all records are verified yet \(DKIM pending, return path pending, DMARC pending\)/)
    assert.match(text, /✓ PostShiba checks the records/)
    assert.equal(loadConfig(path).inboxes.signup.address, 'signup@agents.invalid')
  } finally {
    await api.stop()
  }
})

test('the test question: a reply that does not count is explained at once; the real one finishes setup', async () => {
  const api = new FakePostShiba()
  const apiUrl = await api.start()
  try {
    const env = { POSTSHIBA_FULL_API_KEY: FULL_KEY, POSTSHIBA_SEND_API_KEY: SEND_KEY }
    // The owner replies twice: first from a mail that fails DMARC, then a real reply.
    const owner = (async () => {
      while (!api.sends.length) await new Promise((r) => setTimeout(r, 10))
      const sent = api.sends[0].body
      const to = sent.reply_to
      const inbox = api.inboxes.find((i) => i.address === to.replace(/\+[^@]*/, ''))!
      const reply = { from: OWNER, to, subject: 'Re: clankerinbox test', headers: { 'in-reply-to': `<${api.sends[0].messageId}>` } }
      api.deliver(inbox.id, { ...reply, text: 'forged', authentication: { dmarc: { result: 'fail', aligned: false, policy: 'none' }, arc: { result: 'none' } } as any })
      await new Promise((r) => setTimeout(r, 100))
      api.deliver(inbox.id, { ...reply, text: 'ok' })
    })()
    const { code, text } = await run(['1', '1', '', OWNER, ''], { env, apiUrl, replyWait: { timeoutMs: 5000, intervalMs: 20 } })
    await owner
    assert.equal(code, 0, text)
    assert.equal(api.sends[0].body.to[0], OWNER)
    assert.match(text, /✓ Sent to owner@example\.org/)
    assert.match(text, /! Got a mail from owner@example\.org, but it doesn't count: DMARC did not pass aligned\./)
    assert.match(text, /couldn't confirm it really came from example\.org \(DMARC\)/)
    assert.match(text, /✓ Got your reply from owner@example\.org: "ok"/)
    assert.match(text, /✓ Everything works\./)
  } finally {
    await api.stop()
  }
})

test('the test question: no reply in time says how to keep waiting', async () => {
  const api = new FakePostShiba()
  const apiUrl = await api.start()
  try {
    const env = { POSTSHIBA_FULL_API_KEY: FULL_KEY, POSTSHIBA_SEND_API_KEY: SEND_KEY }
    const { code, text } = await run(['1', '1', '', OWNER, ''], { env, apiUrl, replyWait: { timeoutMs: 1000, intervalMs: 20 } })
    assert.equal(code, 0, text)
    assert.match(text, /! No reply after 1 second\./)
    assert.match(text, /It can still arrive\. To wait for it: CLANKERINBOX_CONFIG=\S+ clankerinbox wait q/)
    assert.match(text, /To see what arrived and why it didn't count: CLANKERINBOX_CONFIG=\S+ clankerinbox poll\n/)
    assert.match(text, /\n\(with the same CLANKERINBOX_STATE\)\n/)
  } finally {
    await api.stop()
  }
})

const cfCalls: CfCall[] = []
async function fakeZonesApi(o: FakeApiOptions = {}) {
  const api = await fakeCloudflareApi(cfCalls, o)
  servers.push(api)
  return api.url
}

const noMx = async () => []

test('Cloudflare: setup logs in, puts the mail on a subdomain, deploys the Worker on a custom domain and routes the mail', async () => {
  const fake = mkdtempSync(join(tmpdir(), 'clankerinbox-wrangler-'))
  const env: Env = { CLANKERINBOX_WRANGLER: `${process.execPath} ${join(import.meta.dirname, 'fake-wrangler.ts')}`, FAKE_WRANGLER_DIR: fake, SSH_CONNECTION: '1' }
  let checked: Config | undefined
  const provider = (c: Config) => { checked = c; return { checks: () => [{ label: 'Worker answers', run: async () => {} }] } as any }
  const cloudflareApi = await fakeZonesApi({ dir: fake })
  cfCalls.length = 0
  // Cloudflare, deploy, domain example.com, the root domain (its MX goes to Google), no,
  // then mail.example.com, owner, make the changes, no test mail.
  const mxLookup = async (name: string) => (name === 'example.com' ? [{ exchange: 'aspmx.l.google.com', priority: 1 }] : [])
  const { code, text } = await run(['2', '1', '1', '2', 'n', '1', '', OWNER, '', 'n'], { env, provider, workerOnline: async () => {}, cloudflareApi, mxLookup })
  assert.equal(code, 0, text)
  assert.match(text, /Which domain\?\n {2}1\. example\.com\n {2}2\. example\.net/)
  assert.match(text, /1\. mail\.example\.com - recommended, leaves the mail of example\.com alone/)
  assert.match(text, /! example\.com currently gets its mail through Google Workspace \(aspmx\.l\.google\.com\)\.\n {2}Email Routing replaces these MX records, so all mail for example\.com goes to Cloudflare instead of Google Workspace/)
  assert.match(text, /Replace the MX records of example\.com\? \(y\/N\)/)
  assert.ok(!text.includes('fake-oauth-token'))
  assert.match(text, /Setup will make these changes on your Cloudflare account "Test account"/)
  assert.match(text, /The Worker "clankerinbox" at https:\/\/clankerinbox\.example\.com/)
  assert.match(text, /- The D1 database "clankerinbox" for the mail\.\n/)
  assert.match(text, /- A DNS record and a certificate for clankerinbox\.example\.com, the Worker's custom domain \(new\)\./)
  assert.match(text, /- Email Sending on mail\.example\.com\. The Worker can send only as clankerinbox@mail\.example\.com\./)
  assert.match(text, /- Email Routing on mail\.example\.com \(new\), with a routing rule to the Worker for each address:\n {6}agent@mail\.example\.com {2}\(new\)\n {6}signup@mail\.example\.com {2}\(new\)\n/)
  assert.match(text, /Make these changes\? \(Y\/n\)/)
  assert.match(text, /Log in to Cloudflare\. Open the link below/)
  for (const line of ['Logged in to Cloudflare: Test account', 'Your domains on Cloudflare', 'Database "clankerinbox"', 'Database tables', 'Email Sending on mail.example.com', 'Worker "clankerinbox" deployed at clankerinbox.example.com', 'Secret token set', 'The Worker is online', 'Saved the Worker token to'])
    assert.match(text, new RegExp(`✓ ${line.replace(/\./g, '\\.')}`))
  assert.match(text, /- Subaddressing on example\.com \(new\): mail to name\+tag@ goes to the rule of name@\./)
  assert.match(text, /✓ Email Routing on mail\.example\.com/)
  assert.match(text, /✓ Mail for agent@mail\.example\.com and signup@mail\.example\.com goes to the Worker/)
  assert.match(text, /✓ Subaddressing on example\.com \(signup\+<tag>@ goes to signup@\)/)
  assert.match(text, /Setup is complete\./)

  // Email Routing starts on the subdomain only, through the API; the rules go on the zone.
  // Plus addresses go through subaddressing, not through the catch-all.
  assert.deepEqual(cfCalls.filter((c) => c.method !== 'GET').map((c) => [c.method, c.url, c.body]), [
    ['POST', '/zones/z1/email/routing/dns', { name: 'mail.example.com' }],
    ['PATCH', '/zones/z1/email/routing', { support_subaddress: true }],
  ])
  const calls = readFileSync(join(fake, 'calls.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.ok(!calls.some((c) => c.args.slice(0, 3).join(' ') === 'email routing enable'), 'the root domain keeps its own mail')
  const rule = calls.find((c) => c.args.slice(0, 4).join(' ') === 'email routing rules create')
  assert.deepEqual(rule.args.slice(4, 7), ['example.com', '--zone-id', 'z1'])
  assert.ok(calls.some((c) => c.args.join(' ') === 'email sending enable mail.example.com'))
  assert.deepEqual(calls.filter((c) => c.args[0] === 'login').map((c) => c.args), [['login', '--help'], ['login', '--device']])
  assert.ok(calls.filter((c) => !['whoami', 'login', '--version', 'auth'].includes(c.args[0])).every((c) => c.account === 'acc1'), 'every step runs on the selected account')
  const token = readFileSync(join(fake, 'token'), 'utf8')
  assert.match(token, /^[0-9a-f]{64}$/)
  assert.equal(loadSecrets(path).CLANKERINBOX_CF_TOKEN, token)
  assert.ok(!text.includes(token), 'the token is never shown')
  const c = loadConfig(path)
  assert.equal(c.cloudflare?.url, 'https://clankerinbox.example.com')
  assert.equal(checked?.cloudflare?.url, 'https://clankerinbox.example.com')
  assert.match(c.from, /clankerinbox@mail\.example\.com/)
  const toml = readFileSync(join(dir, 'worker', 'wrangler.toml'), 'utf8')
  assert.match(toml, /^workers_dev = false$/m)
  assert.match(toml, /^routes = \[\{ pattern = "clankerinbox\.example\.com", custom_domain = true \}\]$/m)
  assert.ok(toml.indexOf('routes =') < toml.indexOf('[[d1_databases]]'), 'routes is a top-level key')
  assert.match(toml, /^database_id = "11111111-2222-3333-4444-555555555555"$/m)
  assert.match(toml, /^allowed_sender_addresses = \["clankerinbox@mail\.example\.com"\]$/m)
  assert.match(toml, /^SENDER = "clankerinbox@mail\.example\.com"$/m)
  assert.match(toml, /^\[observability\]\nenabled = true$/m)
  assert.ok(existsSync(join(dir, 'worker', 'worker.ts')))
  assert.ok(!calls.some((c) => c.args.includes('catch-all')), 'the catch-all of the user does not change')

  // Set up again where the login cannot change the zone settings: no new login, the
  // database stays, the saved token still works with the Worker so it stays, and setup
  // gives the link to turn on subaddressing and is not complete.
  const tokenCheck = async (_url: string, t: string) => t === readFileSync(join(fake, 'token'), 'utf8')
  // By hand and with create, between the two runs: another agent on the lists, and an inbox.
  const edited = loadConfig(path)
  edited.inboxes.agent.allow = [...edited.inboxes.agent.allow as string[], 'clankerinbox@peer.example']
  edited.inboxes.agent.send = [...edited.inboxes.agent.send, 'agent@peer.example']
  edited.inboxes.do = { id: 'do@mail.example.com', address: 'do@mail.example.com', mode: 'requests', allow: [OWNER], send: [OWNER] }
  writeFileSync(path, JSON.stringify(edited))
  writeFileSync(join(fake, 'rules.json'), JSON.stringify([...JSON.parse(readFileSync(join(fake, 'rules.json'), 'utf8')), {
    id: 'r9', enabled: true, matchers: [{ type: 'literal', field: 'to', value: 'do@mail.example.com' }], actions: [{ type: 'worker', value: ['clankerinbox'] }],
  }]))
  const again = await run(['2', '2', '1', '1', '1', '', OWNER, '', 'n'], { env, provider, workerOnline: async () => {}, cloudflareApi: await fakeZonesApi({ noZoneSettings: true, dir: fake }), mxLookup: noMx, tokenCheck })
  assert.equal(again.code, 1, again.text)
  // What exists is named as kept, what is new as new.
  assert.match(again.text, /- A DNS record and a certificate for clankerinbox\.example\.com, the Worker's custom domain \(exists: kept\)\./)
  assert.match(again.text, /- Email Routing on mail\.example\.com \(exists: kept\), with a routing rule to the Worker for each address:\n {6}agent@mail\.example\.com {2}\(exists: kept\)\n {6}signup@mail\.example\.com {2}\(exists: kept\)\n {2}- /)
  assert.match(again.text, /- Subaddressing on example\.com \(new\): mail to name\+tag@ goes to the rule of name@\./)
  // The lists and the inbox from the old config stay, and setup says so.
  const after = loadConfig(path)
  assert.deepEqual(after.inboxes.agent.allow, [OWNER, 'clankerinbox@peer.example'])
  assert.deepEqual(after.inboxes.agent.send, [OWNER, 'agent@peer.example'])
  assert.equal(after.inboxes.do?.mode, 'requests')
  assert.match(again.text, /✓ Kept from the old config: on the allow list of agent: clankerinbox@peer\.example; on the send list of agent: agent@peer\.example/)
  assert.match(again.text, /✓ Kept the inbox do \(do@mail\.example\.com\)/)
  assert.ok(!/Log in to Cloudflare\./.test(again.text))
  const later = readFileSync(join(fake, 'calls.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).slice(calls.length)
  assert.ok(!later.some((c) => c.args[1] === 'create' && c.args[0] === 'd1'))
  assert.ok(!later.some((c) => c.args[0] === 'secret'), 'the token of the Worker stays')
  assert.equal(readFileSync(join(fake, 'token'), 'utf8'), token)
  assert.match(again.text, /✓ The Worker "clankerinbox" already exists and the saved token works, so setup keeps it\./)
  assert.match(again.text, /The D1 database "clankerinbox" for the mail \(exists: reused\)/)
  assert.match(again.text, /It already exists: setup replaces its code and keeps its token/)
  assert.match(again.text, /✗ Subaddressing on example\.com/)
  assert.match(again.text, /Setup isn't finished\. The config is saved, but these steps failed:\n✗ Subaddressing on example\.com \(signup\+<tag>@ goes to signup@\)\n {2}Turn on "Subaddressing" at https:\/\/dash\.cloudflare\.com\/acc1\/example\.com\/email\/routing\/settings\. Until then, codes sent to signup\+<tag>@mail\.example\.com won't arrive\./)
  assert.match(again.text, /Fix those, then run CLANKERINBOX_CONFIG=\S+ clankerinbox check\. Or run setup again\. It reuses what's already there\./)
  assert.ok(!/Setup is complete/.test(again.text))
})

test('Cloudflare: the root domain uses wrangler to start Email Routing, if it has no other MX', async () => {
  const fake = mkdtempSync(join(tmpdir(), 'clankerinbox-wrangler-'))
  writeFileSync(join(fake, 'loggedin'), '1')
  const env: Env = { CLANKERINBOX_WRANGLER: `${process.execPath} ${join(import.meta.dirname, 'fake-wrangler.ts')}`, FAKE_WRANGLER_DIR: fake }
  const provider = () => ({ checks: () => [] }) as any
  const cloudflareApi = await fakeZonesApi()
  const { code, text } = await run(['2', '1', '2', '2', '', OWNER, '', 'n'], { env, provider, workerOnline: async () => {}, cloudflareApi, mxLookup: noMx })
  assert.equal(code, 0, text)
  const calls = readFileSync(join(fake, 'calls.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).args.join(' '))
  assert.ok(calls.includes('email routing enable example.net --zone-id z2'))
  assert.equal(loadConfig(path).inboxes.signup.address, 'signup@example.net')
})

test('Cloudflare free plan: the agent sends only to the verified people who answer', async () => {
  const fake = mkdtempSync(join(tmpdir(), 'clankerinbox-wrangler-'))
  writeFileSync(join(fake, 'loggedin'), '1')
  const env: Env = { CLANKERINBOX_WRANGLER: `${process.execPath} ${join(import.meta.dirname, 'fake-wrangler.ts')}`, FAKE_WRANGLER_DIR: fake }
  const provider = () => ({ checks: () => [] }) as any
  const cloudflareApi = await fakeZonesApi({ free: true })
  cfCalls.length = 0
  // Cloudflare, deploy, example.com, mail.example.com, owner, "check again" (still free),
  // then "only to the people who answer", make the changes, no test mail.
  const { code, text } = await run(['2', '1', '1', '1', '', OWNER, '2', '1', '', 'n'], {
    env, provider, workerOnline: async () => {}, cloudflareApi, mxLookup: noMx, verifyWait: { timeoutMs: 5000, intervalMs: 10 },
  })
  assert.equal(code, 0, text)
  assert.equal(text.match(/! Your account is on Workers Free\. Sending to any address needs Workers Paid \(\$5 a month\)\./g)?.length, 2)
  assert.match(text, /Upgrade to Workers Paid at https:\/\/dash\.cloudflare\.com\/acc1\/workers\/plans/)
  assert.match(text, new RegExp(`1\\. Only the people who answer - free: ${OWNER.replace(/\./g, '\\.')}`))
  assert.match(text, new RegExp(`The destination address ${OWNER.replace(/\./g, '\\.')}: the Worker sends only to it\\.\n {4}It sends as clankerinbox@mail\\.example\\.com\\.\n {4}Cloudflare mails it a verification link, unless it's already verified\\.`))
  assert.ok(!/Email Sending on agent/.test(text))
  assert.match(text, new RegExp(`✓ Destination address ${OWNER.replace(/\./g, '\\.')}`))
  assert.match(text, new RegExp(`Open Cloudflare's mail to ${OWNER.replace(/\./g, '\\.')} and click "Verify email address"\\.`))
  assert.match(text, new RegExp(`✓ ${OWNER.replace(/\./g, '\\.')} is verified`))
  assert.match(text, /Setup is complete\./)
  assert.deepEqual(cfCalls.filter((c) => c.url.startsWith('/accounts/acc1/email/routing/addresses') && c.method === 'POST').map((c) => c.body), [{ email: OWNER }])
  const calls = readFileSync(join(fake, 'calls.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).args.join(' '))
  assert.ok(!calls.some((c) => c.startsWith('email sending')), 'no Email Sending on the free plan')
  assert.ok(!readFileSync(join(dir, 'worker', 'wrangler.toml'), 'utf8').includes('crons'), 'no cron: it needs a workers.dev name')
})

test('Cloudflare: saying no to the deploy changes nothing; a failed step says so', async () => {
  const fake = mkdtempSync(join(tmpdir(), 'clankerinbox-wrangler-'))
  const env: Env = { CLANKERINBOX_WRANGLER: `${process.execPath} ${join(import.meta.dirname, 'fake-wrangler.ts')}`, FAKE_WRANGLER_DIR: fake }
  const cloudflareApi = await fakeZonesApi()
  cfCalls.length = 0
  writeFileSync(join(fake, 'loggedin'), '1')
  const no = await run(['2', '1', '1', '1', '', OWNER, 'n'], { env, cloudflareApi, mxLookup: noMx })
  assert.equal(no.code, 1)
  assert.match(no.text, /Nothing on your account was changed/)
  const calls = readFileSync(join(fake, 'calls.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).args.join(' '))
  assert.deepEqual(calls, ['--version', 'whoami --json', 'auth token --json', 'd1 list --json'], 'only reads before the yes')
  assert.ok(cfCalls.every((c) => c.method === 'GET'), 'only reads before the yes')
  assert.ok(!existsSync(path))

  const broken = await run(['2', '1'], { env: { ...env, CLANKERINBOX_WRANGLER: 'clankerinbox-no-such-wrangler' } })
  assert.equal(broken.code, 1)
  assert.match(broken.text, /✗ Wrangler \(Cloudflare's CLI\): clankerinbox-no-such-wrangler won't start\. Install Node\.js/)
  assert.match(broken.text, /Nothing on your account was changed/)
  assert.ok(!existsSync(path))
})

// A fake wrangler folder, logged in unless told otherwise, and the env that points setup at it.
function wranglerDir(loggedIn = true) {
  const fake = mkdtempSync(join(tmpdir(), 'clankerinbox-wrangler-'))
  if (loggedIn) writeFileSync(join(fake, 'loggedin'), '1')
  const env: Env = { CLANKERINBOX_WRANGLER: `${process.execPath} ${join(import.meta.dirname, 'fake-wrangler.ts')}`, FAKE_WRANGLER_DIR: fake }
  const calls = () => readFileSync(join(fake, 'calls.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).args.join(' '))
  return { fake, env, calls }
}
const fakeChecks = () => ({ checks: () => [{ label: 'Worker answers', run: async () => {} }] }) as any
const online = async () => {}

test('Cloudflare: a Worker that exists with another token is not cut off without a choice; its token can be kept', async () => {
  const { fake, env, calls } = wranglerDir()
  writeFileSync(join(fake, 'workers.json'), JSON.stringify(['clankerinbox']))
  writeFileSync(join(fake, 'domains.json'), JSON.stringify([{ hostname: 'clankerinbox.example.com', service: 'clankerinbox' }]))
  const cloudflareApi = await fakeZonesApi({ dir: fake })
  const tokenCheck = async (_u: string, t: string) => t === 'first-machine-token'
  // Cloudflare, deploy, example.com, mail.example.com, owner; the Worker exists: "Keep its
  // token", a wrong token, again "Keep its token", the right one; yes (the default is No), no test.
  const { code, text } = await run(['2', '1', '1', '1', '', OWNER, '1', 'wrong', '1', 'first-machine-token', 'y', 'n'],
    { env, provider: fakeChecks, workerOnline: online, cloudflareApi, mxLookup: noMx, tokenCheck })
  assert.equal(code, 0, text)
  assert.match(text, /! A Worker named "clankerinbox" already exists on this account\.\n {2}A new token cuts off every other machine that uses this Worker until it gets the new token\./)
  assert.match(text, /1\. Keep its token - paste it from config\.secrets\.json of a machine that uses it\n {2}2\. Give it a new token - other machines that use it stop working\n {2}3\. Use another name/)
  assert.match(text, /✗ The Worker rejected this token\./)
  assert.match(text, /✓ The Worker accepts this token\./)
  assert.match(text, /setup replaces its code and keeps its token/)
  assert.ok(!calls().some((c) => c.startsWith('secret put')), 'the token of the Worker stays')
  assert.equal(loadSecrets(path).CLANKERINBOX_CF_TOKEN, 'first-machine-token')
  assert.ok(!text.includes('first-machine-token'))
})

test('Cloudflare: "Give it a new token" says what it does; the choice is not asked twice, so Yes is the default', async () => {
  const { fake, env, calls } = wranglerDir()
  writeFileSync(join(fake, 'workers.json'), JSON.stringify(['clankerinbox']))
  const cloudflareApi = await fakeZonesApi({ dir: fake })
  const no = await run(['2', '1', '1', '1', '', OWNER, '2', 'n'], { env, provider: fakeChecks, workerOnline: online, cloudflareApi, mxLookup: noMx })
  assert.equal(no.code, 1)
  assert.match(no.text, /It already exists: setup replaces its code and gives it a new token\./)
  assert.match(no.text, /Make these changes\? \(Y\/n\)/)
  assert.match(no.text, /Nothing on your account was changed\./)
  assert.ok(!calls().some((c) => c === 'deploy' || c.startsWith('secret')))

  // "Use another name": a second Worker next to the first one, on its own host name.
  const other = await run(['2', '1', '1', '1', '', OWNER, '3', '', '', 'n'], { env, provider: fakeChecks, workerOnline: online, cloudflareApi, mxLookup: noMx })
  assert.equal(other.code, 0, other.text)
  assert.match(other.text, /✓ Worker "clankerinbox2" deployed at clankerinbox2\.example\.com/)
  const c = loadConfig(path)
  assert.equal(c.cloudflare?.url, 'https://clankerinbox2.example.com')
  assert.equal(c.cloudflare?.worker, 'clankerinbox2')
  assert.match(readFileSync(join(fake, 'deployed.toml'), 'utf8'), /^name = "clankerinbox2"$/m)
  // Its own database: the second Worker never reads the mail of the first.
  assert.match(readFileSync(join(fake, 'deployed.toml'), 'utf8'), /^database_name = "clankerinbox2"$/m)
  assert.match(other.text, /✓ Database "clankerinbox2"/)
  const rules = JSON.parse(readFileSync(join(fake, 'rules.json'), 'utf8'))
  assert.deepEqual(rules.map((r: any) => r.actions[0].value[0]), ['clankerinbox2', 'clankerinbox2'])
})

test('Cloudflare: a host name in use gets another one, before the deploy and when the deploy finds it taken', async () => {
  const { fake, env } = wranglerDir()
  const cloudflareApi = await fakeZonesApi({ dir: fake, dns: ['clankerinbox.example.com'] })
  // ..., the host is taken: the default clankerinbox2.example.com; the deploy says it is taken too: clankerinbox3.
  writeFileSync(join(fake, 'deployfail'), 'A custom domain for clankerinbox2.example.com already exists. [code: 100117]')
  const { code, text } = await run(['2', '1', '1', '1', '', OWNER, '', '', '', 'n'], { env, provider: fakeChecks, workerOnline: online, cloudflareApi, mxLookup: noMx })
  assert.equal(code, 0, text)
  assert.match(text, /! https:\/\/clankerinbox\.example\.com is taken by a DNS record \(A 192\.0\.2\.1\)\./)
  assert.match(text, /Worker host name: \(clankerinbox2\.example\.com\)/)
  assert.match(text, /clankerinbox2\.example\.com is taken\. Pick another host name for the Worker\./)
  assert.match(text, /Worker host name: \(clankerinbox3\.example\.com\)/)
  assert.equal(loadConfig(path).cloudflare?.url, 'https://clankerinbox3.example.com')
})

test('Cloudflare: an address whose rule forwards elsewhere is shown, and replaced only after a yes', async () => {
  const { fake, env } = wranglerDir()
  const forward = { id: 'r1', name: 'mine', enabled: true, matchers: [{ type: 'literal', field: 'to', value: 'agent@mail.example.com' }], actions: [{ type: 'forward', value: ['me@gmail.example'] }] }
  writeFileSync(join(fake, 'rules.json'), JSON.stringify([forward]))
  const cloudflareApi = await fakeZonesApi({ dir: fake })
  const no = await run(['2', '1', '1', '1', '', OWNER, ''], { env, provider: fakeChecks, workerOnline: online, cloudflareApi, mxLookup: noMx })
  assert.equal(no.code, 1)
  assert.match(no.text, / {6}agent@mail\.example\.com {2}\(replaces its rule, which forwards the mail to me@gmail\.example\)/)
  assert.match(no.text, /! The rule for agent@mail\.example\.com currently forwards the mail to me@gmail\.example\. Setup changes it to send the mail to the Worker\./)
  assert.match(no.text, /Make these changes\? \(y\/N\)/)
  assert.deepEqual(JSON.parse(readFileSync(join(fake, 'rules.json'), 'utf8')), [forward])

  const yes = await run(['2', '1', '1', '1', '', OWNER, 'y', 'n'], { env, provider: fakeChecks, workerOnline: online, cloudflareApi, mxLookup: noMx })
  assert.equal(yes.code, 0, yes.text)
  const rules = JSON.parse(readFileSync(join(fake, 'rules.json'), 'utf8'))
  assert.deepEqual(rules.map((r: any) => [r.matchers[0].value, r.enabled, r.actions[0]]), [
    ['agent@mail.example.com', true, { type: 'worker', value: ['clankerinbox'] }],
    ['signup@mail.example.com', true, { type: 'worker', value: ['clankerinbox'] }],
  ])
})

test('Cloudflare: replacing the MX records of a name is in the list of changes, and the default is No', async () => {
  const { fake, env } = wranglerDir()
  const cloudflareApi = await fakeZonesApi({ dir: fake })
  const mxLookup = async (name: string) => (name === 'example.com' ? [{ exchange: 'example-com.mail.protection.outlook.com', priority: 0 }] : [])
  // ..., the root domain, yes to the MX question, then Enter at "Make these changes?".
  const { code, text } = await run(['2', '1', '1', '2', 'y', '', OWNER, ''], { env, provider: fakeChecks, workerOnline: online, cloudflareApi, mxLookup })
  assert.equal(code, 1)
  assert.match(text, /! example\.com currently gets its mail through Microsoft 365/)
  assert.match(text, /! The MX records of example\.com \(Microsoft 365: example-com\.mail\.protection\.outlook\.com\) will be replaced\. All mail for example\.com then stops reaching Microsoft 365\./)
  assert.match(text, /Make these changes\? \(y\/N\)/)
  assert.match(text, /Nothing on your account was changed\./)
})

test('Cloudflare: a token in the shell that is not the new one is named, with the fix, and setup is not complete', async () => {
  const { fake, env } = wranglerDir()
  const cloudflareApi = await fakeZonesApi({ dir: fake })
  const { code, text } = await run(['2', '1', '1', '1', '', OWNER, '', 'n'],
    { env: { ...env, CLANKERINBOX_CF_TOKEN: 'old-token' }, provider: fakeChecks, workerOnline: online, cloudflareApi, mxLookup: noMx })
  assert.equal(code, 1, text)
  assert.match(text, /✗ CLANKERINBOX_CF_TOKEN in your shell holds a different token\n {2}It overrides the token setup just saved, so every command gets "401 unauthorized"\. Run `unset CLANKERINBOX_CF_TOKEN` and remove it from your shell profile/)
  assert.equal(loadSecrets(path).CLANKERINBOX_CF_TOKEN, readFileSync(join(fake, 'token'), 'utf8'))
})

test('Cloudflare free plan: one wait for all addresses; addresses not clicked make setup not complete, after the config and token are saved', async () => {
  const { fake, env } = wranglerDir()
  const two = 'two@example.org'
  const cloudflareApi = await fakeZonesApi({ dir: fake, free: true, neverVerified: [two] })
  const { code, text } = await run(['2', '1', '1', '1', '', `${OWNER}, ${two}`, '1', '', 'n'], {
    env, provider: fakeChecks, workerOnline: online, cloudflareApi, mxLookup: noMx, verifyWait: { timeoutMs: 300, intervalMs: 10 },
  })
  assert.equal(code, 1, text)
  assert.equal(text.match(/Open Cloudflare's mail/g)?.length, 1)
  assert.match(text, /Open Cloudflare's mail to owner@example\.org, two@example\.org and click "Verify email address" in each\./)
  assert.ok(text.indexOf('Saved the Worker token') < text.indexOf("Open Cloudflare's mail"), 'the token is saved before the wait')
  assert.match(text, /✗ two@example\.org is not verified\n {2}Click "Verify email address" in Cloudflare's mail to two@example\.org/)
  assert.ok(!/✗ owner@example\.org is not verified/.test(text))
  assert.ok(existsSync(path))
})

test('Cloudflare: a refusal that is not about the plan is a missing permission, not the free plan', async () => {
  const { fake, env } = wranglerDir()
  const cloudflareApi = await fakeZonesApi({ dir: fake, sendingError: { status: 403, code: 10000, message: 'Authentication error' } })
  const { code, text } = await run(['2', '1', '1', '1', '', OWNER], { env, provider: fakeChecks, workerOnline: online, cloudflareApi, mxLookup: noMx })
  assert.equal(code, 1)
  assert.ok(!/Workers Free plan/.test(text))
  assert.match(text, /The wrangler login does not have this permission\. Run `npx wrangler login` again and allow every permission it asks for/)
  assert.match(text, /Nothing on your account was changed\./)
})

test('Cloudflare: a failed login can be tried again; a wrangler without --device logs in without it', async () => {
  const { fake, env, calls } = wranglerDir(false)
  writeFileSync(join(fake, 'loginfails'), '1')
  writeFileSync(join(fake, 'nodevice'), '1')
  const cloudflareApi = await fakeZonesApi({ dir: fake })
  const { code, text } = await run(['2', '1', '1', '1', '1', '', OWNER, '', 'n'],
    { env: { ...env, SSH_CONNECTION: '1' }, provider: fakeChecks, workerOnline: online, cloudflareApi, mxLookup: noMx })
  assert.equal(code, 0, text)
  assert.match(text, /✗ Not logged in to Cloudflare\.\n {2}Setup ran: npx wrangler login\. This wrangler can't log in with a code\. Update it, or log in on a machine with a browser\./)
  assert.match(text, /1\. Try again\n {2}2\. Stop here/)
  assert.deepEqual(calls().filter((c) => c.startsWith('login')), ['login --help', 'login', 'login --help', 'login'])
})

test('Cloudflare: an account without a domain goes back to the account choice; a pending domain says why it cannot be used', async () => {
  const { fake, env } = wranglerDir()
  writeFileSync(join(fake, 'accounts.json'), JSON.stringify([{ id: 'acc2', name: 'Empty account' }, { id: 'acc1', name: 'Test account' }]))
  const cloudflareApi = await fakeZonesApi({ dir: fake, zones: [{ id: 'z3', name: 'new.example', status: 'pending' }, { id: 'z1', name: 'example.com', status: 'active' }] })
  // Account 1 (empty): "Select another account", account 2, the pending domain: "Select another",
  // account 2 again, then example.com.
  const { code, text } = await run(['2', '1', '1', '1', '2', '2', '1', '2', '1', '1', '', OWNER, '', 'n'],
    { env, provider: fakeChecks, workerOnline: online, cloudflareApi, mxLookup: noMx })
  assert.equal(code, 0, text)
  assert.match(text, /✗ This Cloudflare account has no domain\.\n {2}Add a domain at https:\/\/dash\.cloudflare\.com\/acc2\/add-site\./)
  assert.match(text, /1\. Select another account\n {2}2\. Stop here/)
  assert.match(text, /2\. new\.example - pending: not active yet/)
  assert.match(text, /✗ new\.example is not active on Cloudflare yet \(status: pending\)\.\n {2}Cloudflare activates a domain once its name servers point to/)
  assert.equal(loadConfig(path).inboxes.signup.address, 'signup@mail.example.com')
})

test('Cloudflare: a deploy that fails says what is on the account now and that setup asks again', async () => {
  const { fake, env } = wranglerDir()
  writeFileSync(join(fake, 'deployfail'), 'Something broke. [code: 10000]')
  const cloudflareApi = await fakeZonesApi({ dir: fake })
  const { code, text } = await run(['2', '1', '1', '1', '', OWNER, ''], { env, provider: fakeChecks, workerOnline: online, cloudflareApi, mxLookup: noMx })
  assert.equal(code, 1)
  assert.match(text, /✗ Worker "clankerinbox" deployed at clankerinbox\.example\.com: Something broke/)
  assert.match(text, /The config was not saved\. Fix that, then run setup again\. It reuses what's already there\./)
  assert.match(text, /Created on your Cloudflare account \(to remove these, see "Remove the Worker" in the README\):\n {2}- the D1 database "clankerinbox"\n {2}- Email Sending on mail\.example\.com\n/)
  assert.ok(!/continues from the step/.test(text))
  assert.ok(!existsSync(path))
})

test('the free-plan wait goes on at Enter in a terminal', async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {} })
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 })
  let text = ''
  output.on('data', (c) => (text += c))
  const p = new Prompter({ input, output } as any, { NO_COLOR: '1' })
  const never = async () => ({ success: true, result: [], result_info: { total_pages: 1 } })
  setTimeout(() => input.write('\r'), 100)
  const left = await waitForClicks(p, never, 'acc1', ['a@example.org'], { timeoutMs: 60_000, intervalMs: 20 })
  assert.deepEqual(left, ['a@example.org'])
  assert.match(text, /Press Enter to continue and verify later\./)
  assert.match(text, /! Not verified yet: a@example\.org \(you chose to verify later\)/)
})

test('a long menu in a terminal shows one page and filters by what is typed', async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {} })
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 40, rows: 12 })
  let text = ''
  output.on('data', (c) => (text += c))
  const p = new Prompter({ input, output } as any, { NO_COLOR: '1' })
  const choices = Array.from({ length: 120 }, (_, i) => ({ label: `domain${i}.example`, value: `d${i}`, note: 'a note that is much too long for forty columns' }))
  setTimeout(() => input.write('7'), 30)
  setTimeout(() => input.write('7'), 60)
  setTimeout(() => input.write('\x1b[B'), 90)
  setTimeout(() => input.write('\r'), 120)
  const picked = await p.select('Which domain?', choices)
  assert.equal(picked, 'd77')
  const frames = text.split('\x1b[J')
  // Each drawing has at most a page of choices plus the filter line, and no line wider than the terminal.
  for (const f of frames) {
    const rows = f.split('\n').filter((l) => /domain\d+/.test(l))
    assert.ok(rows.length <= 8, `${rows.length} rows`)
    for (const l of f.split('\n')) assert.ok(l.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').length <= 40, l)
  }
  assert.match(text, /120 choices\. Type to filter\n/)
  assert.match(text, /Filter "77": 1 of 120\n/)
  assert.match(text, /Which domain\? domain77\.example\n$/)
})

test('clankerinbox check runs the same checks from the CLI, with a saved token, and says what to do', async () => {
  writeFileSync(path, JSON.stringify({
    provider: 'cloudflare', teamId: '', from: 'bot@mail.example.com',
    cloudflare: { url: 'http://localhost:1', tokenEnv: 'CF_TOKEN' },
    inboxes: { ask: { id: 'a@mail.example.com', address: 'a@mail.example.com', mode: 'answers', allow: [OWNER], send: [OWNER] } },
  }))
  writeFileSync(secretsPath(path), JSON.stringify({ CF_TOKEN: 'tok' }), { mode: 0o600 })
  const res = await new Promise<{ code: number; stdout: string }>((resolve) => {
    const child = spawn(process.execPath, [BIN, 'check', '--json'], {
      env: { PATH: process.env.PATH!, HOME: dir, CLANKERINBOX_CONFIG: path },
    })
    let stdout = ''
    child.stdout.on('data', (c) => (stdout += c))
    child.on('close', (code) => resolve({ code: code ?? 1, stdout }))
  })
  assert.equal(res.code, 1)
  const out = JSON.parse(res.stdout)
  assert.equal(out.ok, false)
  assert.equal(out.checks[0].ok, true)
  assert.match(out.checks[0].text, /^Token found: CF_TOKEN in \S+config\.secrets\.json$/)
  assert.match(out.checks[1].text, /Worker answers/)
  assert.match(out.advice, /Check the Worker URL\. `wrangler deploy` prints it\./)
})

test('clankerinbox check: a token from the shell that the Worker refuses is named, and the saved one it hides', async () => {
  const url = await fakeWorker()
  writeFileSync(path, JSON.stringify({
    provider: 'cloudflare', teamId: '', from: 'bot@mail.example.com',
    cloudflare: { url, tokenEnv: 'CLANKERINBOX_CF_TOKEN' },
    inboxes: { ask: { id: 'a@mail.example.com', address: 'a@mail.example.com', mode: 'answers', allow: [OWNER], send: [OWNER] } },
  }))
  writeFileSync(secretsPath(path), JSON.stringify({ CLANKERINBOX_CF_TOKEN: TOKEN }), { mode: 0o600 })
  const check = (extra: Record<string, string>) => new Promise<any>((resolve) => {
    const child = spawn(process.execPath, [BIN, 'check', '--json'], { env: { PATH: process.env.PATH!, HOME: dir, CLANKERINBOX_CONFIG: path, ...extra } })
    let stdout = ''
    child.stdout.on('data', (c) => (stdout += c))
    child.on('close', (code) => resolve({ code, ...JSON.parse(stdout) }))
  })
  const stale = await check({ CLANKERINBOX_CF_TOKEN: 'old-token' })
  assert.equal(stale.code, 1)
  assert.match(stale.advice, /It came from the environment \(CLANKERINBOX_CF_TOKEN\), not from config\.secrets\.json\. config\.secrets\.json has a different token, but the environment overrides it\. Run `unset CLANKERINBOX_CF_TOKEN`/)
  // With the saved token: the Worker is healthy; without a wrangler login the rules are not checked, which is a warning.
  const ok = await check({})
  assert.equal(ok.code, 0, JSON.stringify(ok))
  assert.deepEqual(ok.checks.map((c: any) => [c.ok, !!c.warning]), [[true, false], [true, false], [true, false], [true, true]])
  assert.match(ok.checks[2].text, /Worker is ready/)
  assert.match(ok.checks[3].text, /Routing rules .*not checked: the Worker was not deployed from this machine/)
  assert.doesNotMatch(ok.checks[3].text, /no wrangler login/)
})

test('a short menu in a terminal: a number key picks at once, and the hint says so', async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {} })
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 })
  let text = ''
  output.on('data', (c) => (text += c))
  const p = new Prompter({ input, output } as any, { NO_COLOR: '1' })
  const choices = ['PostShiba', 'Cloudflare', 'Other'].map((label) => ({ label, value: label.toLowerCase() }))
  setTimeout(() => input.write('2'), 30)
  assert.equal(await p.select('Which mail service?', choices), 'cloudflare')
  assert.match(text, /Which mail service\? \(↑↓ and Enter, or 1-3\)/)
  assert.match(text, /Which mail service\? Cloudflare\n$/)
  // Arrows still need Enter; a number past the list does nothing.
  setTimeout(() => input.write('7'), 30)
  setTimeout(() => input.write('\x1b[B'), 60)
  setTimeout(() => input.write('\r'), 90)
  assert.equal(await p.select('Which mail service?', choices), 'cloudflare')
})
