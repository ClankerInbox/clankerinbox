// Setup in a terminal on PostShiba: keys that fail or are missing, where they come from, the
// domain and its mail, and how setup stops. The questions get their answers as lines.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { onboard, Prompter, type OnboardOptions } from '../src/onboard.ts'
import { loadConfig, loadSecrets, secretsPath, type Config } from '../src/config.ts'
import { ClankerError } from '../src/errors.ts'
import { spinner, makeUi } from '../src/ui.ts'
import { createProvider, type Env } from '../src/provider.ts'
import { FakePostShiba, FULL_KEY, SEND_KEY, TEAM } from './fake-postshiba.ts'

const ROOT = join(import.meta.dirname, '..')
const BIN = join(ROOT, 'bin', 'clankerinbox.ts')
const OWNER = 'owner@example.org'

let dir: string
let path: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'clankerinbox-ps-'))
  path = join(dir, 'config.json')
})

type RunOpts = Partial<Pick<OnboardOptions, 'provider' | 'apiUrl' | 'replyWait' | 'mxLookup' | 'flags'>> & { env?: Env }

async function run(answers: string[], opts: RunOpts = {}) {
  const input = new PassThrough()
  const output = new PassThrough()
  let text = ''
  output.on('data', (c) => (text += c))
  input.end(answers.map((a) => a + '\n').join(''))
  const { env, ...hooks } = opts
  const code = await onboard({ input, output, configPath: path, env: { CLANKERINBOX_STATE: join(dir, 'state'), ...env }, mxLookup: async () => [], ...hooks })
  return { code, text }
}

async function withApi(fn: (api: FakePostShiba, apiUrl: string) => Promise<void>) {
  const api = new FakePostShiba()
  const apiUrl = await api.start()
  try {
    await fn(api, apiUrl)
  } finally {
    await api.stop()
  }
}

// A saved setup on the fake: the config, and the keys in config.secrets.json.
async function savedSetup(api: FakePostShiba, apiUrl: string, secrets: Record<string, string>) {
  const ask = api.addInbox('agent@inbox.example.com')
  const signup = api.addInbox('signup@inbox.example.com')
  const config: Config = {
    teamId: TEAM, from: 'Clanker Inbox <clankerinbox@inbox.example.com>', apiUrl, domain: 'inbox.example.com',
    sendKeyEnv: 'POSTSHIBA_SEND_API_KEY', readKeyEnv: 'POSTSHIBA_FULL_API_KEY',
    inboxes: {
      agent: { id: ask.id, address: ask.address, mode: 'answers', allow: [OWNER], send: [OWNER] },
      signup: { id: signup.id, address: signup.address, mode: 'codes', allow: '*', send: [] },
    },
  }
  writeFileSync(path, JSON.stringify(config))
  writeFileSync(secretsPath(path), JSON.stringify(secrets), { mode: 0o600 })
}

test('a wrong send key is found by the check, named with its file, and can be typed again and saved', async () => {
  await withApi(async (api, apiUrl) => {
    await savedSetup(api, apiUrl, { POSTSHIBA_FULL_API_KEY: FULL_KEY, POSTSHIBA_SEND_API_KEY: 'stale-send-key' })
    // Check it; the send key fails: type it again, save it (default yes: it came from the file), no test mail.
    const { code, text } = await run(['1', '1', SEND_KEY, '', 'n'])
    assert.equal(code, 0, text)
    assert.match(text, /✗ Send key \(POSTSHIBA_SEND_API_KEY in \S+config\.secrets\.json\): PostShiba did not accept the key in POSTSHIBA_SEND_API_KEY \(401\)/)
    assert.match(text, /PostShiba rejected the send key\. Use a Send only key/)
    assert.ok(text.includes(`The send key comes from ${secretsPath(path)} (POSTSHIBA_SEND_API_KEY).`), text)
    assert.ok(!/in your environment/.test(text))
    assert.match(text, /1\. Enter the send key again/)
    assert.match(text, /PostShiba send key: /)
    assert.match(text, /Save it in .*config\.secrets\.json\? \(Y\/n\)/)
    assert.match(text, /✓ Send key \(POSTSHIBA_SEND_API_KEY in \S+config\.secrets\.json\)\n/)
    assert.match(text, /✓ PostShiba lets inbox\.example\.com send/)
    assert.match(text, /Setup is complete\./)
    assert.equal(loadSecrets(path).POSTSHIBA_SEND_API_KEY, SEND_KEY)
  })
})

test('a send key that the test mail shows to be refused is not "complete": it gets advice and can be typed again', async () => {
  await withApi(async (api, apiUrl) => {
    await savedSetup(api, apiUrl, { POSTSHIBA_FULL_API_KEY: FULL_KEY, POSTSHIBA_SEND_API_KEY: SEND_KEY })
    // A provider whose send is refused once, as a key PostShiba stopped accepting would be.
    let refusals = 1
    const provider = (config: Config, env: Env) => {
      const real = createProvider(config, env)
      return Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
        send: (m: any, o: any) => (refusals-- > 0 ? Promise.reject(new ClankerError('auth', 'PostShiba POST /emails: 401 unauthorized', { status: 401 })) : real.send(m, o)),
      })
    }
    // Check it, send the test, refused: "Stop here".
    const stop = await run(['1', '', '2'], { provider })
    assert.equal(stop.code, 1, stop.text)
    assert.match(stop.text, /✗ Sent to owner@example\.org: PostShiba POST \/emails: 401/)
    assert.match(stop.text, /PostShiba rejected the send key\. Use a Send only key/)
    assert.match(stop.text, /1\. Enter the send key again\n {2}2\. Stop here/)
    assert.match(stop.text, /Setup isn't finished\.[^]*The send key in POSTSHIBA_SEND_API_KEY doesn't work/)
    assert.ok(!/Setup is complete/.test(stop.text))

    // Typed again: the mail goes out, and setup waits for the reply.
    refusals = 1
    const again = await run(['1', '', '1', SEND_KEY, 'n'], { provider, replyWait: { timeoutMs: 100, intervalMs: 20 } })
    assert.equal(again.code, 0, again.text)
    assert.match(again.text, /✓ Sent to owner@example\.org/)
    assert.equal(loadSecrets(path).POSTSHIBA_SEND_API_KEY, SEND_KEY)
  })
})

test('a stale full-access key in config.secrets.json: "Set up again" names the file and asks for the key again', async () => {
  await withApi(async (api, apiUrl) => {
    await savedSetup(api, apiUrl, { POSTSHIBA_FULL_API_KEY: 'stale-full', POSTSHIBA_SEND_API_KEY: SEND_KEY })
    // Set up again, PostShiba; the key fails: type it again, then domain 1, name, owner, save, no test.
    const { code, text } = await run(['2', '1', '1', FULL_KEY, '1', '', OWNER, '', 'n'], { apiUrl })
    assert.equal(code, 0, text)
    assert.match(text, /✗ That key doesn't work: .*401/)
    assert.ok(text.includes(`The key comes from ${secretsPath(path)} (POSTSHIBA_FULL_API_KEY).`), text)
    assert.ok(!/in your environment/.test(text))
    assert.match(text, /1\. Enter the key again\n {2}2\. Stop here/)
    assert.equal(loadSecrets(path).POSTSHIBA_FULL_API_KEY, FULL_KEY)
  })
})

test('a missing full-access key can be typed in "Check it"; it is saved only after a yes', async () => {
  await withApi(async (api, apiUrl) => {
    await savedSetup(api, apiUrl, { POSTSHIBA_SEND_API_KEY: SEND_KEY })
    // Check it; no full key: type it, do not save it (the default is No), no test mail.
    const { code, text } = await run(['1', '1', FULL_KEY, '', 'n'])
    assert.equal(code, 0, text)
    assert.match(text, /✗ Read mail from PostShiba \(POSTSHIBA_FULL_API_KEY\): no full-access key: set POSTSHIBA_FULL_API_KEY/)
    assert.match(text, /Enter it below, or set it in your shell\./)
    assert.match(text, /1\. Enter the full-access key\n/)
    assert.match(text, /PostShiba full-access key: /)
    assert.match(text, /\(y\/N\)/)
    assert.match(text, /The keys were not saved\. Set POSTSHIBA_FULL_API_KEY in your shell/)
    assert.deepEqual(loadSecrets(path), { POSTSHIBA_SEND_API_KEY: SEND_KEY })
    assert.ok(!text.includes(FULL_KEY))
  })
})

test('the sign-up help is shown once; a send-only key in the full-access slot is named as such', async () => {
  await withApi(async (_api, apiUrl) => {
    // PostShiba, a send-only key, a wrong key, the right key, the full key as the send key, domain 1, name, owner, save, no test.
    const { code, text } = await run(['1', SEND_KEY, 'wrong', FULL_KEY, FULL_KEY, '1', '', OWNER, '', 'n'], { apiUrl })
    assert.equal(code, 0, text)
    assert.equal(text.split('Sign up at https://app.postshiba.com/users/sign_up').length, 2, 'once')
    assert.match(text, /✗ That's a send-only key\. Use a Full access key/)
    assert.match(text, /✗ That key doesn't work: .*401/)
    assert.match(text, /Sending with the full-access key\. It can read mail too, so a Send only key is safer\./)
  })
})

test('CLANKERINBOX_SETUP_KEY_ENV names the full-access key in setup, and the config reads mail with it', async () => {
  await withApi(async (_api, apiUrl) => {
    const env = { CLANKERINBOX_SETUP_KEY_ENV: 'MY_FULL_KEY', MY_FULL_KEY: FULL_KEY, POSTSHIBA_SEND_API_KEY: SEND_KEY }
    const { code, text } = await run(['1', '1', '', OWNER, 'n'], { apiUrl, env })
    assert.equal(code, 0, text)
    assert.equal(loadConfig(path).readKeyEnv, 'MY_FULL_KEY')
    assert.match(text, /✓ Read mail from PostShiba \(MY_FULL_KEY in the environment\)/)
    // A key where its name belongs is refused, and never printed.
    path = join(dir, 'other.json')
    const bad = await run(['1'], { apiUrl, env: { CLANKERINBOX_SETUP_KEY_ENV: 'abc123def456abc123def456' } })
    assert.equal(bad.code, 1)
    assert.match(bad.text, /CLANKERINBOX_SETUP_KEY_ENV needs the name of an env var/)
    assert.ok(!bad.text.includes('abc123def456abc123def456'))
  })
})

test('"Your email address" splits on commas, semicolons and spaces, refuses junk and shows the list; the domain is cleaned', async () => {
  await withApi(async (_api, apiUrl) => {
    const env = { POSTSHIBA_FULL_API_KEY: FULL_KEY, POSTSHIBA_SEND_API_KEY: SEND_KEY }
    // PostShiba, "Add a new domain" with a URL and a dot at the end, check later, name, a bad list, a good one.
    const { code, text } = await run(['1', '2', 'HTTPS://Agents.Example.dev./setup', '2', '', 'me@example.org;;nope', 'Me@Example.org; you@example.org other@example.org', 'n'], { apiUrl, env })
    assert.equal(code, 1, text)
    assert.match(text, /Domain: agents\.example\.dev\n/)
    assert.match(text, /✓ Added agents\.example\.dev to PostShiba/)
    assert.match(text, /The address "nope" is not one email address\./)
    assert.match(text, /Only replies from me@example\.org, you@example\.org, other@example\.org count\./)
    const c = loadConfig(path)
    assert.deepEqual(c.inboxes.agent.allow, ['me@example.org', 'you@example.org', 'other@example.org'])
    assert.equal(c.inboxes.agent.address, 'agent@agents.example.dev')
  })
})

test('a domain that gets mail elsewhere: setup names the service, asks with No as the default, and offers a subdomain', async () => {
  await withApi(async (_api, apiUrl) => {
    const env = { POSTSHIBA_FULL_API_KEY: FULL_KEY, POSTSHIBA_SEND_API_KEY: SEND_KEY }
    const looked: string[] = []
    const mxLookup = async (name: string) => {
      looked.push(name)
      return name === 'inbox.example.com' ? [{ exchange: 'aspmx.l.google.com', priority: 1 }] : []
    }
    // Domain 1, keep its mail (default No), take the suggested subdomain, check later, name, owner, no test.
    const { code, text } = await run(['1', '1', '', '', '2', '', OWNER], { apiUrl, env, mxLookup })
    assert.equal(code, 1, text)
    assert.match(text, /! inbox\.example\.com currently gets its mail through Google Workspace \(aspmx\.l\.google\.com\)\./)
    assert.match(text, /sends all mail for inbox\.example\.com to PostShiba instead of Google Workspace/)
    assert.match(text, /Move all mail for inbox\.example\.com to PostShiba\? \(y\/N\)/)
    assert.match(text, /New domain: \(inbox\.inbox\.example\.com\)/)
    assert.ok(!/there is no MX record/.test(text))
    assert.deepEqual(looked.slice(0, 2), ['inbox.example.com', 'inbox.inbox.example.com'])
    assert.equal(loadConfig(path).domain, 'inbox.inbox.example.com')
  })
})

test('"Stop here" at the DNS records says what stays on PostShiba and how to go on', async () => {
  await withApi(async (api, apiUrl) => {
    const env = { POSTSHIBA_FULL_API_KEY: FULL_KEY, POSTSHIBA_SEND_API_KEY: SEND_KEY }
    const { code, text } = await run(['1', '2', 'agents.example.dev', '3'], { apiUrl, env })
    assert.equal(code, 1)
    assert.match(text, /Setup stopped\. Nothing was saved\. The domain agents\.example\.dev, which setup added, is still on PostShiba\.\nTo continue: add the records above, then run CLANKERINBOX_CONFIG=\S+ clankerinbox setup again and pick agents\.example\.dev\./)
    assert.ok(!existsSync(path))
    assert.equal(api.domains.length, 2)
  })
})

test('end of input at a question stops setup with a message and exit 1; nothing is saved', async () => {
  await withApi(async (_api, apiUrl) => {
    const env = { POSTSHIBA_FULL_API_KEY: FULL_KEY, POSTSHIBA_SEND_API_KEY: SEND_KEY }
    const { code, text } = await run(['1', '1'], { apiUrl, env })
    assert.equal(code, 1)
    assert.match(text, /Setup stopped\. Nothing was saved\.\n$/)
    assert.ok(!existsSync(path))
  })
})

test('a corrupt config is named with its path, and setup offers to set up again', async () => {
  writeFileSync(path, '{ not json')
  const { code, text } = await run(['2'])
  assert.equal(code, 0)
  assert.ok(text.includes(`! The config at ${path} is not valid JSON`), text)
  assert.match(text, /Setup can write a new one\. The old file is kept as config\.json\.bak\./)
  assert.match(text, /1\. Set up again - the old config is backed up\n {2}2\. Leave it/)
})

test('"Set up again" names the backup, also when an older one moved aside', async () => {
  await withApi(async (api, apiUrl) => {
    await savedSetup(api, apiUrl, { POSTSHIBA_FULL_API_KEY: FULL_KEY, POSTSHIBA_SEND_API_KEY: SEND_KEY })
    writeFileSync(path + '.bak', '{"older":true}')
    const { code, text } = await run(['2', '1', '1', '', OWNER, 'n'], { apiUrl })
    assert.equal(code, 0, text)
    assert.ok(text.includes(`✓ Old config saved as ${path}.bak (the previous backup is now ${path}.bak-`), text)
  })
})

test('CLANKERINBOX_POSTSHIBA_API and --api-url point setup at another PostShiba, and the config keeps it', async () => {
  await withApi(async (_api, apiUrl) => {
    const env = { POSTSHIBA_FULL_API_KEY: FULL_KEY, POSTSHIBA_SEND_API_KEY: SEND_KEY }
    const byEnv = await run(['1', '1', '', OWNER, 'n'], { env: { ...env, CLANKERINBOX_POSTSHIBA_API: apiUrl } })
    assert.equal(byEnv.code, 0, byEnv.text)
    assert.equal(loadConfig(path).apiUrl, apiUrl)
    // --api-url and --tenant: PostShiba without the question, and both in the config.
    const byFlag = await run(['2', '1', '', OWNER, 'n'], { env, flags: { apiUrl, tenant: 'acme' } })
    assert.equal(byFlag.code, 0, byFlag.text)
    assert.match(byFlag.text, /Mail service: PostShiba \(--api-url http:\/\/127\.0\.0\.1:\d+\/api\/v1, --tenant acme\)/)
    assert.ok(!/Which mail service/.test(byFlag.text))
    assert.equal(loadConfig(path).tenant, 'acme')
    // A plain http API elsewhere would carry the keys in the clear.
    path = join(dir, 'other.json')
    const plain = await run(['1'], { env: { ...env, CLANKERINBOX_POSTSHIBA_API: 'http://api.example.org/v1' } })
    assert.equal(plain.code, 1)
    assert.match(plain.text, /The PostShiba API must be an https:\/\/ URL/)
  })
})

test('the test question: a new mail from the owner that is not a reply is explained', async () => {
  await withApi(async (api, apiUrl) => {
    const env = { POSTSHIBA_FULL_API_KEY: FULL_KEY, POSTSHIBA_SEND_API_KEY: SEND_KEY }
    const owner = (async () => {
      while (!api.sends.length) await new Promise((r) => setTimeout(r, 10))
      const to = api.sends[0].body.reply_to as string
      const inbox = api.inboxes.find((i) => i.address === to.replace(/\+[^@]*/, ''))!
      api.deliver(inbox.id, { from: OWNER, to: inbox.address, subject: 'hello', text: 'a new mail' })
      await new Promise((r) => setTimeout(r, 100))
      api.deliver(inbox.id, { from: OWNER, to, subject: 'Re: clankerinbox test', text: 'ok', headers: { 'in-reply-to': `<${api.sends[0].messageId}>` } })
    })()
    const { code, text } = await run(['1', '1', '', OWNER, ''], { env, apiUrl, replyWait: { timeoutMs: 5000, intervalMs: 20 } })
    await owner
    assert.equal(code, 0, text)
    assert.match(text, /! Got a mail from owner@example\.org, but it isn't a reply to the test question\.\n {2}Hit Reply on the "clankerinbox test" mail/)
    assert.match(text, /✓ Got your reply from owner@example\.org: "ok"/)
    // The test mail asks for the reply once, and its body does not repeat the subject.
    const body = api.sends[0].body.text as string
    assert.equal(body.split('Reply to this email').length, 2, body)
  })
})

// A terminal as a stream pair, for the code that draws in place.
function terminal(columns = 80, env: Env = { NO_COLOR: '1' }) {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {} })
  const output = Object.assign(new PassThrough(), { isTTY: true, columns, rows: 24 })
  let text = ''
  output.on('data', (c) => (text += c))
  return { input, output, p: new Prompter({ input, output } as any, env), text: () => text }
}

// What a terminal of this width shows after the output: text, \r, \n, cursor up, clear.
function screen(out: string, cols: number): string[] {
  const lines: string[][] = [[]]
  let r = 0
  let c = 0
  for (let i = 0; i < out.length; i++) {
    const m = /^\x1b\[([0-9;]*)([A-Za-z])/.exec(out.slice(i))
    if (m) {
      if (m[2] === 'A') r = Math.max(0, r - Number(m[1] || 1))
      if (m[2] === 'J') { lines.length = r + 1; lines[r] = lines[r].slice(0, c) }
      if (m[2] === 'K') lines[r] = m[1] === '2' ? [] : lines[r].slice(0, c)
      i += m[0].length - 1
      continue
    }
    const ch = out[i]
    if (ch === '\r') c = 0
    else if (ch === '\n') { r++; c = 0; while (lines.length <= r) lines.push([]) }
    else {
      if (c >= cols) { r++; c = 0; while (lines.length <= r) lines.push([]) }
      while (lines[r].length < c) lines[r].push(' ')
      lines[r][c++] = ch
    }
  }
  return lines.map((l) => l.join('')).filter((l, k, all) => l || k < all.length - 1)
}

test('a menu at 40 columns: the marked line is the selection, and the answer replaces the question', async () => {
  const t = terminal(40)
  setTimeout(() => t.input.write('\x1b[B'), 20)
  setTimeout(() => t.input.write('\r'), 40)
  const picked = await t.p.select('Which mail service?', [
    { label: 'PostShiba', value: 'postshiba', note: 'email API, addresses on your own domain' },
    { label: 'Cloudflare', value: 'cloudflare', note: 'a Worker on your Cloudflare domain' },
  ])
  assert.equal(picked, 'cloudflare')
  // What stays on the screen: the question and the answer, nothing of the list.
  const shown = screen(t.text(), 40)
  assert.equal(shown.join(''), 'Which mail service? Cloudflare', shown.join('\n'))
  assert.ok(!shown.some((l) => /PostShiba|›/.test(l)), shown.join('\n'))
  // Before the Enter, the marked line was Cloudflare.
  const before = screen(t.text().slice(0, t.text().lastIndexOf('\x1b[')), 40)
  assert.ok(before.some((l) => l.startsWith('  › Cloudflare')), before.join('\n'))
  assert.ok(!before.some((l) => l.startsWith('  › PostShiba')), before.join('\n'))
  // The keys are named, numbers too, when they fit; a number picks at once.
  const wide = terminal(80)
  setTimeout(() => wide.input.write('2'), 20)
  assert.equal(await wide.p.select('Which?', [{ label: 'a', value: 'a' }, { label: 'b', value: 'b' }]), 'b')
  assert.match(wide.text(), /Which\? \(↑↓ and Enter, or 1-2\)/)
})

test('TERM=dumb: numbered menus and plain lines, no cursor codes or colour; the spinner is one plain line', async () => {
  const t = terminal(80, { TERM: 'dumb' })
  setTimeout(() => t.input.write('2\n'), 20)
  const picked = await t.p.select('Which?', [{ label: 'a', value: 'a' }, { label: 'b', value: 'b' }])
  assert.equal(picked, 'b')
  assert.match(t.text(), /Which\?\n {2}1\. a\n {2}2\. b\n/)
  const spin = t.p.spin('Setup waits')
  spin.stop('done')
  assert.ok(!t.text().includes('\x1b'), JSON.stringify(t.text()))
  assert.match(t.text(), /Setup waits \(Ctrl\+C stops\)\ndone\n$/)
})

test('the spinner line is cut to the terminal width', async () => {
  const out = Object.assign(new PassThrough(), { isTTY: true, columns: 40 }) as any
  let text = ''
  out.on('data', (c: Buffer) => (text += c))
  const s = spinner('Waiting for your reply. Open the mail "clankerinbox test" and reply to it.', out, makeUi(out, { NO_COLOR: '1' }), { env: {} })
  await new Promise((r) => setTimeout(r, 200))
  s.stop()
  const frames = text.split('\r\x1b[2K').filter(Boolean)
  assert.ok(frames.length >= 2)
  for (const f of frames) assert.ok(f.length <= 39, `${f.length}: ${f}`)
  assert.match(frames[0], /…/)
})

test('a pasted key that ends with a line break does not answer the next question', async () => {
  const t = terminal(80)
  const first = t.p.secret('PostShiba full-access key:')
  t.input.write('key-one\r')
  setTimeout(() => t.input.write('\n'), 5)
  assert.equal(await first, 'key-one')
  const second = t.p.secret('PostShiba send-only key:', { optional: true })
  setTimeout(() => t.input.write('key-two\r'), 30)
  assert.equal(await second, 'key-two')
  assert.ok(!t.text().includes('key-'))
})

// Runs onboard in a child with a fake terminal, so its Ctrl+C and exit code can be seen.
function child(script: string, env: Record<string, string> = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { PATH: process.env.PATH!, HOME: dir, ...env } })
    let out = ''
    c.stdout.on('data', (d) => (out += d))
    c.stderr.on('data', (d) => (out += d))
    c.on('close', (code) => resolve({ code, out }))
  })
}

const TTY = `
import { PassThrough } from 'node:stream'
import { onboard } from ${JSON.stringify(join(ROOT, 'src', 'onboard.ts'))}
const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {} })
const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 })
output.on('data', (c) => { process.stdout.write(c); if (globalThis.onOut) globalThis.onOut(String(c)) })
`

test('Ctrl+C at a question: a line that says nothing was saved, exit 130', async () => {
  const res = await child(`${TTY}
setTimeout(() => input.write('\\x03'), 200)
await onboard({ input, output, configPath: ${JSON.stringify(path)}, env: { NO_COLOR: '1' } })
`)
  assert.equal(res.code, 130, res.out)
  assert.match(res.out, /Setup stopped\. Nothing was saved\.\n$/)
})

test('Ctrl+C while setup waits for the test reply prints the wait command, exit 130', async () => {
  await withApi(async (_api, apiUrl) => {
    const res = await child(`${TTY}
globalThis.onOut = (s) => { if (s.includes('Waiting for your reply')) setTimeout(() => process.kill(process.pid, 'SIGINT'), 50) }
// PostShiba, domain 1, name, owner, then send the test.
const answers = ['1', '1', '\\r', '${OWNER}\\r', '\\r']
let n = 0
output.on('data', (c) => { if (/Number|Agent name|Your email address|Send the test/.test(String(c)) && n < answers.length) setTimeout(() => input.write(answers[n++].replace(/^(\\d)$/, '$1\\r')), 20) })
await onboard({ input, output, configPath: ${JSON.stringify(path)}, env: { NO_COLOR: '1', TERM: 'dumb', CLANKERINBOX_STATE: ${JSON.stringify(join(dir, 'state'))}, POSTSHIBA_FULL_API_KEY: '${FULL_KEY}', POSTSHIBA_SEND_API_KEY: '${SEND_KEY}', CLANKERINBOX_POSTSHIBA_API: '${apiUrl}' }, mxLookup: async () => [] })
`)
    assert.equal(res.code, 130, res.out)
    assert.match(res.out, /Setup stopped\. The config is saved and the test question was sent\. To wait for the reply: CLANKERINBOX_CONFIG=\S+ clankerinbox wait q[0-9a-z]+\n\(with the same CLANKERINBOX_STATE\)\n$/)
  })
})

function cli(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [BIN, ...args], { env: { PATH: process.env.PATH!, HOME: dir, CLANKERINBOX_CONFIG: path, CLANKERINBOX_STATE: join(dir, 'state'), ...env } })
    let stdout = ''
    let stderr = ''
    c.stdout.on('data', (d) => (stdout += d))
    c.stderr.on('data', (d) => (stderr += d))
    c.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

test('setup without a terminal and without flags says which flags to pass, per provider', async () => {
  const res = await cli(['setup'])
  assert.equal(res.code, 1)
  assert.match(res.stderr, /Interactive setup needs a terminal\. Without one, pass flags:/)
  assert.match(res.stderr, /PostShiba: +setup --team <id> --domain <domain> --allow/)
  assert.match(res.stderr, /The team id is the "id" in\n.*\/api\/v1\/teams/)
  assert.match(res.stderr, /Cloudflare: +setup --provider cloudflare --url <worker url>/)
  assert.equal(JSON.parse(res.stdout).code, 'usage')
})

test('check verifies the send key and that the sending domain may send, with the records it still needs', async () => {
  await withApi(async (api, apiUrl) => {
    await savedSetup(api, apiUrl, { POSTSHIBA_FULL_API_KEY: FULL_KEY, POSTSHIBA_SEND_API_KEY: SEND_KEY })
    const ok = await cli(['check', '--json'])
    assert.equal(ok.code, 0, ok.stdout)
    assert.deepEqual(JSON.parse(ok.stdout).checks.map((c: any) => c.text), [
      `Send key (POSTSHIBA_SEND_API_KEY in ${secretsPath(path)})`, `Read mail from PostShiba (POSTSHIBA_FULL_API_KEY in ${secretsPath(path)})`, 'Mail for inbox.example.com reaches PostShiba', 'PostShiba lets inbox.example.com send',
    ])
    Object.assign(api.domains[0], {
      sending_allowed: false, dkim_status: 'pending', dkim_cname_host: 'ps1._domainkey.inbox.example.com', dkim_cname_target: '42.customers.postshiba.com',
    })
    const bad = await cli(['check', '--json'])
    assert.equal(bad.code, 1)
    const out = JSON.parse(bad.stdout)
    assert.match(out.checks.at(-1).text, /PostShiba lets inbox\.example\.com send: PostShiba has not verified the DNS records of inbox\.example\.com yet \(DKIM pending\)/)
    assert.match(out.advice, /Add these DNS records for inbox\.example\.com:\n {4}Type +Name +Value\n {4}CNAME +ps1\._domainkey\.inbox\.example\.com +42\.customers\.postshiba\.com/)
  })
})

test('setup with flags reaches the PostShiba of CLANKERINBOX_POSTSHIBA_API and keeps it in the config', async () => {
  await withApi(async (_api, apiUrl) => {
    const res = await cli(['setup', '--team', TEAM, '--domain', 'inbox.example.com', '--allow', OWNER, '--json'], { CLANKERINBOX_POSTSHIBA_API: apiUrl, POSTSHIBA_FULL_API_KEY: FULL_KEY })
    assert.equal(res.code, 0, res.stderr)
    assert.equal(loadConfig(path).apiUrl, apiUrl)
  })
})

test('a config and state in the folders of the old name are named once, with the mv command', async () => {
  const old = join(dir, '.config', 'agentmail')
  mkdirSync(old, { recursive: true })
  writeFileSync(join(old, 'config.json'), '{}')
  const res = await new Promise<{ stderr: string }>((resolve) => {
    const c = spawn(process.execPath, [BIN, 'check'], { env: { PATH: process.env.PATH!, HOME: dir } })
    let stderr = ''
    c.stderr.on('data', (d) => (stderr += d))
    c.on('close', () => resolve({ stderr }))
  })
  assert.equal(res.stderr.split('old name agentmail').length, 2, res.stderr)
  assert.match(res.stderr, /clankerinbox uses the config in ~\/\.config\/agentmail, the folder of its old name agentmail \(the state uses the new folder\)\. To move it: mv ~\/\.config\/agentmail ~\/\.config\/clankerinbox/)
  assert.ok(readFileSync(join(old, 'config.json'), 'utf8') === '{}')
})
