import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../src/config.ts'
import { createProvider } from '../src/provider.ts'
import { setup, addInbox } from '../src/setup.ts'
import { fakeCloudflareApi } from './fake-cloudflare-api.ts'
import { splitCommand, wranglerCommand } from '../src/cloudflare-deploy.ts'

const BIN = join(import.meta.dirname, '..', 'bin', 'clankerinbox.ts')
const OWNER = 'owner@example.org'
// Values that must never reach the config or the output.
const SECRET_ENV = { CLANKERINBOX_CF_TOKEN: 'cf-worker-token-456' }
const SECRETS = /cf-worker-token-456/

let dir: string
let path: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'clankerinbox-setup-'))
  path = join(dir, 'config.json')
})

function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string; json: any }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args, '--json'], {
      env: { PATH: process.env.PATH!, HOME: dir, CLANKERINBOX_CONFIG: path, CLANKERINBOX_STATE: join(dir, 'state'), ...SECRET_ENV },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => (stdout += c))
    child.stderr.on('data', (c) => (stderr += c))
    child.on('close', (code) => {
      let json: any = null
      try { json = JSON.parse(stdout) } catch {}
      resolve({ code: code ?? 1, stdout, stderr, json })
    })
  })
}

test('setup --provider cloudflare writes the Worker url and token env var name, never the token', async () => {
  const r = await run(['setup', '--provider', 'cloudflare', '--url', 'https://clankerinbox.acme.workers.dev/', '--domain', 'Agents.Example.org', '--allow', OWNER])
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.json.secretEnv, 'CLANKERINBOX_CF_TOKEN')
  assert.doesNotMatch(r.stdout + r.stderr + readFileSync(path, 'utf8'), SECRETS)
  const config = loadConfig(path)
  assert.equal(config.provider, 'cloudflare')
  assert.deepEqual(config.cloudflare, { url: 'https://clankerinbox.acme.workers.dev', tokenEnv: 'CLANKERINBOX_CF_TOKEN' })
  assert.equal(config.inboxes.agent.address, 'agent@agents.example.org')
  assert.equal(config.inboxes.agent.id, config.inboxes.agent.address)
  assert.deepEqual(config.inboxes.signup, { id: 'signup@agents.example.org', address: 'signup@agents.example.org', mode: 'codes', allow: '*', send: [] })
  assert.equal(config.from, 'Clanker Inbox <clankerinbox@agents.example.org>')
  assert.equal(createProvider(config, {}).name, 'cloudflare')
})

test('setup --provider cloudflare refuses plain http, a missing url, and a token in place of an env var name', async () => {
  const http = await run(['setup', '--provider', 'cloudflare', '--url', 'http://worker.example.org', '--domain', 'example.org', '--allow', OWNER])
  assert.equal(http.code, 1)
  assert.match(http.stderr, /https/)
  const noUrl = await run(['setup', '--provider', 'cloudflare', '--domain', 'example.org', '--allow', OWNER])
  assert.match(noUrl.stderr, /--url/)
  const tok = await run(['setup', '--provider', 'cloudflare', '--url', 'https://w.example.org', '--domain', 'example.org', '--allow', OWNER, '--token-env', 'abc-def.123'])
  assert.equal(tok.code, 1)
  assert.match(tok.stderr, /name of an env var/)
})

test('setup refuses an unknown provider and an existing config without --force', async () => {
  for (const name of ['smtp2go', 'imap']) {
    const bad = await run(['setup', '--provider', name, '--allow', OWNER])
    assert.equal(bad.code, 1)
    assert.match(bad.stderr, /--provider must be postshiba or cloudflare/)
  }
  writeFileSync(path, '{}')
  const cloudflare = ['setup', '--provider', 'cloudflare', '--url', 'https://w.example.org', '--domain', 'example.org', '--allow', OWNER]
  const exists = await run(cloudflare)
  assert.match(exists.stderr, /--force/)
  const forced = await run([...cloudflare, '--force'])
  assert.equal(forced.code, 0, forced.stderr)
})

test('setup --provider postshiba needs a team, like a setup without --provider', async () => {
  const r = await run(['setup', '--provider', 'postshiba', '--domain', 'example.org', '--allow', OWNER])
  assert.equal(r.code, 1)
  assert.match(r.stderr, /--team is required/)
})

test('create on Cloudflare adds the Email Routing rule with the wrangler login', async () => {
  const fake = mkdtempSync(join(tmpdir(), 'clankerinbox-wrangler-'))
  writeFileSync(join(fake, 'loggedin'), '1')
  const env = { CLANKERINBOX_WRANGLER: `${process.execPath} ${join(import.meta.dirname, 'fake-wrangler.ts')}`, FAKE_WRANGLER_DIR: fake }
  const api = await fakeCloudflareApi([], { dir: fake })
  const rules = () => JSON.parse(readFileSync(join(fake, 'rules.json'), 'utf8'))
  try {
    await setup({ provider: 'cloudflare', url: 'https://w.example.com', domain: 'mail.example.com', allow: [OWNER], configPath: path })
    // The defaults: the name is the local part, the mode is answers, the allow list is the one of the first agent.
    const cf = await addInbox({ name: 'billing', configPath: path, env, cloudflareApi: api.url })
    assert.equal(cf.address, 'billing@mail.example.com')
    assert.equal(cf.created, true)
    assert.equal(cf.verify, undefined)
    assert.deepEqual(loadConfig(path).inboxes.billing, { id: 'billing@mail.example.com', address: 'billing@mail.example.com', mode: 'answers', allow: [OWNER], send: [OWNER] })
    assert.deepEqual(rules().map((r: any) => [r.matchers[0].value, r.actions[0]]), [['billing@mail.example.com', { type: 'worker', value: ['clankerinbox'] }]])
    const create = readFileSync(join(fake, 'calls.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((c) => c.args[3] === 'create')
    assert.deepEqual(create.args.slice(4, 7), ['example.com', '--zone-id', 'z1'])
    assert.equal(create.account, 'acc1')
    // The rule of billing@ exists: a second address that ends the same gets its own rule.
    const again = await addInbox({ name: 'my-billing', localPart: 'mybilling', configPath: path, env, cloudflareApi: api.url })
    assert.equal(again.created, true)
    // A domain that is not on the account changes nothing.
    writeFileSync(path, readFileSync(path, 'utf8').replace(/mail\.example\.com/g, 'mail.other.org'))
    await assert.rejects(addInbox({ name: 'x', configPath: path, env, cloudflareApi: api.url }), /the domain mail\.other\.org is not on the Cloudflare accounts/)
    assert.ok(!loadConfig(path).inboxes.x)
  } finally {
    api.server.close()
  }
})

test('create on Cloudflare: a rule that forwards the address elsewhere is left alone; a login problem names the command', async () => {
  const fake = mkdtempSync(join(tmpdir(), 'clankerinbox-wrangler-'))
  const env = { CLANKERINBOX_WRANGLER: `${process.execPath} ${join(import.meta.dirname, 'fake-wrangler.ts')}`, FAKE_WRANGLER_DIR: fake }
  const api = await fakeCloudflareApi([], { dir: fake })
  try {
    await setup({ provider: 'cloudflare', url: 'https://w.example.com', domain: 'mail.example.com', allow: [OWNER], configPath: path })
    await assert.rejects(addInbox({ name: 'billing', configPath: path, env, cloudflareApi: api.url }), (e: any) => {
      assert.equal(e.kind, 'auth')
      assert.match(e.message, /wrangler is not logged in to Cloudflare\. Run `npx wrangler login`/)
      return true
    })
    writeFileSync(join(fake, 'loggedin'), '1')
    writeFileSync(join(fake, 'rules.json'), JSON.stringify([
      { id: 'r9', enabled: true, matchers: [{ type: 'literal', field: 'to', value: 'billing@mail.example.com' }], actions: [{ type: 'forward', value: ['me@gmail.example'] }] },
    ]))
    await assert.rejects(addInbox({ name: 'billing', configPath: path, env, cloudflareApi: api.url }),
      /the rule for billing@mail\.example\.com forwards the mail to me@gmail\.example\. Setup did not change it\. Change or delete that rule at https:\/\/dash\.cloudflare\.com\/acc1\/example\.com\/email\/routing\/routes/)
    assert.ok(!loadConfig(path).inboxes.billing)
    // A refused API call is a missing permission of the login, with the command that fixes it.
    const refusing = await fakeCloudflareApi([], { dir: fake, sendingError: { status: 403, code: 10000, message: 'Authentication error' } })
    try {
      await assert.rejects(addInbox({ name: 'ops', configPath: path, env, cloudflareApi: refusing.url }), /Authentication error\. The wrangler login does not have this permission\. Run `npx wrangler login` again/)
    } finally {
      refusing.server.close()
    }
  } finally {
    api.server.close()
  }
})

test('create on Cloudflare, free plan: each address the inbox sends to becomes a destination address to verify', async () => {
  const fake = mkdtempSync(join(tmpdir(), 'clankerinbox-wrangler-'))
  writeFileSync(join(fake, 'loggedin'), '1')
  const calls: any[] = []
  const api = await fakeCloudflareApi(calls, { dir: fake, free: true })
  try {
    await setup({ provider: 'cloudflare', url: 'https://w.example.com', domain: 'mail.example.com', allow: [OWNER], configPath: path })
    // Through the binary: CLANKERINBOX_CLOUDFLARE_API points it at the fake API.
    const r = await new Promise<{ code: number; stdout: string }>((resolve) => {
      const child = spawn(process.execPath, [BIN, 'create', 'billing', '--send', 'boss@example.org', '--json'], {
        env: {
          PATH: process.env.PATH!, HOME: dir, CLANKERINBOX_CONFIG: path, CLANKERINBOX_STATE: join(dir, 'state'),
          CLANKERINBOX_WRANGLER: `${process.execPath} ${join(import.meta.dirname, 'fake-wrangler.ts')}`, FAKE_WRANGLER_DIR: fake,
          CLANKERINBOX_CLOUDFLARE_API: api.url,
        },
      })
      let stdout = ''
      child.stdout.on('data', (c) => (stdout += c))
      child.on('close', (code) => resolve({ code: code ?? 1, stdout }))
    })
    assert.equal(r.code, 0, r.stdout)
    const out = JSON.parse(r.stdout)
    assert.deepEqual(out.verify, ['boss@example.org'])
    assert.deepEqual(calls.filter((c) => c.method === 'POST' && c.url === '/accounts/acc1/email/routing/addresses').map((c) => c.body), [{ email: 'boss@example.org' }])
    // The folder of the config is only for its owner.
    assert.equal(statSync(join(dir, 'worker')).mode & 0o077, 0)
  } finally {
    api.server.close()
  }
})

test('CLANKERINBOX_WRANGLER may be a path with spaces, as it is or in quotes', () => {
  assert.deepEqual(splitCommand('"/opt/my tools/wrangler" --x'), ['/opt/my tools/wrangler', '--x'])
  assert.deepEqual(splitCommand("node '/a b/w.js'"), ['node', '/a b/w.js'])
  assert.deepEqual(splitCommand('/a\\ b/wrangler'), ['/a b/wrangler'])
  const spaced = join(mkdtempSync(join(tmpdir(), 'clankerinbox wr ')), 'my wrangler')
  writeFileSync(spaced, '')
  assert.deepEqual(wranglerCommand({ CLANKERINBOX_WRANGLER: spaced }), [spaced])
  assert.deepEqual(wranglerCommand({}), ['npx', '--yes', 'wrangler@4'])
  assert.deepEqual(wranglerCommand({}, false), ['npx', '--no-install', 'wrangler@4'])
})

test('setup --name gives the agent its address and its inbox name; "signup" is not a name', async () => {
  const r = await setup({ provider: 'cloudflare', url: 'https://w.example.org', domain: 'example.org', allow: [OWNER], configPath: path, name: 'Billing' })
  assert.deepEqual(Object.keys(r.config.inboxes), ['billing', 'signup'])
  assert.equal(r.config.inboxes.billing.address, 'billing@example.org')
  await assert.rejects(setup({ provider: 'cloudflare', url: 'https://w.example.org', domain: 'example.org', allow: [OWNER], configPath: path, force: true, name: 'signup' }), /--name cannot be "signup"/)
  await assert.rejects(setup({ provider: 'cloudflare', url: 'https://w.example.org', domain: 'example.org', allow: [OWNER], configPath: path, force: true, name: 'a b' }), /--name must start with a letter/)
})

test('create is in the help; inbox-add still works as its old name', async () => {
  const help = await run(['--help'])
  assert.match(help.stdout, /create\s+Add another inbox/)
  assert.ok(!help.stdout.includes('inbox-add'))
  const old = await run(['inbox-add'])
  assert.equal(old.code, 1)
  assert.match(old.stderr, /Missing the inbox name, e\.g\. create billing/)
})

test('setup --help lists the providers and their setup options', async () => {
  const r = await run(['setup', '--help'])
  assert.equal(r.code, 0)
  for (const s of ['--provider postshiba', '--provider cloudflare', '--trusted-authserv', '--token-env']) {
    assert.ok(r.stdout.includes(s), s)
  }
  assert.doesNotMatch(r.stdout, /imap|smtp/i)
})

test('setup flags: addresses and domains are normalized; every problem is named at once', async () => {
  const r = await run(['setup', '--url', 'https://w.example.org', '--domain', ' Agents.Example.ORG. ', '--allow', 'Owner <Owner@Example.org>', '--from', 'Bot <Bot@Agents.Example.org>'])
  assert.equal(r.code, 0, r.stderr)
  const config = loadConfig(path)
  assert.equal(config.provider, 'cloudflare', '--url implies cloudflare')
  assert.equal(config.domain, 'agents.example.org')
  assert.deepEqual(config.inboxes.agent.allow, [OWNER])
  assert.equal(config.inboxes.agent.address, 'agent@agents.example.org')
  assert.equal(config.from, 'Bot <bot@agents.example.org>')

  const bad = await run(['setup', '--force', '--url', 'https://w.example.org', '--domain', 'not a domain', '--allow', 'me@example.org; you@example.org', '--allow', '', '--from', 'nobody'])
  assert.equal(bad.code, 1)
  assert.equal(bad.json.code, 'usage')
  for (const s of ['--allow "me@example.org; you@example.org" is not one email address', '--allow has an empty entry', '--domain "not a domain" is not a domain name', '--from "nobody" is not one sender']) {
    assert.ok(bad.json.message.includes(s), s)
  }
  const missing = await run(['setup', '--provider', 'postshiba'])
  for (const s of ['--allow needs', '--domain is required', '--team is required']) assert.ok(missing.json.message.includes(s), s)

  const mixed = await run(['setup', '--provider', 'postshiba', '--team', 'T', '--url', 'https://w.example.org', '--domain', 'example.org', '--allow', OWNER])
  assert.match(mixed.stderr, /--url is an option of --provider cloudflare, not postshiba/)
  const mixed2 = await run(['setup', '--url', 'https://w.example.org', '--team', 'T', '--domain', 'example.org', '--allow', OWNER])
  assert.match(mixed2.stderr, /--team is an option of --provider postshiba, not cloudflare/)
  const http = await run(['setup', '--url', 'http://w.example.org', '--domain', 'example.org', '--allow', OWNER])
  assert.match(http.stderr, /--url must be an https:\/\/ URL/)
})

test('a key where an env var name belongs is refused and never printed', async () => {
  const hex = 'a3f9c2e1b7d4058f6e2c9a1b3d5f7e9c0a2b4d6f8e1c3a5b7d9f0e2c4a6b8d0f'
  for (const value of [hex, hex.toUpperCase(), 'ABCD1234EFGH5678IJKL_X', 'my_token']) {
    const r = await run(['setup', '--url', 'https://w.example.org', '--domain', 'example.org', '--allow', OWNER, '--token-env', value])
    assert.equal(r.code, 1, value)
    assert.match(r.stderr, /name of an env var/)
    assert.equal((r.stdout + r.stderr).includes(value), false, value)
  }
  await assert.rejects(setup({ teamId: 'T', domain: 'example.org', allow: [OWNER], configPath: path, env: { CLANKERINBOX_SETUP_KEY_ENV: hex, [hex]: 'x' } }), (e: any) => {
    assert.match(e.message, /CLANKERINBOX_SETUP_KEY_ENV needs the name of an env var/)
    assert.equal(e.message.includes(hex), false)
    return true
  })
  const ok = await run(['setup', '--url', 'https://w.example.org', '--domain', 'example.org', '--allow', OWNER, '--token-env', 'MY_WORKER_TOKEN'])
  assert.equal(ok.code, 0, ok.stderr)
})

test('setup --force keeps the old config as .bak, an older .bak with a time, and the inboxes create added', async () => {
  const fake = mkdtempSync(join(tmpdir(), 'clankerinbox-wrangler-'))
  writeFileSync(join(fake, 'loggedin'), '1')
  const env = { CLANKERINBOX_WRANGLER: `${process.execPath} ${join(import.meta.dirname, 'fake-wrangler.ts')}`, FAKE_WRANGLER_DIR: fake }
  const api = await fakeCloudflareApi([])
  try {
    await setup({ provider: 'cloudflare', url: 'https://w.example.com', domain: 'mail.example.com', allow: [OWNER], configPath: path, from: 'Bot <bot@other.example.com>' })
    // create puts the address on the domain of setup, not on the domain of --from.
    const billing = await addInbox({ name: 'billing', configPath: path, env, cloudflareApi: api.url })
    assert.equal(billing.address, 'billing@mail.example.com')
    await addInbox({ name: 'codes2', mode: 'codes', allow: ['*'], configPath: path, env, cloudflareApi: api.url })
    await assert.rejects(addInbox({ name: 'open', allow: ['*'], configPath: path, env, cloudflareApi: api.url }), /Only a codes inbox/)
    await assert.rejects(addInbox({ name: 'empty', send: [''], configPath: path, env, cloudflareApi: api.url }), /--send has an empty entry/)
    await assert.rejects(addInbox({ name: 'named', allow: ['Owner <owner@example.org>', 'x y'], configPath: path, env, cloudflareApi: api.url }), /--allow "x y" is not one email address/)
    // A hand edit: another agent on the lists of the sign-up inbox's neighbour, the first agent.
    const edited = loadConfig(path)
    const firstAgent = Object.keys(edited.inboxes)[0]
    edited.inboxes[firstAgent].send.push('agent@peer.example')
    ;(edited.inboxes[firstAgent].allow as string[]).push('clankerinbox@peer.example')
    writeFileSync(path, JSON.stringify(edited))
    const first = readFileSync(path, 'utf8')

    // The same agent again keeps the entries added by hand.
    const same = await run(['setup', '--force', '--url', 'https://w.example.com', '--domain', 'mail.example.com', '--allow', OWNER, '--name', firstAgent])
    assert.equal(same.code, 0, same.stderr)
    assert.deepEqual(same.json.keptEntries, [{ inbox: firstAgent, allow: ['clankerinbox@peer.example'], send: ['agent@peer.example'] }])
    assert.deepEqual(loadConfig(path).inboxes[firstAgent].send, [OWNER, 'agent@peer.example'])
    writeFileSync(path, first)

    const again = await run(['setup', '--force', '--url', 'https://w.example.com', '--domain', 'mail.example.com', '--allow', OWNER, '--name', 'bot'])
    assert.equal(again.code, 0, again.stderr)
    assert.equal(readFileSync(path + '.bak', 'utf8'), first)
    assert.deepEqual(again.json.kept, ['billing', 'codes2'])
    assert.equal(again.json.keptEntries, undefined)
    assert.deepEqual(Object.keys(loadConfig(path).inboxes), ['bot', 'signup', 'billing', 'codes2'])
    const second = readFileSync(path, 'utf8')

    await run(['setup', '--force', '--url', 'https://w.example.com', '--domain', 'mail.example.com', '--allow', OWNER, '--name', 'billing'])
    assert.equal(readFileSync(path + '.bak', 'utf8'), second)
    const older = readdirSync(dir).filter((n) => n.startsWith('config.json.bak-'))
    assert.equal(older.length, 1)
    assert.equal(readFileSync(join(dir, older[0]), 'utf8'), first)
    // The new agent took the name billing, so the old billing inbox is dropped.
    assert.equal(loadConfig(path).inboxes.billing.mode, 'answers')
  } finally {
    api.server.close()
  }
})

test('setup with flags reads the full-access key from config.secrets.json', async () => {
  writeFileSync(join(dir, 'config.secrets.json'), JSON.stringify({ POSTSHIBA_FULL_API_KEY: 'from-the-file' }))
  const r = await run(['setup', '--team', 'T1', '--domain', 'example.org', '--allow', OWNER, '--api-url', 'http://127.0.0.1:9/api/v1'])
  // The key was found: the command got as far as the network, not "no full-access key".
  assert.doesNotMatch(r.stderr, /no full-access key/)
  assert.match(r.stderr, /cannot reach http:\/\/127\.0\.0\.1:9/)
  assert.equal(r.code, 3)
})
