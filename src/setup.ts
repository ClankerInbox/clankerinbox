import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import * as cf from './cloudflare-deploy.ts'
import {
  type Config, type Mode, configPath, loadConfig, postshibaApi, saveConfig, backupConfig, looksLikeEnvName,
  DEFAULT_API_URL, DEFAULT_READ_KEY_ENV, DEFAULT_SEND_KEY_ENV,
} from './config.ts'
import { PostShiba, PostShibaError, type Inbox } from './postshiba.ts'
import { ClankerError } from './errors.ts'
import { parseAddresses, hasControlChars } from './safety.ts'
import { PROVIDERS, type ProviderName, type Check } from './provider.ts'
import { DEFAULT_CF_AUTHSERV_ID } from './cloudflare-provider.ts'

export interface SetupInput {
  // Missing means PostShiba, like a config without a provider field.
  provider?: ProviderName
  // The name of the agent: its address is <name>@<domain>, and its inbox in the config
  // has this name. The default is "agent".
  name?: string
  teamId?: string
  domain?: string
  allow: string[]
  from?: string
  apiUrl?: string
  tenant?: string
  configPath?: string
  force?: boolean
  env?: Record<string, string | undefined>
  // Cloudflare: the deployed Worker, the env var with its token, and the server whose
  // Authentication-Results count when it is not Cloudflare's own.
  url?: string
  tokenEnv?: string
  trustedAuthserv?: string[]
  // The name of the Worker on the account, when it is not "clankerinbox".
  worker?: string
}

export interface SetupResult {
  configPath: string
  created: string[]
  reused: string[]
  config: Config
  // Inboxes of the replaced config that stay, and those a new inbox took the name or address of.
  kept?: string[]
  dropped?: string[]
  // Entries of the allow and send lists of the replaced config that stay (added by hand).
  keptEntries?: { inbox: string; allow: string[]; send: string[] }[]
  // Where the replaced config was kept.
  backup?: string | null
}

// Creates (or finds) the two inboxes on a domain and writes the config.
// Needs the full-access key once; day-to-day use needs the send key and the full-access key
// (PostShiba has no key that only reads).
//
// Every flag is checked before anything changes, and every problem is reported in one message.
// With --force the old config is kept as config.json.bak, and inboxes that `create` added to it
// stay, unless they clash with the new ones.
export async function setup(input: SetupInput): Promise<SetupResult> {
  const vars = input.env || process.env
  const path = input.configPath || configPath(vars)
  const provider = input.provider || 'postshiba'
  if (!PROVIDERS.includes(provider)) throw new ClankerError('usage', `--provider must be ${PROVIDERS.join(' or ')}`)
  const problems: string[] = []
  const allow = addressList(input.allow, '--allow', problems)
  if (!input.allow.length) problems.push('--allow needs at least one address (who can answer questions)')
  let name = 'agent'
  try { name = agentName(input.name) } catch (e: any) { problems.push(e.message) }
  const domain = input.domain === undefined || input.domain === '' ? undefined : hostName(input.domain, '--domain', problems)
  if (!input.domain) problems.push(`--domain is required (${provider === 'cloudflare' ? 'the domain that Email Routing sends to the Worker' : 'the domain of the inboxes'})`)
  const from = input.from === undefined ? undefined : fromAddress(input.from, problems)
  let keyName = ''
  if (provider === 'cloudflare') {
    if (!input.url) problems.push('--url is required (the URL of the deployed Worker, e.g. https://clankerinbox.example.com)')
    else if (!/^https:\/\/[^/\s]+/i.test(input.url.trim()) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(input.url.trim())) {
      problems.push(`--url must be an https:// URL, such as https://clankerinbox.example.com`)
    }
    if (input.tokenEnv !== undefined && !looksLikeEnvName(input.tokenEnv.trim())) problems.push(`--token-env needs the name of an env var (UPPER_SNAKE_CASE, for example ${DEFAULT_CF_TOKEN_ENV}). Don't pass the secret itself`)
  } else {
    if (!input.teamId) problems.push('--team is required (the PostShiba team id)')
    keyName = setupKeyName(vars, DEFAULT_READ_KEY_ENV, problems)
    const api = input.apiUrl?.trim() || vars.CLANKERINBOX_POSTSHIBA_API?.trim()
    if (api && !safeApiUrl(api)) problems.push(`${input.apiUrl?.trim() ? '--api-url' : 'CLANKERINBOX_POSTSHIBA_API'} must be an https:// URL (plain http only to this machine), such as ${DEFAULT_API_URL}`)
  }
  // Each problem on its own, so a terminal shows one line for each.
  if (problems.length) throw Object.assign(new ClankerError('usage', problems.join('\n')), { problems })
  if (existsSync(path) && !input.force) throw new ClankerError('usage', `a config already exists at ${path}. Use --force to replace it (the old one is kept as config.json.bak)`)
  const previous = input.force ? readPrevious(path) : null

  if (provider === 'cloudflare') return writeSetup(cloudflareSetup(input, allow, name, domain!, from), path, previous)

  const key = vars[keyName]
  if (!key) throw new ClankerError('config', `no full-access key: set ${keyName}`)
  const apiUrl = postshibaApi({ apiUrl: input.apiUrl?.trim() }, vars)
  const client = new PostShiba(apiUrl)

  const existing = await client.listInboxes(key, input.teamId!).catch((e) => unknownTeam(e, input.teamId!))
  const onDomain = (i: Inbox) => (i.host || i.address.split('@')[1] || '').toLowerCase() === domain
  const localOf = (i: Inbox) => (i.local_part || i.address.split('@')[0]).toLowerCase()
  const created: string[] = []
  const reused: string[] = []

  let askInbox = existing.find((i) => onDomain(i) && localOf(i) === name)
  if (askInbox) reused.push(askInbox.address)
  else {
    askInbox = await client.createInbox(key, input.teamId!, { name: `clankerinbox ${name}`, local_part: name, host: domain! })
    created.push(askInbox.address)
  }
  let signupInbox = existing.find((i) => onDomain(i) && localOf(i) === 'signup')
  if (signupInbox) reused.push(signupInbox.address)
  else {
    signupInbox = await client.createInbox(key, input.teamId!, { name: 'clankerinbox signup', local_part: 'signup', host: domain! })
    created.push(signupInbox.address)
  }

  const config: Config = {
    teamId: input.teamId!,
    from: from || `Clanker Inbox <clankerinbox@${domain}>`,
    domain: domain!,
    // The inbox ids belong to this API, so a config made against another one names it.
    ...(apiUrl !== DEFAULT_API_URL ? { apiUrl } : {}),
    ...(input.tenant ? { tenant: input.tenant } : {}),
    sendKeyEnv: DEFAULT_SEND_KEY_ENV,
    // The full-access key that setup used reads the mail later, under the same name.
    readKeyEnv: keyName,
    caps: { sendPerHour: 30, receivePerSenderPerHour: 20 },
    inboxes: {
      [name]: { id: askInbox.id, address: askInbox.address.toLowerCase(), mode: 'answers', allow, send: allow },
      signup: { id: signupInbox.id, address: signupInbox.address.toLowerCase(), mode: 'codes', allow: '*', send: [] },
    },
  }
  return { ...writeSetup(config, path, previous), created, reused }
}

// The agent name is the local part of its address and the name of its inbox in the config.
export function agentName(value: string | undefined): string {
  const name = (value || 'agent').trim().toLowerCase()
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) throw new ClankerError('usage', `--name must start with a letter and have only letters, digits and "-" (at most 32): ${value}`)
  if (name === 'signup') throw new ClankerError('usage', '--name cannot be "signup": the codes inbox uses that name')
  return name
}

// The config that --force replaces, when it can be read; null for none or a broken one.
function readPrevious(path: string): Config | null {
  try {
    return loadConfig(path)
  } catch {
    return null
  }
}

// Writes the new config after a backup of the old one. Inboxes that `create` added to the old
// config (all but its sign-up inbox and its first answers inbox, which setup makes) are kept when
// the provider is the same and neither their name nor their address is taken by a new inbox.
// An inbox that setup makes again (the same address and mode) keeps the entries that were added
// to its allow and send lists by hand, such as another agent.
function writeSetup(config: Config, path: string, previous: Config | null): SetupResult {
  const kept: string[] = []
  const dropped: string[] = []
  const keptEntries: { inbox: string; allow: string[]; send: string[] }[] = []
  if (previous && (previous.provider || 'postshiba') === (config.provider || 'postshiba')) {
    const more = (now: unknown, before: unknown): string[] => {
      if (!Array.isArray(now) || !Array.isArray(before)) return []
      const have = new Set(now.map((a) => String(a).toLowerCase()))
      return before.filter((a) => typeof a === 'string' && !have.has(a.toLowerCase()))
    }
    for (const [n, inbox] of Object.entries(config.inboxes)) {
      const old = Object.values(previous.inboxes).find((i) => i?.address?.toLowerCase() === inbox.address.toLowerCase() && i.mode === inbox.mode)
      if (!old) continue
      const allow = more(inbox.allow, old.allow)
      const send = more(inbox.send, old.send)
      if (allow.length) inbox.allow = [...(inbox.allow as string[]), ...allow]
      if (send.length) inbox.send = [...inbox.send, ...send]
      if (allow.length || send.length) keptEntries.push({ inbox: n, allow, send })
    }
    const firstAnswers = Object.entries(previous.inboxes).find(([, i]) => i.mode === 'answers')?.[0]
    for (const [n, inbox] of Object.entries(previous.inboxes)) {
      if (n === 'signup' || n === firstAnswers) continue
      const clash = Object.hasOwn(config.inboxes, n) || Object.values(config.inboxes).some((i) => i.address.toLowerCase() === inbox.address.toLowerCase())
      if (clash) dropped.push(n)
      else {
        config.inboxes[n] = inbox
        kept.push(n)
      }
    }
  }
  const backup = backupConfig(path)
  saveConfig(config, path)
  return { configPath: path, created: [], reused: [], config, kept, dropped, ...(keptEntries.length ? { keptEntries } : {}), backup }
}

// Keys travel in every request, so only over TLS (plain http only to this machine).
export function safeApiUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))
  } catch {
    return false
  }
}

// The env var with the full-access key: the one CLANKERINBOX_SETUP_KEY_ENV (or its old name)
// names, else the default.
export function setupKeyName(vars: Record<string, string | undefined>, fallback: string, problems: string[]): string {
  const named = vars.CLANKERINBOX_SETUP_KEY_ENV ? 'CLANKERINBOX_SETUP_KEY_ENV' : vars.AGENTMAIL_SETUP_KEY_ENV ? 'AGENTMAIL_SETUP_KEY_ENV' : null
  if (!named) return fallback
  const value = vars[named]!.trim()
  if (looksLikeEnvName(value)) return value
  problems.push(`${named} needs the name of an env var (UPPER_SNAKE_CASE, for example ${DEFAULT_READ_KEY_ENV}), not the key itself`)
  return fallback
}

function unknownTeam(e: any, teamId: string): never {
  if (e instanceof PostShibaError && e.status === 404) {
    throw new ClankerError('config', `PostShiba has no team ${teamId} for this key. Run \`clankerinbox setup\` in a terminal to pick the right one`, { status: 404 })
  }
  throw e
}

// A list of bare addresses from flags: "Name <a@b.org>" gives a@b.org, case does not matter.
// `star`: "*" may stand alone (only for a codes inbox).
export function addressList(values: string[] | undefined, flag: string, problems: string[], star = false): string[] {
  const out: string[] = []
  for (const raw of values || []) {
    const v = raw.trim()
    if (!v) { problems.push(`${flag} has an empty entry`); continue }
    if (v === '*') {
      if (star) out.push('*')
      else problems.push(`${flag} "*" lets anyone in. Only a codes inbox (--mode codes) may have it`)
      continue
    }
    const one = bareAddress(v)
    if (!one) problems.push(`${flag} "${shown(v)}" is not one email address`)
    else if (!out.includes(one)) out.push(one)
  }
  return out
}

function bareAddress(value: string): string | null {
  const found = parseAddresses(value)
  if (found.length !== 1 || hasControlChars(value)) return null
  const [local, host] = found[0].split('@')
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}$/.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return null
  return validHost(host) ? found[0] : null
}

const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/

function validHost(host: string): boolean {
  return HOST.test(host)
}

// Addresses typed as one line: separated by commas, semicolons or spaces ("Name <a@b.org>"
// stays one entry), then checked like --allow.
export function typedAddresses(text: string, problems: string[]): string[] {
  const parts = text.split(/[,;]+/).flatMap((p) => (p.includes('<') ? [p] : p.split(/\s+/))).map((p) => p.trim()).filter(Boolean)
  if (!parts.length) problems.push('Enter at least one email address.')
  return addressList(parts, 'The address', problems)
}

// A host name from a flag: trimmed and lowercase, without a scheme, a path or a dot at the end.
export function hostName(value: string, flag: string, problems: string[]): string {
  const v = value.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/?#].*$/, '').replace(/\.$/, '')
  if (!validHost(v)) problems.push(`${flag} "${shown(value)}" is not a domain name, such as inbox.example.com`)
  return v
}

// --from: "Name <address>" or a bare address; the address lowercase, the name as written.
function fromAddress(value: string, problems: string[]): string {
  const v = value.trim()
  const address = bareAddress(v)
  if (!address) {
    problems.push(`--from "${shown(value)}" is not one sender, such as "Clanker Inbox <clankerinbox@inbox.example.com>"`)
    return v
  }
  const name = v.includes('<') ? v.slice(0, v.indexOf('<')).trim() : ''
  return name ? `${name} <${address}>` : address
}

// A value the user typed, safe to show in a message.
function shown(v: string): string {
  const s = v.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
  return s.length > 80 ? s.slice(0, 77) + '…' : s
}

export const DEFAULT_CF_TOKEN_ENV = 'CLANKERINBOX_CF_TOKEN'

// Cloudflare: the Worker in cloudflare/ is deployed with wrangler first; Email Routing sends
// the domain's mail to it. The config names its URL and the env var with its token.
function cloudflareSetup(input: SetupInput, allow: string[], name: string, domain: string, from: string | undefined): Config {
  const ask = `${name}@${domain}`
  const signup = `signup@${domain}`
  const trusted = input.trustedAuthserv?.[0]?.trim().toLowerCase()
  return {
    provider: 'cloudflare',
    teamId: '',
    from: from || `Clanker Inbox <clankerinbox@${domain}>`,
    domain,
    cloudflare: {
      url: input.url!.trim().replace(/\/+$/, ''),
      tokenEnv: (input.tokenEnv || DEFAULT_CF_TOKEN_ENV).trim(),
      ...(trusted && trusted !== DEFAULT_CF_AUTHSERV_ID ? { trustedAuthservId: trusted } : {}),
      ...(input.worker && input.worker !== cf.WORKER_NAME ? { worker: input.worker } : {}),
    },
    caps: { sendPerHour: 30, receivePerSenderPerHour: 20 },
    inboxes: {
      [name]: { id: ask, address: ask, mode: 'answers', allow, send: allow },
      signup: { id: signup, address: signup, mode: 'codes', allow: '*', send: [] },
    },
  }
}

export interface AddInboxInput {
  name: string
  // The part before the @. The default is the name.
  localPart?: string
  // The default is answers.
  mode?: Mode
  // The default for answers and requests: the allow list of the first inbox in answers mode.
  allow?: string[]
  send?: string[]
  configPath?: string
  env?: Record<string, string | undefined>
  // Test hook: another Cloudflare API.
  cloudflareApi?: string
}

// Adds one inbox to an existing config, on the domain setup put the inboxes on. On PostShiba
// it creates the inbox when it is not there yet, which needs the full-access key, like setup.
export async function addInbox(input: AddInboxInput): Promise<{ name: string; address: string; created: boolean; config: Config; verify?: string[] }> {
  const vars = input.env || process.env
  const path = input.configPath || configPath(vars)
  const config = loadConfig(path)
  const problems: string[] = []
  const name = input.name.trim()
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) problems.push(`the inbox name "${shown(input.name)}" is not valid: start with a lowercase letter, then letters, digits or "-" (at most 32)`)
  else if (Object.hasOwn(config.inboxes, name)) problems.push(`the inbox ${name} is in the config already`)
  const local = (input.localPart ?? name).trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(local) || local.includes('+')) problems.push(`--local "${shown(input.localPart ?? name)}" is not valid: letters, digits, ".", "_" or "-", no "+"`)
  const mode: Mode = input.mode || 'answers'
  if (!['answers', 'codes', 'requests'].includes(mode)) problems.push('--mode must be answers, codes or requests')
  const given = addressList(input.allow, '--allow', problems, mode === 'codes')
  const star = given.includes('*')
  if (star && given.length > 1) problems.push('--allow "*" lets anyone in; do not add addresses next to it')
  const owners = Object.values(config.inboxes).find((i) => i.mode === 'answers' && Array.isArray(i.allow))?.allow
  let allow = star ? [] : given
  if (!allow.length && !star && mode !== 'codes' && Array.isArray(owners)) allow = [...owners]
  if (mode !== 'codes' && allow.length === 0) problems.push('--allow needs at least one address')
  const send = input.send === undefined ? (mode === 'codes' ? [] : allow) : addressList(input.send, '--send', problems)
  if (input.send !== undefined && !input.send.length) problems.push('--send needs an address')
  const domain = (config.domain || config.from.match(/@([^\s>]+)/)?.[1] || '').toLowerCase()
  if (!domain) problems.push(`no inbox domain found in ${path} (set "domain")`)
  const address = `${local}@${domain}`
  if (domain && Object.values(config.inboxes).some((i) => i.address.toLowerCase() === address)) problems.push(`${address} is in the config already`)
  let keyName = ''
  if (config.provider !== 'cloudflare') keyName = setupKeyName(vars, config.readKeyEnv || DEFAULT_READ_KEY_ENV, problems)
  if (problems.length) throw Object.assign(new ClankerError('usage', problems.join('\n')), { problems })

  const inboxAllow = mode === 'codes' && (star || allow.length === 0) ? '*' as const : allow
  if (config.provider === 'cloudflare') {
    // Email Routing needs a rule that sends the address to the Worker; on the free plan, each
    // address the inbox sends to must be a verified destination address.
    const routed = await routeToWorker(address, send, config, join(dirname(path), 'worker'), vars, input.cloudflareApi)
    config.inboxes[name] = { id: address, address, mode, allow: inboxAllow, send }
    saveConfig(config, path)
    return { name, address, created: routed.created, config, ...(routed.verify.length ? { verify: routed.verify } : {}) }
  }
  const key = vars[keyName]
  if (!key) throw new ClankerError('config', `no full-access key: set ${keyName}`)
  const client = new PostShiba(postshibaApi(config, vars))
  const existing = (await client.listInboxes(key, config.teamId).catch((e) => unknownTeam(e, config.teamId))).find((i) => i.address.toLowerCase() === address)
  const inbox = existing || await client.createInbox(key, config.teamId, { name: `clankerinbox ${name}`, local_part: local, host: domain })
  config.inboxes[name] = { id: inbox.id, address, mode, allow: inboxAllow, send }
  saveConfig(config, path)
  return { name, address, created: !existing, config }
}

// The wrangler login of this machine and the zone of a domain on it. A missing login or a
// refused permission says what to run.
async function cloudflareAccess(domain: string, dir: string, env: Record<string, string | undefined>, apiBase?: string, install = true) {
  const runEnv = { ...env }
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const run: cf.Wrangler = (args, o) => cf.wrangler(dir, runEnv, install)(args, o)
  const accounts = await cf.whoami(run)
  if (!accounts) return null
  const api = cf.cloudflareApi(run, cf.apiBase(env, apiBase))
  const found = await cf.findZone(api, accounts, domain).catch(authHint)
  if (!found) throw new ClankerError('config', `the domain ${domain} is not on the Cloudflare accounts of your wrangler login`)
  runEnv.CLOUDFLARE_ACCOUNT_ID = found.account.id
  return { run, api, ...found }
}

function authHint(e: any): never {
  const hint = cf.permissionHint(e)
  if (hint) throw new ClankerError('auth', hint)
  throw e
}

// Adds the Email Routing rule for one address with the wrangler login, and on the free plan
// the destination addresses it sends to (Cloudflare mails each a link to click). Returns
// whether the rule is new and the addresses that still wait for the click.
async function routeToWorker(address: string, send: string[], config: Config, dir: string, env: Record<string, string | undefined>, apiBase?: string) {
  const access = await cloudflareAccess(address.split('@')[1], dir, env, apiBase)
  if (!access) throw new ClankerError('auth', `wrangler is not logged in to Cloudflare. Run \`${cf.loginCommand(false)}\`, then run this command again`)
  const { run, api, account, zone } = access
  const worker = config.cloudflare?.worker || cf.WORKER_NAME
  const made = await cf.addRules(run, api, zone, [address], worker).catch((e) => {
    if (cf.permissionHint(e)) authHint(e)
    throw new ClankerError('refused', `${e.message}. Change or delete that rule at https://dash.cloudflare.com/${account.id}/${zone.name}/email/routing/routes, then run create again`)
  })
  const verify: string[] = []
  if (send.length && (await cf.sendingPlan(api, zone.id).catch(authHint)) === 'free') {
    for (const to of send) if (!(await cf.addDestination(api, account.id, to).catch(authHint))) verify.push(to)
  }
  return { created: made.length > 0, verify }
}

// `check` on Cloudflare: each inbox address has a routing rule that is on and sends to the
// Worker. It needs the wrangler login of this machine; without one it is skipped and says so.
// Wrangler is run only when CLANKERINBOX_WRANGLER names one or setup deployed from this
// machine, so a check never downloads it.
export function routingCheck(config: Config, configPath: string, env: Record<string, string | undefined>, apiBase?: string): Check {
  const addresses = Object.values(config.inboxes).map((i) => i.address)
  const worker = config.cloudflare?.worker || cf.WORKER_NAME
  const dir = join(dirname(configPath), 'worker')
  return {
    label: `Routing rules send ${addresses.join(' and ')} to the Worker "${worker}"`,
    run: async () => {
      const skipped = { warn: `not checked: no wrangler login on this machine (to check them, run \`${cf.loginCommand(false)}\` and check again)` }
      // Without the deploy folder, check does not know whether wrangler is here, and does not
      // download it to find out: it says how to name a wrangler instead of claiming no login.
      if (!env.CLANKERINBOX_WRANGLER && !existsSync(dir)) return { warn: 'not checked: the Worker was not deployed from this machine, so check does not run wrangler (to check them with your wrangler login, run the check with CLANKERINBOX_WRANGLER="npx wrangler")' }
      const domain = (config.domain || addresses[0]?.split('@')[1] || '').toLowerCase()
      const access = await cloudflareAccess(domain, dir, env, apiBase, false)
      if (!access) return skipped
      await cf.checkRules(access.api, access.zone, addresses, worker).catch((e) => (cf.permissionHint(e) ? authHint(e) : Promise.reject(e)))
    },
  }
}
