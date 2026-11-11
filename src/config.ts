import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, rmSync, copyFileSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { PROVIDERS, type ProviderName } from './provider.ts'
import type { CloudflareConfig } from './cloudflare-provider.ts'
import { ClankerError } from './errors.ts'

// answers: replies to questions an agent asked. codes: sign-up codes and links from anyone.
// requests: new work from the owner, handed to the caller whole; only allowlisted senders.
export type Mode = 'answers' | 'codes' | 'requests'

export interface InboxConfig {
  id: string
  address: string
  mode: Mode
  // Who may write to this inbox. "*" lets any sender in; an empty list lets nobody in.
  allow: string[] | '*'
  // Who this inbox may send to. Mail to the machine's own inboxes is always allowed.
  send: string[]
  // Accept all automated mail from allowlisted senders (auto-replies and list mail too), and mail
  // this machine sent itself. Off by default; only for tests where the tool answers its own
  // question. Another agent's mail needs no switch.
  allowAutomated?: boolean
}

export interface Config {
  // Which mail service carries the mail; a config without one is PostShiba.
  provider?: ProviderName
  // PostShiba only: the team that owns the inboxes.
  teamId: string
  from: string
  apiUrl?: string
  tenant?: string
  // Names of the env vars that hold the keys; the keys themselves never live in the config.
  sendKeyEnv?: string
  readKeyEnv?: string
  setupKeyEnv?: string
  // Cloudflare only: the deployed Worker. Its token comes from the named env var.
  cloudflare?: CloudflareConfig
  // maxBodyBytes: the largest text a send takes (default 1 MB).
  caps?: { sendPerHour?: number; receivePerSenderPerHour?: number; maxBodyBytes?: number }
  // The domain setup put the inboxes on; `create` adds new addresses there.
  domain?: string
  retentionHours?: number
  inboxes: Record<string, InboxConfig>
}

export const DEFAULT_API_URL = 'https://app.postshiba.com/api/v1'

// The PostShiba API: the config's apiUrl, else CLANKERINBOX_POSTSHIBA_API (another PostShiba,
// such as a test server), else the real one.
export function postshibaApi(config: { apiUrl?: string } | undefined, env: Record<string, string | undefined>): string {
  return config?.apiUrl || env.CLANKERINBOX_POSTSHIBA_API?.trim() || DEFAULT_API_URL
}
export const DEFAULT_SEND_KEY_ENV = 'POSTSHIBA_SEND_API_KEY'
export const DEFAULT_READ_KEY_ENV = 'POSTSHIBA_FULL_API_KEY'

// The env var names the tool knows; any other name must look like one, so a key pasted where
// its name belongs is refused before it lands in the config or in a message.
const KNOWN_ENV_NAMES = [DEFAULT_SEND_KEY_ENV, DEFAULT_READ_KEY_ENV, 'CLANKERINBOX_CF_TOKEN']

// UPPER_SNAKE_CASE with a letter and an underscore, at most 64 characters, and nothing that
// looks like a hex or base64 secret (a long run of letters mixed with digits).
export function looksLikeEnvName(value: string): boolean {
  if (KNOWN_ENV_NAMES.includes(value)) return true
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(value) || !value.includes('_')) return false
  if (/^[A-F0-9_]+$/.test(value) && value.replace(/_/g, '').length >= 16) return false
  return !value.split('_').some((part) => part.length >= 16 && /\d/.test(part) && /[A-Z]/.test(part))
}

// The tool was called agentmail before. Machines set up under that name keep
// their config and state where they are: the old env vars and paths are still
// read, and the new path wins once it exists.
export function configPath(env = process.env): string {
  const set = env.CLANKERINBOX_CONFIG || env.AGENTMAIL_CONFIG
  if (set) return set
  return currentOrLegacy(join(homedir(), '.config', 'clankerinbox', 'config.json'), join(homedir(), '.config', 'agentmail', 'config.json'))
}

export function stateDir(env = process.env): string {
  const set = env.CLANKERINBOX_STATE || env.AGENTMAIL_STATE
  if (set) return set
  return currentOrLegacy(join(homedir(), '.local', 'state', 'clankerinbox'), join(homedir(), '.local', 'state', 'agentmail'))
}

function currentOrLegacy(current: string, legacy: string): string {
  return !existsSync(current) && existsSync(legacy) ? legacy : current
}

// When the config or the state still lives in a folder of the old name (agentmail), a line that
// says so and how to move it; null when both use the new folders or a path is set by env var.
// The config and the state fall back each on their own, so one can be new and the other old.
export function legacyNotice(vars: Record<string, string | undefined> = process.env): string | null {
  const home = homedir()
  const short = (p: string) => (p.startsWith(home + '/') ? '~' + p.slice(home.length) : p)
  const pairs: [string, string, string][] = []
  if (!vars.CLANKERINBOX_CONFIG && !vars.AGENTMAIL_CONFIG) {
    const legacy = join(home, '.config', 'agentmail')
    if (dirname(configPath(vars)) === legacy) pairs.push(['config', legacy, join(home, '.config', 'clankerinbox')])
  }
  if (!vars.CLANKERINBOX_STATE && !vars.AGENTMAIL_STATE) {
    const legacy = join(home, '.local', 'state', 'agentmail')
    if (stateDir(vars) === legacy) pairs.push(['state', legacy, join(home, '.local', 'state', 'clankerinbox')])
  }
  if (!pairs.length) return null
  const what = pairs.map(([w, from]) => `the ${w} in ${short(from)}`).join(' and ')
  const split = pairs.length === 1 ? ` (the ${pairs[0][0] === 'config' ? 'state' : 'config'} uses the new folder)` : ''
  const mv = pairs.map(([, from, to]) => `mv ${short(from)} ${short(to)}`).join(' && ')
  return `clankerinbox uses ${what}, the folder${pairs.length > 1 ? 's' : ''} of its old name agentmail${split}. To move ${pairs.length > 1 ? 'them' : 'it'}: ${mv}`
}

export function loadConfig(path = configPath()): Config {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (e: any) {
    if (e?.code === 'EISDIR') throw new ClankerError('config', `${path} is a folder, not a config file. Set CLANKERINBOX_CONFIG to the config file itself (config.json)`)
    if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR') throw new ClankerError('config', `There is no config at ${path}. Run \`clankerinbox setup\` first.`)
    throw new ClankerError('config', `cannot read the config at ${path} (${e?.code || e?.message})`)
  }
  let config: Config
  try {
    config = JSON.parse(raw) as Config
  } catch (e: any) {
    throw new ClankerError('config', `the config at ${path} is not valid JSON (${e?.message}). Repair it, or run \`clankerinbox setup --force\` to write a new one`)
  }
  try {
    validateConfig(config, path)
  } catch (e: any) {
    throw e instanceof ClankerError ? e : new ClankerError('config', e?.message || String(e))
  }
  return config
}

// Keeps the config that a new setup replaces: as config.json.bak, and an older .bak that
// differs as config.json.bak-<time>, so no earlier config is ever lost. Returns the .bak path,
// or null when there was no config. `moved` hears where an older .bak went.
export function backupConfig(path: string, now = Date.now(), moved?: (older: string) => void): string | null {
  if (!existsSync(path)) return null
  const bak = path + '.bak'
  const current = readFileSync(path)
  if (existsSync(bak)) {
    const old = readFileSync(bak)
    if (old.equals(current)) return bak
    const older = `${bak}-${new Date(now).toISOString().replace(/[:.]/g, '-')}`
    copyFileSync(bak, older)
    moved?.(older)
  }
  copyFileSync(path, bak)
  chmodSync(bak, 0o600)
  return bak
}

export function validateConfig(config: Config, where = 'config'): void {
  if (!config || typeof config !== 'object') throw new Error(`${where}: the config is not an object`)
  const provider = config.provider ?? 'postshiba'
  if (!PROVIDERS.includes(provider)) throw new Error(`${where}: the provider must be ${PROVIDERS.join(', ')}`)
  if (provider === 'postshiba' && !config.teamId) throw new Error(`${where}: teamId is missing`)
  if (provider === 'cloudflare') validateCloudflare(config, where)
  if (!config.from) throw new Error(`${where}: from is missing`)
  if (!config.inboxes || typeof config.inboxes !== 'object') throw new Error(`${where}: inboxes is missing`)
  for (const [name, inbox] of Object.entries(config.inboxes)) {
    if (!inbox.id || !inbox.address) throw new Error(`${where}: the inbox ${name} needs an id and an address`)
    if (!['answers', 'codes', 'requests'].includes(inbox.mode)) throw new Error(`${where}: the mode of the inbox ${name} must be answers, codes or requests`)
    if (inbox.allow !== '*' && !Array.isArray(inbox.allow)) throw new Error(`${where}: allow of the inbox ${name} must be "*" or a list`)
    // An open inbox that can steer agents would defeat the allowlist, so only code inboxes may be open.
    if (inbox.allow === '*' && inbox.mode !== 'codes') throw new Error(`${where}: the inbox ${name} has the mode ${inbox.mode}, so allow cannot be "*"`)
    if (!Array.isArray(inbox.send)) inbox.send = []
  }
}

function validateCloudflare(config: Config, where: string): void {
  const c = config.cloudflare
  if (!c || !c.url || !c.tokenEnv) throw new Error(`${where}: cloudflare needs url and tokenEnv`)
  let url: URL
  try {
    url = new URL(c.url)
  } catch {
    throw new Error(`${where}: the cloudflare url is not a URL: ${c.url}`)
  }
  // The token travels in every request, so only over TLS (plain http only to this machine).
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error(`${where}: the cloudflare url must use https`)
  for (const k of ['token', 'apiToken', 'secret', 'password']) {
    if (k in (c as any)) throw new Error(`${where}: do not put the Worker token in the config. Put it in an env var, and write the name of the env var in tokenEnv`)
  }
}

// Keys and tokens typed into `clankerinbox setup` live next to the config, readable only by
// the user, never inside it. An env var with the same name always wins.
export function secretsPath(path = configPath()): string {
  return path.replace(/\.json$/i, '') + '.secrets.json'
}

export function loadSecrets(path = configPath()): Record<string, string> {
  try {
    const data = JSON.parse(readFileSync(secretsPath(path), 'utf8'))
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(data || {})) if (typeof v === 'string' && v) out[k] = v
    return out
  } catch {
    return {}
  }
}

export function saveSecret(name: string, value: string, path = configPath()): void {
  writeJsonAtomic(secretsPath(path), { ...loadSecrets(path), [name]: value }, 0o600)
}

export function withSecrets(vars: Record<string, string | undefined>, path = configPath(vars)): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...loadSecrets(path) }
  for (const [k, v] of Object.entries(vars)) if (v) out[k] = v
  // Where the values came from, so a check can say where a key comes from. A symbol: it never
  // shows up as an env var, but a copy of the object keeps it.
  Object.defineProperty(out, SECRETS_FROM, { value: { path, vars }, enumerable: true })
  return out
}

const SECRETS_FROM = Symbol('secretsFrom')

// Where the value of env var `name` in an env from withSecrets comes from, in words for a check
// line: "in the environment", "in <secrets file>", "typed in setup" (a value set later), or
// "not set". An env that did not come from withSecrets is the environment.
export function keyOrigin(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]
  if (!value) return 'not set'
  const from = (env as any)[SECRETS_FROM] as { path: string; vars: Record<string, string | undefined> } | undefined
  if (!from || from.vars[name] === value) return 'in the environment'
  if (loadSecrets(from.path)[name] === value) return `in ${secretsPath(from.path)}`
  return 'typed in setup'
}

export function saveConfig(config: Config, path = configPath()): void {
  validateConfig(config, path)
  writeJsonAtomic(path, config, 0o600)
}

export function writeJsonAtomic(path: string, value: unknown, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode })
    renameSync(tmp, path)
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
}

// The named inbox, which must have one of the modes; with no name, the first inbox of the first mode.
export function inboxByMode(config: Config, mode: Mode | Mode[], name?: string): [string, InboxConfig] {
  const modes = Array.isArray(mode) ? mode : [mode]
  // An empty name was given on purpose (a variable that was not set), so it never means the default.
  if (name !== undefined && !name.trim()) throw new ClankerError('usage', `the inbox name is empty. Inboxes: ${Object.keys(config.inboxes).join(', ')}`)
  if (name !== undefined) {
    const inbox = Object.hasOwn(config.inboxes, name) ? config.inboxes[name] : undefined
    if (!inbox) throw new ClankerError('usage', `No inbox named ${name}. Inboxes: ${Object.keys(config.inboxes).join(', ')}`)
    if (!modes.includes(inbox.mode)) throw new ClankerError('usage', `the inbox ${name} has the mode ${inbox.mode}, not ${modes.join(' or ')}`)
    return [name, inbox]
  }
  const found = Object.entries(config.inboxes).find(([, i]) => i.mode === modes[0])
  if (!found) throw new ClankerError('config', `the config has no inbox with the mode ${modes[0]}`)
  return found
}
