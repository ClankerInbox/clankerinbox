// Deploys the mail Worker in cloudflare/ to the Cloudflare account of the user with
// wrangler, the CLI of Cloudflare. Then `clankerinbox setup` can do all the steps: log in,
// make the D1 database, deploy the Worker on a custom domain, set the API token, and send
// the mail of one domain or subdomain to the Worker. You can do each step again: the
// database stays, a deploy replaces the Worker code, and the routing rules stay.

import { spawn } from 'node:child_process'
import { resolveMx } from 'node:dns/promises'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import type { Env } from './provider.ts'

export const WORKER_NAME = 'clankerinbox'
const SOURCE = fileURLToPath(new URL('../cloudflare/', import.meta.url))
export const API_BASE = 'https://api.cloudflare.com/client/v4'

export interface RunResult { code: number; out: string; err: string }
// Runs one wrangler command. `inherit` hands the terminal to wrangler (the login).
export type Wrangler = (args: string[], opts?: { input?: string; inherit?: boolean }) => Promise<RunResult>

// A command line split into words: "double" or 'single' quotes keep spaces in a word, and a
// backslash keeps the next character.
export function splitCommand(line: string): string[] {
  const words: string[] = []
  let word = ''
  let inWord = false
  let quote = ''
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (c === quote) quote = ''
      else if (c === '\\' && quote === '"' && i + 1 < line.length) word += line[++i]
      else word += c
    } else if (c === '"' || c === "'") {
      quote = c
      inWord = true
    } else if (c === '\\' && i + 1 < line.length) {
      word += line[++i]
      inWord = true
    } else if (/\s/.test(c)) {
      if (inWord) words.push(word)
      word = ''
      inWord = false
    } else {
      word += c
      inWord = true
    }
  }
  if (inWord) words.push(word)
  return words
}

// `CLANKERINBOX_WRANGLER` picks another wrangler (a global install, or a fake in tests): a
// path to the program, or a command line in which a path with spaces is quoted. The default
// is npx, which downloads wrangler on first use; `install: false` only uses one that is there.
export function wranglerCommand(env: Env, install = true): string[] {
  const given = env.CLANKERINBOX_WRANGLER?.trim()
  if (given) return existsSync(given) ? [given] : splitCommand(given)
  return ['npx', install ? '--yes' : '--no-install', 'wrangler@4']
}

export function wrangler(cwd: string, env: Env, install = true): Wrangler {
  const cmd = wranglerCommand(env, install)
  return (args, opts = {}) => new Promise((resolve) => {
    const child = spawn(cmd[0], [...cmd.slice(1), ...args], {
      cwd,
      env: { ...process.env, ...env, ...(opts.inherit ? {} : { CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' }) } as NodeJS.ProcessEnv,
      stdio: opts.inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout?.on('data', (d) => { out += d })
    child.stderr?.on('data', (d) => { err += d })
    child.on('error', (e) => resolve({ code: 127, out, err: `${cmd[0]}: ${e.message}` }))
    child.on('close', (code) => resolve({ code: code ?? 1, out, err }))
    if (child.stdin) child.stdin.end(opts.input ?? '')
  })
}

// The login command as a person types it.
export function loginCommand(device: boolean): string {
  return `npx wrangler login${device ? ' --device' : ''}`
}

// Older wranglers have no `login --device`; with it they stop with an error.
export async function supportsDevice(run: Wrangler): Promise<boolean> {
  const r = await run(['login', '--help'])
  return r.code === 0 && /--device\b/.test(r.out + r.err)
}

// What wrangler said about the problem, for an error message: its ✘ [ERROR] block if it
// has one (else the last lines), without the lines about bug reports and log files.
export function tail(r: RunResult, lines = 4): string {
  const lines_ = (t: string) => t.replace(/\x1b\[[0-9;]*m/g, '').split('\n')
  const noise = (l: string) => !l || /If you think this is a bug|Logs were written|^🪵/.test(l)
  const source = [lines_(r.err), lines_(r.out)].find((ls) => ls.some((l) => /\[ERROR\]/.test(l)))
  const all = lines_(r.err + '\n' + r.out)
  if (source) {
    const block: string[] = []
    for (const l of source.slice(source.findIndex((x) => /\[ERROR\]/.test(x))).map((x) => x.trim())) {
      if (block.length && /^(▲|✘|\[)/.test(l) && !/\[ERROR\]/.test(l)) break
      if (!noise(l)) block.push(l.replace(/^✘\s*\[ERROR\]\s*/, '').replace(/^-\s*/, ''))
    }
    return block.join(' ').replace(/\s+/g, ' ').trim()
  }
  const text = all.map((l) => l.trim()).filter((l) => !noise(l) && !/^[▲✘]?\s*\[?(WARNING|wrangler)/i.test(l) && !/^[-─⛅]+/.test(l))
  return text.slice(-lines).join(' ') || `wrangler exited with ${r.code}`
}

export interface Account { id: string; name: string }

export async function whoami(run: Wrangler): Promise<Account[] | null> {
  const r = await run(['whoami', '--json'])
  if (r.code !== 0) return null
  try {
    const j = JSON.parse(r.out.slice(r.out.indexOf('{')))
    return j.loggedIn ? (j.accounts || []).map((a: any) => ({ id: a.id, name: a.name })) : null
  } catch {
    return null
  }
}

export interface Zone { id: string; name: string; status?: string }
export type Api = (method: string, path: string, body?: unknown) => Promise<any>

// The login lacks a permission, or wrangler has no login: running `wrangler login` again helps.
export class PermissionError extends Error {}

// Calls the Cloudflare API with the wrangler login (OAuth token). The token stays in this
// process. The tool does not show it and does not save it.
export function cloudflareApi(run: Wrangler, base = API_BASE): Api {
  let token: string | undefined
  return async (method, path, body) => {
    if (!token) {
      const t = await run(['auth', 'token', '--json'])
      try {
        token = JSON.parse(t.out.slice(t.out.indexOf('{'))).token || undefined
      } catch { /* below */ }
      if (t.code !== 0 || !token) throw new PermissionError(`wrangler has no login token (${tail(t)}). Run \`${loginCommand(false)}\`, then try again`)
    }
    const r = await fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    })
    const j: any = await r.json().catch(() => ({}))
    if (!r.ok || !j.success) {
      throw Object.assign(new Error(`Cloudflare API: ${j.errors?.[0]?.message || r.status}`), { status: r.status, code: j.errors?.[0]?.code })
    }
    return j
  }
}

// `CLANKERINBOX_CLOUDFLARE_API` points the tool at another Cloudflare API (a test server).
export function apiBase(env: Env, given?: string): string {
  return given || env.CLANKERINBOX_CLOUDFLARE_API || API_BASE
}

// A refused API call in words a person can act on: the login lacks a permission.
export function permissionHint(e: any): string | null {
  if (e instanceof PermissionError) return e.message
  if (e?.status === 401 || e?.status === 403) {
    return `${e.message}. The wrangler login does not have this permission. Run \`${loginCommand(false)}\` again and allow every permission it asks for`
  }
  return null
}

// The domains (zones) of the account, also those that are not active yet.
export async function listZones(api: Api, accountId: string): Promise<Zone[]> {
  const zones: Zone[] = []
  for (let page = 1; page <= 50; page++) {
    const j = await api('GET', `/zones?account.id=${encodeURIComponent(accountId)}&per_page=50&page=${page}`)
    zones.push(...j.result.map((z: any) => ({ id: z.id, name: z.name, status: z.status || 'active' })))
    if (page >= (j.result_info?.total_pages || 1)) break
  }
  return zones.sort((a, b) => a.name.localeCompare(b.name))
}

// The zone that holds a domain, across the accounts of the login.
export async function findZone(api: Api, accounts: Account[], domain: string): Promise<{ account: Account; zone: Zone } | null> {
  for (const account of accounts) {
    const zone = (await listZones(api, account.id)).find((z) => domain === z.name || domain.endsWith(`.${z.name}`))
    if (zone) return { account, zone }
  }
  return null
}

// The MX hosts of a name that are not Cloudflare Email Routing. If Email Routing starts
// on this name, Cloudflare replaces these records, and the mail to them stops.
export async function otherMx(name: string, lookup = resolveMx): Promise<string[]> {
  const records = await lookup(name).catch(() => [])
  return records.map((r) => r.exchange.toLowerCase().replace(/\.$/, '')).filter((h) => h && !h.endsWith('.mx.cloudflare.net'))
}

// The mail service behind MX hosts, in words a person knows.
export function mailService(hosts: string[]): string {
  const h = hosts.join(' ')
  if (/google\.com|googlemail\.com/.test(h)) return 'Google Workspace'
  if (/outlook\.com|office365|microsoft/.test(h)) return 'Microsoft 365'
  if (/messagingengine\.com|fastmail/.test(h)) return 'Fastmail'
  if (/proton/.test(h)) return 'Proton Mail'
  return hosts[0] || 'another mail server'
}

// The folder of the Worker, next to the config. Its wrangler.toml has the name of the Worker,
// the database, the custom domain of the Worker (no workers.dev address), and the one address
// that the Worker can send as. Thus a leaked token cannot send as other addresses.
export function writeWorker(dir: string, databaseId: string, sender: string, host: string, name = WORKER_NAME): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  for (const f of ['worker.ts', 'schema.sql']) copyFileSync(join(SOURCE, f), join(dir, f))
  const toml = readFileSync(join(SOURCE, 'wrangler.toml'), 'utf8')
    .replace(/^name = .*$/m, `name = ${JSON.stringify(name)}`)
    .replace(/^(compatibility_date = .*)$/m, `$1\nworkers_dev = false\nroutes = [{ pattern = ${JSON.stringify(host)}, custom_domain = true }]`)
    .replace(/^database_name = .*$/m, `database_name = ${JSON.stringify(name)}`)
    .replace(/^database_id = .*$/m, `database_id = "${databaseId}"`)
    .replace(/^allowed_sender_addresses = .*$/m, `allowed_sender_addresses = [${JSON.stringify(sender)}]`)
    .replace(/^SENDER = .*$/m, `SENDER = ${JSON.stringify(sender)}`)
  writeFileSync(join(dir, 'wrangler.toml'), toml)
}

// The database has the name of the Worker, so a second Worker never reads the mail of the first.
export async function databaseId(run: Wrangler, name = WORKER_NAME): Promise<string | null> {
  const r = await run(['d1', 'list', '--json'])
  if (r.code !== 0) return null
  try {
    const list = JSON.parse(r.out.slice(r.out.indexOf('[')))
    return list.find((d: any) => d.name === name)?.uuid || null
  } catch {
    return null
  }
}

export async function ensureDatabase(run: Wrangler, name = WORKER_NAME): Promise<string> {
  const have = await databaseId(run, name)
  if (have) return have
  const r = await run(['d1', 'create', name])
  const id = r.out.match(/database_id"?\s*[=:]\s*"([0-9a-f-]{36})"/)?.[1] || await databaseId(run, name)
  if (!id) throw new Error(tail(r))
  return id
}

async function must(run: Wrangler, args: string[], input?: string): Promise<RunResult> {
  const r = await run(args, { input })
  if (r.code !== 0) throw new Error(tail(r))
  return r
}

export const applySchema = (run: Wrangler, name = WORKER_NAME) => must(run, ['d1', 'execute', name, '--remote', '--file=schema.sql', '--yes'])

// Deploys the Worker on its custom domain. Wrangler adds the DNS record and the
// certificate. Returns the URL.
export async function deploy(run: Wrangler, host: string): Promise<string> {
  await must(run, ['deploy'])
  return `https://${host}`
}

// A deploy that failed because another Worker or a DNS record holds the host name.
export function hostTaken(message: string): boolean {
  return /already (in use|exists|has)|custom domain.*(exist|in use|conflict)|conflict|record with (that|this) host|\b100117\b/i.test(message)
}

// A new random token, set as the Worker's API_TOKEN secret. Returns it.
export async function setToken(run: Wrangler): Promise<string> {
  const token = randomBytes(32).toString('hex')
  await must(run, ['secret', 'put', 'API_TOKEN'], token)
  return token
}

// Whether a Worker accepts a token: true or false; null when it does not answer.
export async function tokenWorks(url: string, token: string): Promise<boolean | null> {
  try {
    const r = await fetch(`${url}/health`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) })
    if (r.status === 401 || r.status === 403) return false
    return r.ok ? true : null
  } catch {
    return null
  }
}

// A new custom domain needs a certificate. This can take a few minutes.
export async function waitOnline(url: string, token: string, timeoutMs = 300_000): Promise<void> {
  const end = Date.now() + timeoutMs
  for (;;) {
    try {
      const r = await fetch(`${url}/health`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) })
      if (r.ok) return
    } catch { /* The Worker does not answer yet. */ }
    if (Date.now() > end) throw new Error(`no answer after ${timeoutMs / 1000} s`)
    await new Promise((r) => setTimeout(r, 2000))
  }
}

export async function workerExists(api: Api, accountId: string, name: string): Promise<boolean> {
  const j = await api('GET', `/accounts/${accountId}/workers/scripts`)
  return (j.result || []).some((s: any) => s.id === name)
}

// What holds a host name now: another Worker's custom domain or a DNS record. Null when it
// is free, or already the custom domain of `worker`.
export async function hostHolder(api: Api, accountId: string, zone: Zone, host: string, worker: string): Promise<string | null> {
  const domains = (await api('GET', `/accounts/${accountId}/workers/domains?hostname=${encodeURIComponent(host)}`)).result || []
  const owner = domains.find((d: any) => String(d.hostname).toLowerCase() === host)
  if (owner) return owner.service === worker ? null : `the Worker "${owner.service}"`
  // The wrangler login may not read DNS records; then the deploy tells when the name is taken.
  const records = (await api('GET', `/zones/${zone.id}/dns_records?name=${encodeURIComponent(host)}`).catch((e) => {
    if (e?.status === 401 || e?.status === 403) return { result: [] }
    throw e
  })).result || []
  return records.length ? `a DNS record (${records[0].type} ${records[0].content})` : null
}

// Whether `host` is the custom domain of the Worker already (its DNS record and certificate exist).
export async function hostOfWorker(api: Api, accountId: string, host: string, worker: string): Promise<boolean> {
  const domains = (await api('GET', `/accounts/${accountId}/workers/domains?hostname=${encodeURIComponent(host)}`)).result || []
  return domains.some((d: any) => String(d.hostname).toLowerCase() === host && d.service === worker)
}

// Email Routing of the zone now: on for the mail domain (the zone, or one of its subdomains),
// and subaddressing. Null when the login cannot read it.
export async function routingState(api: Api, zone: Zone, mailDomain: string): Promise<{ on: boolean; subaddress: boolean } | null> {
  const r = (await api('GET', `/zones/${zone.id}/email/routing`).catch(() => null))?.result
  if (!r || typeof r !== 'object') return null
  const on = mailDomain === zone.name
    ? r.enabled === true
    : (Array.isArray(r.subdomains) ? r.subdomains : []).some((s: any) => String(s?.name).toLowerCase() === mailDomain && s.enabled !== false)
  return { on, subaddress: r.support_subaddress === true }
}

// Email Sending to all addresses needs the Workers Paid plan. On the free plan, Cloudflare
// refuses the Email Sending API with code 2036, and the Worker can send only to addresses
// that the account verified in Email Routing. Any other refusal is a missing permission of
// the login, not the plan: that throws a PermissionError.
export async function sendingPlan(api: Api, zoneId: string): Promise<'all' | 'free'> {
  try {
    await api('GET', `/zones/${zoneId}/email/sending/subdomains`)
    return 'all'
  } catch (e: any) {
    if (e?.code === 2036 || /workers paid|paid plan|upgrade your plan/i.test(e?.message || '')) return 'free'
    const hint = permissionHint(e)
    if (hint) throw new PermissionError(`Cloudflare did not show Email Sending: ${hint}`)
    throw e
  }
}

// Adds a destination address to Email Routing. Cloudflare sends a mail with a
// verification link to it. Returns true if the address is verified already.
export async function addDestination(api: Api, accountId: string, email: string): Promise<boolean> {
  if (await destinationVerified(api, accountId, email)) return true
  await api('POST', `/accounts/${accountId}/email/routing/addresses`, { email }).catch((e: Error) => {
    if (!/already|exist|duplicate/i.test(e.message)) throw e
  })
  return false
}

export async function destinationVerified(api: Api, accountId: string, email: string): Promise<boolean> {
  for (let page = 1; page <= 20; page++) {
    const j = await api('GET', `/accounts/${accountId}/email/routing/addresses?per_page=50&page=${page}`)
    const hit = (j.result || []).find((a: any) => String(a.email).toLowerCase() === email.toLowerCase())
    if (hit) return !!hit.verified
    if (page >= (j.result_info?.total_pages || 1)) return false
  }
  return false
}

export async function enableSending(run: Wrangler, domain: string): Promise<void> {
  const r = await run(['email', 'sending', 'enable', domain])
  if (r.code !== 0 && !/already/i.test(r.err + r.out)) throw new Error(tail(r))
}

// Starts Email Routing for the mail domain. On a subdomain, only the subdomain gets MX
// records, and the mail of the domain does not change.
export async function startRouting(run: Wrangler, api: Api, zone: Zone, mailDomain: string): Promise<void> {
  if (mailDomain === zone.name) {
    const on = await run(['email', 'routing', 'enable', zone.name, '--zone-id', zone.id])
    if (on.code !== 0 && !/already/i.test(on.err + on.out)) throw new Error(tail(on))
  } else {
    await api('POST', `/zones/${zone.id}/email/routing/dns`, { name: mailDomain }).catch((e: Error) => {
      if (!/already/i.test(e.message)) throw e
    })
  }
}

export interface Rule {
  id: string
  name?: string
  enabled?: boolean
  matchers?: { type: string; field?: string; value?: string }[]
  actions?: { type: string; value?: string[] }[]
}

export async function routingRules(api: Api, zoneId: string): Promise<Rule[]> {
  const rules: Rule[] = []
  for (let page = 1; page <= 20; page++) {
    const j = await api('GET', `/zones/${zoneId}/email/routing/rules?per_page=50&page=${page}`)
    rules.push(...(j.result || []))
    if (page >= (j.result_info?.total_pages || 1)) break
  }
  return rules
}

// The literal rule for one whole address (the rule of agent@ is not the rule of myagent@).
export function ruleFor(rules: Rule[], address: string): Rule | undefined {
  const a = address.toLowerCase()
  return rules.find((r) => (r.matchers || []).some((m) => m.type === 'literal' && (m.field || 'to') === 'to' && String(m.value).toLowerCase() === a))
}

// A rule counts only when it is on and hands the mail to this Worker.
export function sendsToWorker(rule: Rule | undefined, worker: string): boolean {
  return !!rule && rule.enabled !== false && (rule.actions || []).some((a) => a.type === 'worker' && (a.value || []).includes(worker))
}

export function describeRule(rule: Rule): string {
  const action = (rule.actions || [])[0]
  const what = !action ? 'does nothing'
    : action.type === 'forward' ? `forwards the mail to ${(action.value || []).join(', ')}`
      : action.type === 'worker' ? `sends the mail to the Worker "${(action.value || []).join(', ')}"`
        : action.type === 'drop' ? 'drops the mail'
          : `has the action ${action.type}`
  return rule.enabled === false ? `is off (it ${what})` : what
}

// Sends each inbox address to the Worker with a literal rule. The rules stay on the zone.
// A rule of the address that does something else is replaced only when `replace` has the
// address (the person said yes); otherwise this fails and names the rule. Returns the
// addresses that got a new or changed rule.
export async function addRules(run: Wrangler, api: Api, zone: Zone, addresses: string[], worker = WORKER_NAME, replace: Set<string> = new Set()): Promise<string[]> {
  const rules = await routingRules(api, zone.id)
  const made: string[] = []
  const other: string[] = []
  for (const a of addresses) {
    const rule = ruleFor(rules, a)
    if (sendsToWorker(rule, worker)) continue
    if (rule) {
      if (!replace.has(a.toLowerCase())) {
        other.push(`the rule for ${a} ${describeRule(rule)}`)
        continue
      }
      await api('PUT', `/zones/${zone.id}/email/routing/rules/${rule.id}`, {
        name: rule.name || `clankerinbox ${a.split('@')[0]}`, enabled: true, matchers: rule.matchers,
        actions: [{ type: 'worker', value: [worker] }],
      })
    } else {
      await must(run, ['email', 'routing', 'rules', 'create', zone.name, '--zone-id', zone.id, '--name', `clankerinbox ${a.split('@')[0]}`,
        '--match-type', 'literal', '--match-field', 'to', '--match-value', a, '--action-type', 'worker', '--action-value', worker])
    }
    made.push(a)
  }
  if (other.length) throw new Error(`${other.join('; ')}. Setup did not change ${other.length === 1 ? 'it' : 'them'}`)
  return made
}

// Throws unless each address has a rule that is on and sends to the Worker.
export async function checkRules(api: Api, zone: Zone, addresses: string[], worker = WORKER_NAME): Promise<void> {
  const rules = await routingRules(api, zone.id)
  const wrong = addresses.map((a) => {
    const rule = ruleFor(rules, a)
    if (sendsToWorker(rule, worker)) return null
    return rule ? `the rule for ${a} ${describeRule(rule)}` : `${a} has no routing rule`
  }).filter(Boolean)
  if (wrong.length) throw new Error(`${wrong.join('; ')}, so its mail does not reach the Worker "${worker}"`)
}

// Plus addresses (signup+<tag>@) need subaddressing: then they go to the rule of the base
// address. The catch-all cannot do this: it works only on the root domain, and wrangler
// cannot point it to a Worker.
export async function enableSubaddressing(api: Api, zone: Zone): Promise<void> {
  const now = await api('GET', `/zones/${zone.id}/email/routing`).catch(() => null)
  if (now?.result?.support_subaddress) return
  await api('PATCH', `/zones/${zone.id}/email/routing`, { support_subaddress: true })
}
