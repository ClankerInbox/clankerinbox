// A stand-in for wrangler in setup tests: answers like the real CLI and keeps its state
// (logged in, databases, secret, Workers, routing rules) in FAKE_WRANGLER_DIR, where the fake
// Cloudflare API (fake-cloudflare-api.ts) reads the same Workers and rules.
//
// Files a test can put there: `loggedin` (the login is done), `loginfails` (the next login
// fails), `nodevice` (this wrangler has no `login --device`), `deployfail` (the next deploy
// fails with this text), `accounts.json`.
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.env.FAKE_WRANGLER_DIR!
const args = process.argv.slice(2)
const cmd = args.filter((a) => !a.startsWith('-')).slice(0, 4).join(' ')
appendFileSync(join(dir, 'calls.log'), JSON.stringify({ args, account: process.env.CLOUDFLARE_ACCOUNT_ID || null, cwd: process.cwd() }) + '\n')
const has = (f: string) => existsSync(join(dir, f))
const put = (f: string, s: string) => writeFileSync(join(dir, f), s)
const json = (f: string, fallback: any) => (has(f) ? JSON.parse(readFileSync(join(dir, f), 'utf8')) : fallback)
const flag = (name: string) => args[args.indexOf(name) + 1]

if (args[0] === '--version') {
  console.log('4.159.0')
} else if (cmd === 'login' && args.includes('--help')) {
  console.log(`wrangler login\n\nLogin to Cloudflare\n\nOPTIONS\n      --scopes-list  List all the available OAuth scopes  [boolean]\n${has('nodevice') ? '' : '      --device       Log in with a code on another device  [boolean]\n'}`)
} else if (cmd.startsWith('whoami')) {
  if (!has('loggedin')) {
    console.log(JSON.stringify({ loggedIn: false }))
    process.exit(1)
  }
  console.log(JSON.stringify({ loggedIn: true, accounts: json('accounts.json', [{ id: 'acc1', name: 'Test account' }]) }))
} else if (cmd === 'auth token') {
  console.log(JSON.stringify({ type: 'oauth', token: 'fake-oauth-token' }))
} else if (cmd === 'login') {
  if (has('loginfails')) {
    rmSync(join(dir, 'loginfails'))
    console.error('✘ [ERROR] Timed out waiting for authorization code')
    process.exit(1)
  }
  put('loggedin', '1')
} else if (cmd === 'd1 list') {
  console.log(JSON.stringify(Object.entries(json('dbs.json', {})).map(([name, uuid]) => ({ name, uuid }))))
} else if (cmd.startsWith('d1 create ')) {
  const name = cmd.split(' ')[2]
  const dbs = json('dbs.json', {})
  const uuid = `${String(Object.keys(dbs).length + 1).repeat(8)}-2222-3333-4444-555555555555`
  put('dbs.json', JSON.stringify({ ...dbs, [name]: uuid }))
  console.log(`✅ Created\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "${name}"\ndatabase_id = "${uuid}"`)
} else if (cmd.startsWith('d1 execute')) {
  const name = cmd.split(' ')[2]
  const toml = readFileSync('wrangler.toml', 'utf8')
  const uuid = json('dbs.json', {})[name]
  if (!uuid || !toml.includes(`database_id = "${uuid}"`) || !toml.includes(`database_name = "${name}"`)) process.exit(1)
} else if (cmd === 'deploy') {
  if (has('deployfail')) {
    const text = readFileSync(join(dir, 'deployfail'), 'utf8')
    rmSync(join(dir, 'deployfail'))
    console.error(`✘ [ERROR] ${text}`)
    process.exit(1)
  }
  const toml = readFileSync('wrangler.toml', 'utf8')
  const name = /^name = "([^"]+)"/m.exec(toml)![1]
  const host = /pattern = "([^"]+)"/.exec(toml)?.[1]
  put('workers.json', JSON.stringify([...new Set([...json('workers.json', []), name])]))
  if (host) put('domains.json', JSON.stringify([...json('domains.json', []).filter((d: any) => d.hostname !== host), { hostname: host, service: name }]))
  put('deployed.toml', toml)
  console.log(`Uploaded ${name}\nDeployed ${name} triggers (0.5 sec)\n  ${host} (custom domain)`)
} else if (cmd === 'secret put API_TOKEN') {
  put('token', readFileSync(0, 'utf8'))
  console.log('✨ Success! Uploaded secret API_TOKEN')
} else if (cmd.startsWith('email sending enable')) {
  console.log('Enabled')
} else if (cmd.startsWith('email routing enable')) {
  console.log('Enabled')
} else if (cmd.startsWith('email routing rules list')) {
  const rules = json('rules.json', [])
  console.log(rules.length ? rules.map((r: any) => `${r.matchers[0].value} → ${r.actions[0].type} ${r.actions[0].value?.join(',')}`).join('\n') : 'No routing rules found.')
} else if (cmd.startsWith('email routing rules create')) {
  const rules = json('rules.json', [])
  rules.push({
    id: `r${rules.length + 1}`, name: flag('--name'), enabled: true,
    matchers: [{ type: flag('--match-type'), field: flag('--match-field'), value: flag('--match-value') }],
    actions: [{ type: flag('--action-type'), value: [flag('--action-value')] }],
  })
  put('rules.json', JSON.stringify(rules))
} else {
  console.error(`fake wrangler: unknown command ${cmd}`)
  process.exit(1)
}
