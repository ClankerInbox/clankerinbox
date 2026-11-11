// `clankerinbox setup` with no flags in a terminal: a few questions instead of a long
// command line. It finds what it can by itself (PostShiba domains, Cloudflare zones),
// writes the same config as the flags do (through setup()), logs in to prove it works,
// offers fixes for what fails, and ends with a real question to the owner. A key or
// token that is not in the environment is asked for without echo and, if the user agrees, saved next to the config (mode
// 0600), never inside it; an env var with the same name still wins.

import * as readline from 'node:readline'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  configPath as defaultConfigPath, loadConfig, loadSecrets, saveConfig, backupConfig, saveSecret, secretsPath, withSecrets, legacyNotice, stateDir,
  postshibaApi, type Config, DEFAULT_API_URL, DEFAULT_READ_KEY_ENV, DEFAULT_SEND_KEY_ENV,
} from './config.ts'
import { createProvider, providerName, type Check, type Env, type Provider } from './provider.ts'
import { setup, agentName, routingCheck, setupKeyName, safeApiUrl, typedAddresses, hostName, DEFAULT_CF_TOKEN_ENV } from './setup.ts'
import { PostShiba, missingRecords, type SendingDomain } from './postshiba.ts'
import { resolveMx } from 'node:dns/promises'
import { ClankerInbox } from './clankerinbox.ts'
import { errorKind } from './errors.ts'
import { cleanLine } from './safety.ts'
import { makeUi, plural, spinner } from './ui.ts'
import * as cf from './cloudflare-deploy.ts'

export interface OnboardIo {
  input: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (on: boolean) => unknown }
  output: NodeJS.WritableStream & { isTTY?: boolean }
}

export interface OnboardOptions extends OnboardIo {
  env?: Env
  configPath?: string
  // Test hooks: the provider the checks run against, and another PostShiba API.
  provider?: (config: Config, env: Env) => Provider
  apiUrl?: string
  // Test hook: how setup waits for a just-deployed Worker to answer.
  workerOnline?: (url: string, token: string) => Promise<void>
  cloudflareApi?: string
  // Test hooks: how long to wait for the test reply, and the MX lookup of a mail domain.
  replyWait?: { timeoutMs: number; intervalMs: number }
  mxLookup?: (name: string) => Promise<{ exchange: string; priority: number }[]>
  // Test hook: how long setup waits for the click on a Cloudflare verification link.
  verifyWait?: { timeoutMs: number; intervalMs: number }
  // Test hook: whether a Worker accepts a token (true, false, or null for no answer).
  tokenCheck?: (url: string, token: string) => Promise<boolean | null>
  // How the user runs this CLI, for the commands it suggests (`node bin/clankerinbox.ts` in a checkout).
  command?: string
  // Setup flags that the questions use: another PostShiba API, and the PostShiba tenant.
  flags?: { apiUrl?: string; tenant?: string }
}

const CHECK_TIMEOUT_MS = 20_000

// `note` is a short dim line next to the label: what the choice means.
interface Choice { label: string; value: string; note?: string }

// End of input (Ctrl-D, or a closed pipe) at a question: setup stops, and says what it saved.
export class SetupStopped extends Error {
  constructor() {
    super('setup stopped: no more input')
  }
}

// Visible width of a line, without colour codes.
const visible = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').length

export class Prompter {
  private io: OnboardIo
  readonly tty: boolean
  // A terminal that understands cursor codes (not TERM=dumb): menus redraw in place.
  readonly fancy: boolean
  private color: boolean
  private env: Env
  private lines?: AsyncIterator<string>
  // What Ctrl+C prints before setup exits: what was saved, and how to go on.
  stopNote: () => string = () => 'Setup stopped. Nothing was saved.'

  constructor(io: OnboardIo, env: Env) {
    this.io = io
    this.env = env
    this.tty = !!(io.input.isTTY && io.input.setRawMode && io.output.isTTY)
    this.fancy = this.tty && env.TERM !== 'dumb'
    this.color = this.fancy && !env.NO_COLOR
    if (!this.tty) this.lines = readline.createInterface({ input: io.input, terminal: false })[Symbol.asyncIterator]()
  }

  paint(code: string, s: string): string {
    return this.color ? `\x1b[${code}m${s}\x1b[0m` : s
  }

  write(s: string): void {
    this.io.output.write(s)
  }

  ok(s: string): void { this.write(`${this.paint('32', '✓')} ${s}\n`) }
  warn(s: string): void { this.write(`${this.paint('33', '!')} ${s}\n`) }

  // Ctrl+C: the note, then exit 130, as shells do.
  interrupt(): never {
    if (this.tty) this.io.input.setRawMode!(false)
    this.write(`\n${this.stopNote()}\n`)
    process.exit(130)
  }

  // A spinner with the label in a terminal, until stop().
  spin(label: string, onInterrupt?: () => string): { stop(final?: string): void } {
    const out = this.io.output as NodeJS.WriteStream
    if (!this.tty) return { stop: () => {} }
    return spinner(label, out, makeUi(out, this.color ? {} : { NO_COLOR: '1' }), { env: this.env, onInterrupt: onInterrupt || (() => this.stopNote()) })
  }

  // One step that takes a while: a spinner in a terminal, then a ✓ or ✗ line.
  async step<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const spin = this.spin(label)
    try {
      const v = await fn()
      spin.stop()
      this.ok(label)
      return v
    } catch (e) {
      spin.stop()
      this.fail(`${label}: ${(e as Error)?.message || e}`)
      throw Object.assign(e as object, { shown: true })
    }
  }
  fail(s: string): void { this.write(`${this.paint('31', '✗')} ${s}\n`) }

  private async readLine(question: string): Promise<string> {
    if (!this.tty) {
      this.write(question)
      const next = await this.lines!.next()
      if (next.done) throw new SetupStopped()
      this.write('\n')
      return next.value
    }
    // A terminal without cursor codes (TERM=dumb) gets a plain line, as the terminal echoes it.
    const rl = readline.createInterface({ input: this.io.input, output: this.io.output, terminal: this.fancy })
    rl.on('SIGINT', () => this.interrupt())
    try {
      return await new Promise<string>((resolve, reject) => {
        rl.on('close', () => reject(new SetupStopped()))
        rl.question(question, resolve)
      })
    } finally {
      rl.close()
    }
  }

  // Asks until `check` accepts the answer; an empty answer takes the default.
  // One short line above a question: what it is for, or where to find the answer.
  hint(text: string | undefined): void {
    this.write(text ? `\n${this.paint('2', text)}\n` : '\n')
  }

  async ask(question: string, opts: { def?: string; hint?: string; check?: (v: string) => string | null } = {}): Promise<string> {
    this.hint(opts.hint)
    const hint = opts.def ? this.paint('2', ` (${opts.def})`) : ''
    for (;;) {
      const answer = (await this.readLine(`${this.paint('1', question)}${hint} `)).trim() || opts.def || ''
      const problem = opts.check ? opts.check(answer) : answer ? null : 'Enter a value.'
      if (!problem) return answer
      this.write(`  ${this.paint('33', problem)}\n`)
    }
  }

  // Like ask(), but the answer is not shown (a star per character in a terminal).
  async secret(question: string, opts: { optional?: boolean; hint?: string } = {}): Promise<string> {
    this.hint(opts.hint)
    for (;;) {
      const answer = (this.tty ? await this.hiddenLine(`${this.paint('1', question)} `) : await this.readLine(`${question} `)).trim()
      if (answer || opts.optional) return answer
      this.write(`  ${this.paint('33', 'Enter a value.')}\n`)
    }
  }

  private hiddenLine(question: string): Promise<string> {
    const { input } = this.io
    this.write(question)
    input.setRawMode!(true)
    input.resume()
    return new Promise((resolve, reject) => {
      let value = ''
      const onData = (chunk: Buffer | string) => {
        for (const ch of chunk.toString('utf8')) {
          if (ch === '\u0003') this.interrupt()
          else if (ch === '\u0004' && !value) {
            input.off('data', onData)
            input.setRawMode!(false)
            input.pause()
            reject(new SetupStopped())
            return
          } else if (ch === '\r' || ch === '\n') {
            input.off('data', onData)
            this.write('\n')
            // A pasted key often ends with a line break of its own: what arrives right after
            // the Enter is dropped, so it never answers the next question.
            const drop = () => {}
            input.on('data', drop)
            setTimeout(() => {
              input.off('data', drop)
              input.setRawMode!(false)
              input.pause()
              resolve(value)
            }, 75)
            return
          } else if (ch === '\u007f' || ch === '\b') {
            if (value) {
              value = value.slice(0, -1)
              this.write('\b \b')
            }
          } else if (ch >= ' ') {
            value += ch
            this.write('*')
          }
        }
      }
      input.on('data', onData)
    })
  }

  async confirm(question: string, def = false): Promise<boolean> {
    const answer = await this.ask(`${question} ${def ? '(Y/n)' : '(y/N)'}`, {
      check: (v) => (v === '' || /^(y|yes|n|no)$/i.test(v) ? null : 'Type y or n.'),
    })
    return answer === '' ? def : /^y/i.test(answer)
  }

  async select(question: string, choices: Choice[], hint?: string): Promise<string> {
    this.hint(hint)
    if (!this.fancy) {
      this.write(`${question}\n${choices.map((c, i) => `  ${i + 1}. ${c.label}${c.note ? ` - ${c.note}` : ''}`).join('\n')}\n`)
      const n = await this.ask('Number', {
        def: '1',
        check: (v) => (/^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= choices.length ? null : `Type a number from 1 to ${choices.length}.`),
      })
      return choices[Number(n) - 1].value
    }
    const { input } = this.io
    const out = this.io.output as NodeJS.WriteStream
    // A list taller than the terminal cannot be redrawn in place: long lists show a page and
    // take typed letters as a filter.
    const page = Math.max(3, Math.min(10, (out.rows || 24) - 4))
    const long = choices.length > page
    const columns = out.columns || 80
    const cols = Math.max(20, columns - 1)
    const width = Math.max(...choices.map((c) => c.label.length))
    let filter = ''
    let i = 0
    let top = 0
    let drawn = 0
    const shown = () => (filter ? choices.filter((c) => c.label.toLowerCase().includes(filter)) : choices)
    const line = (c: Choice, on: boolean) => {
      const head = `${on ? '  › ' : '    '}${c.label}`.slice(0, cols)
      const note = c.note ? `  ${' '.repeat(width - c.label.length)}${c.note}` : ''
      const room = cols - head.length
      const tail = note.length > room ? (room > 1 ? note.slice(0, room - 1) + '…' : '') : note
      return on ? this.paint('36', head) + this.paint('2', tail) : head + this.paint('2', tail)
    }
    const draw = () => {
      const list = shown()
      i = Math.min(i, Math.max(0, list.length - 1))
      if (i < top) top = i
      if (i >= top + page) top = i - page + 1
      const lines = list.slice(top, top + page).map((c, k) => line(c, top + k === i))
      if (long) lines.push(this.paint('2', (filter ? `Filter "${filter}": ${list.length} of ${choices.length}` : `${choices.length} choices. Type to filter`).slice(0, cols)))
      if (drawn) this.write(`\x1b[${drawn}A\x1b[J`)
      this.write(lines.join('\n') + '\n')
      drawn = lines.length
    }
    // With at most 9 choices, a number key picks at once; a longer list moves to it, then Enter.
    const instant = !long && choices.length <= 9
    const keys = long ? ' (↑↓, type to filter, Enter)' : instant ? ` (↑↓ and Enter, or 1-${choices.length})` : ' (↑↓ or 1-9, Enter)'
    // The keys only when they fit next to the question.
    const head = `${this.paint('1', question)}${question.length + keys.length <= cols ? this.paint('2', keys) : ''}`
    // The question can be wider than the terminal; the collapse at the end must clear each of its rows.
    const headRows = Math.max(1, Math.ceil(visible(head) / columns))
    this.write(`${head}\n`)
    readline.emitKeypressEvents(input)
    input.setRawMode!(true)
    input.resume()
    draw()
    const picked = await new Promise<Choice>((resolve, reject) => {
      const onKey = (str: string, key: { name?: string; ctrl?: boolean; meta?: boolean; sequence?: string }) => {
        const list = shown()
        if (key?.ctrl && key.name === 'c') this.interrupt()
        if (key?.ctrl && key.name === 'd') {
          input.off('keypress', onKey)
          reject(new SetupStopped())
          return
        }
        if (key?.name === 'up' || (!long && key?.name === 'k')) i = (i + list.length - 1) % Math.max(1, list.length)
        else if (key?.name === 'down' || (!long && key?.name === 'j')) i = (i + 1) % Math.max(1, list.length)
        else if (key?.name === 'return' || key?.name === 'enter') {
          if (!list.length) return
          input.off('keypress', onKey)
          resolve(list[i])
          return
        } else if (long && key?.name === 'backspace') {
          filter = filter.slice(0, -1)
          i = top = 0
        } else if (long && str && str.length === 1 && str >= ' ' && !key?.ctrl && !key?.meta) {
          filter += str.toLowerCase()
          i = top = 0
        } else if (!long && /^[1-9]$/.test(key?.sequence || '') && Number(key.sequence) <= choices.length) {
          i = Number(key.sequence) - 1
          if (instant) {
            input.off('keypress', onKey)
            resolve(list[i])
            return
          }
        } else return
        draw()
      }
      input.on('keypress', onKey)
    }).finally(() => {
      input.setRawMode!(false)
      input.pause()
    })
    // Collapse the list into the answer, like the text questions.
    this.write(`\x1b[${drawn + headRows}A\x1b[J${this.paint('1', question)} ${this.paint('36', picked.label)}\n`)
    return picked.value
  }

  // In a terminal: a promise that settles with 'enter' when the user presses Enter, while
  // something else runs. Elsewhere it never settles. stop() gives the terminal back.
  onEnter(): { pressed: Promise<string>; stop(): void } {
    if (!this.tty) return { pressed: new Promise(() => {}), stop: () => {} }
    const { input } = this.io
    let onKey: ((s: string, key: { name?: string; ctrl?: boolean }) => void) | undefined
    const pressed = new Promise<string>((resolve) => {
      onKey = (_s, key) => {
        if (key?.ctrl && key.name === 'c') this.interrupt()
        if (key?.name === 'return' || key?.name === 'enter') resolve('enter')
      }
    })
    readline.emitKeypressEvents(input)
    input.setRawMode!(true)
    input.resume()
    input.on('keypress', onKey!)
    return {
      pressed,
      stop: () => {
        input.off('keypress', onKey!)
        input.setRawMode!(false)
        input.pause()
      },
    }
  }
}

const EMAIL = /^[^\s@<>,]+@[^\s@<>,]+\.[^\s@<>,]+$/
const urlCheck = (v: string) => {
  try {
    const u = new URL(v)
    return u.protocol === 'https:' || /^(localhost|127\.0\.0\.1)$/.test(u.hostname) ? null : 'Must be an https:// URL.'
  } catch {
    return 'Not a URL. Example: https://clankerinbox.example.com'
  }
}

// A domain as setup cleans the --domain flag: no scheme, path or dot at the end, lowercase.
function cleanDomain(v: string): { value: string; problem: string | null } {
  const problems: string[] = []
  const value = hostName(v, 'The domain', problems)
  return { value, problem: problems.length ? `${problems[0]}.` : null }
}

// Asks for a domain or host name, and shows the cleaned value when it differs from the answer.
// `check` sees the cleaned value.
async function askDomain(p: Prompter, question: string, opts: { def?: string; hint?: string; check?: (v: string) => string | null } = {}): Promise<string> {
  const typed = await p.ask(question, {
    def: opts.def,
    hint: opts.hint,
    check: (v) => { const c = cleanDomain(v); return c.problem || opts.check?.(c.value) || null },
  })
  const { value } = cleanDomain(typed)
  if (value !== typed) p.write(`  ${p.paint('2', `Domain: ${value}`)}\n`)
  return value
}

const PROVIDER_LABEL: Record<string, string> = { postshiba: 'PostShiba', cloudflare: 'Cloudflare Worker' }

function describe(config: Config): string {
  const rows = Object.entries(config.inboxes).map(([name, i]) => `    ${name.padEnd(8)}${i.address}`)
  return `${PROVIDER_LABEL[providerName(config)]}\n${rows.join('\n')}`
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const t = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer after ${ms / 1000} s`)), ms) })
  return Promise.race([p, t]).finally(() => clearTimeout(timer))
}

// `records`: DNS records the failed step still needs, as Type / Name / Value rows.
export interface Failure { label: string; message: string; records?: string[][] }

// Runs the provider's checks in order and prints one line each; stops at the first
// failure, since a later step (a login) cannot pass without an earlier one (the key).
// `extra`: checks after the provider's own (the routing rules of a Cloudflare setup).
export async function firstFailure(
  config: Config, env: Env, print: { ok(s: string): void; fail(s: string): void; warn?(s: string): void },
  make: (config: Config, env: Env) => Provider = createProvider, extra: Check[] = [],
): Promise<Failure | null> {
  let checks: Check[]
  try {
    checks = [...(make(config, env).checks?.() || []), ...extra]
  } catch (e: any) {
    print.fail(e?.message || String(e))
    return { label: '', message: e?.message || String(e) }
  }
  for (const c of checks) {
    try {
      const r = await withTimeout(c.run(), CHECK_TIMEOUT_MS)
      if (r && typeof r === 'object' && r.warn) {
        if (print.warn) print.warn(`${c.label}: ${r.warn}`)
        else print.ok(`${c.label} (${r.warn})`)
      } else print.ok(c.label)
    } catch (e: any) {
      const message = e?.message || String(e)
      print.fail(`${c.label}: ${message}`)
      return { label: c.label, message, ...(Array.isArray(e?.records) && e.records.length ? { records: e.records } : {}) }
    }
  }
  return null
}

export async function runChecks(
  config: Config, env: Env, print: { ok(s: string): void; fail(s: string): void },
  make: (config: Config, env: Env) => Provider = createProvider,
): Promise<boolean> {
  return (await firstFailure(config, env, print, make)) === null
}

const NETWORK = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ECONNRESET|no answer after|timed? ?out|certificate|fetch failed|cannot reach/i
const KEY_HELP = 'https://www.postshiba.com/docs/create-an-api-key'

// What a failed check most likely means, and what to do: one or two plain sentences.
// `interactive`: inside setup, where a key can be typed again below and "Check again" is a choice.
// `given`: the environment as the shell set it, and `saved`: config.secrets.json, so a token
// that comes from the shell (and hides the saved one) is named.
export function advice(config: Config, f: Failure, interactive = true, given?: Env, saved?: Record<string, string>): string | null {
  const { label, message } = f
  if (/^Token found/.test(label) || /no (send|full-access) key/.test(message)) {
    return interactive ? 'Enter it below, or set it in your shell.' : 'Set it in your shell, or run setup to save it in config.secrets.json.'
  }
  if (/^Send key/.test(label) && /401/.test(message)) {
    return `PostShiba rejected the send key. Use a Send only key (or the Full access key) from this team: ${KEY_HELP}`
  }
  if (/^Worker answers/.test(label)) {
    const name = config.cloudflare?.tokenEnv || DEFAULT_CF_TOKEN_ENV
    if (/401|unauthorized/i.test(message) && given?.[name]) {
      const other = saved?.[name] && saved[name] !== given[name]
      return `The Worker rejected the token. It came from the environment (${name}), not from config.secrets.json. ${other
        ? `config.secrets.json has a different token, but the environment overrides it. Run \`unset ${name}\` and remove it from your shell profile.`
        : 'Fix it there, or unset it and run setup to save the right one.'}`
    }
    if (/401|unauthorized/i.test(message)) return 'The Worker rejected the token. Use the Worker\'s API_TOKEN (`wrangler secret put API_TOKEN`). A Worker without one rejects every token.'
    return 'Check the Worker URL. `wrangler deploy` prints it.'
  }
  if (/^Worker is ready/.test(label)) {
    const fixes: string[] = []
    if (/no mail table/.test(message)) fixes.push('Create the tables: in the Worker folder, run `npx wrangler d1 execute clankerinbox --remote --file=schema.sql`.')
    if (/RETENTION_HOURS/.test(message)) fixes.push('Set RETENTION_HOURS in [vars] of wrangler.toml to a number of hours, e.g. "168".')
    if (/SENDER/.test(message)) fixes.push('Set SENDER in [vars] of wrangler.toml to the address the Worker sends as.')
    return `${fixes.join(' ')} Then redeploy the Worker, or run setup again (it reuses what's there).`.trim()
  }
  if (/^Read mail from PostShiba/.test(label) && /401|403/.test(message)) {
    return `PostShiba rejected the key. Reading mail needs a Full access key: ${KEY_HELP}`
  }
  if (/^PostShiba lets .* send$/.test(label) && f.records) {
    const domain = label.replace(/^PostShiba lets | send$/g, '')
    return `Add these DNS records for ${domain}:\n${dnsTable(f.records)}\n  DNS changes can take a few minutes. ${interactive ? 'Then choose "Check again".' : 'Then run the check again.'}`
  }
  if (/reaches PostShiba/.test(label) && !NETWORK.test(message)) {
    const m = /(\S+) MX (\d+) (\S+)$/.exec(message)
    const table = m ? `\n${dnsTable([['MX', m[1], `${m[3]} (priority ${m[2]})`]])}\n  ` : ' '
    const elsewhere = /point at/.test(message) ? 'and remove the MX records that point elsewhere (all mail for the domain then goes to PostShiba)' : ''
    return `Add this DNS record${elsewhere ? ` ${elsewhere}` : ''}:${table}DNS changes can take a few minutes. ${interactive ? 'Then choose "Check again".' : 'Then run the check again.'}`
  }
  if (/^Routing rules/.test(label)) {
    if (/wrangler login|permission/.test(message)) return null
    return 'Run setup again (it reuses what\'s there), or route each address to the Worker in the dashboard: your domain → Email → Email Routing → Routing rules.'
  }
  if (providerName(config) === 'postshiba' && NETWORK.test(message)) return 'Can\'t reach PostShiba. Check your internet connection.'
  return null
}

// The env var whose value a failure points at, when typing it again could fix it.
export function secretOf(config: Config, f: Failure): string | null {
  if (NETWORK.test(f.message)) return null
  if (config.provider === 'cloudflare' && (/^Token found/.test(f.label) || (/^Worker answers/.test(f.label) && /401|unauthorized/i.test(f.message)))) {
    return config.cloudflare?.tokenEnv || null
  }
  if (providerName(config) === 'postshiba') {
    if (/^Send key/.test(f.label) && /401|no send key/.test(f.message)) return config.sendKeyEnv || DEFAULT_SEND_KEY_ENV
    if (/^Read mail|reaches PostShiba|^PostShiba lets/.test(f.label) && /401|403|no full-access key/.test(f.message)) return config.readKeyEnv || DEFAULT_READ_KEY_ENV
  }
  return null
}

// Where the value of a key comes from: the shell, config.secrets.json, or nowhere.
function sourceOf(name: string, given: Env, path: string): 'env' | 'file' | 'none' {
  if (given[name]) return 'env'
  return loadSecrets(path)[name] ? 'file' : 'none'
}

// One line on where the key of a failed check comes from, so the fix goes to the right place.
export function keySource(config: Config, f: Failure, given: Env, path: string): string | null {
  const name = secretOf(config, f)
  if (!name) return null
  const src = sourceOf(name, given, path)
  if (src === 'env') return `${name} is set in your environment, which wins over the saved one. Fix it there.`
  if (src === 'file') return `The ${keyWord(config, name)} comes from ${secretsPath(path)} (${name}).`
  return null
}

// The key behind an env var, in the words setup uses for it.
function keyWord(config: Config, name: string): string {
  if (providerName(config) === 'cloudflare') return 'token'
  return name === (config.sendKeyEnv || DEFAULT_SEND_KEY_ENV) ? 'send key' : 'full-access key'
}

function keyPrompt(config: Config, name: string): string {
  if (providerName(config) === 'cloudflare') return 'Worker token:'
  return `PostShiba ${keyWord(config, name)}:`
}

// Why the test reply did not count, in words the person who sent it can act on.
function whyIgnored(reason: string, from?: string): string {
  if (/allowlist/.test(reason)) return `It came from ${from || 'an address'}, which isn't allowed to answer. Reply from the address you gave setup, or run setup again and add this one.`
  if (/DMARC/.test(reason)) {
    return `The mail server couldn't confirm it really came from ${from ? from.split('@')[1] : 'your domain'} (DMARC). Reply from a normal mail account (Gmail, Fastmail, Outlook), not from a script or through a forwarder.`
  }
  if (/empty/.test(reason)) return 'The reply was empty. Write it above the quoted text.'
  if (/automated/.test(reason)) return 'That was an auto-reply. Reply yourself.'
  return reason
}

function gitEmail(): string | undefined {
  try {
    const v = execFileSync('git', ['config', '--get', 'user.email'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).trim()
    return EMAIL.test(v) && !/noreply|no-reply/i.test(v) ? v.toLowerCase() : undefined
  } catch {
    return undefined
  }
}

interface Plan {
  input: Parameters<typeof setup>[0]
  // Work that needs the written config (routing the new addresses to the Worker).
  after?: (config: Config) => Promise<void>
}

interface Ctx {
  p: Prompter
  opts: OnboardOptions
  env: Env
  given: Env
  path: string
  // Secrets typed in this run; saved only after the config is written and the user agrees.
  typed: Record<string, string>
  // Typed secrets that are not saved: they must be set in the shell.
  unsaved: Set<string>
  // Secrets setup made itself (the Worker's token); always saved, since nothing else keeps them.
  generated: Record<string, string>
  need(name: string, question: string, hint: string, optional?: boolean): Promise<string>
  allow(): Promise<string[]>
  name(domain: string): Promise<string>
  // The config before this run, if setup runs again.
  previous?: Config
  replacing: boolean
  // How the user runs this CLI, for the commands setup suggests.
  cli: string
  // The line that goes with a suggested command when the shell must keep custom paths, or ''.
  same: string
  // What setup made on the Cloudflare account in this run.
  made: string[]
  // Sending domains setup added on PostShiba in this run.
  added: string[]
  // The user goes on before PostShiba verified the DNS records of the domain.
  dnsLater: boolean
  // The config is written: from here on, stopping keeps it.
  saved: boolean
  // The tag of the test question while setup waits for its reply.
  waiting?: string
  // Steps that did not pass and what to do about each; setup is complete only without any.
  problems: { what: string; fix: string }[]
}

// What setup kept when it stops before the end (Ctrl+C, Ctrl-D, "Stop here"), and how to go on.
function stopNote(ctx: Ctx): string {
  const { cli, path } = ctx
  const lines: string[] = []
  if (ctx.waiting) lines.push(`Setup stopped. The config is saved and the test question was sent. To wait for the reply: ${cli} wait ${ctx.waiting}`)
  else if (ctx.saved) lines.push(`Setup stopped. The config is saved at ${path}. To check it: ${cli} check`)
  else lines.push(`Setup stopped. Nothing was saved.${ctx.replacing ? ' Your config is unchanged.' : ''}`)
  if (!ctx.saved) {
    for (const d of ctx.added) lines.push(`The domain ${d} that setup added is still on PostShiba. To continue, run ${cli} setup again and pick ${d}.`)
    if (ctx.made.length) lines.push(`Created on your Cloudflare account (to remove these, see "Remove the Worker" in the README):\n${ctx.made.map((m) => `  - ${m}`).join('\n')}`)
  }
  if (ctx.same && (ctx.saved || ctx.waiting || ctx.added.length)) lines.push(ctx.same)
  return lines.join('\n')
}

// For a flow that stops at the user's choice: says what was kept, then setup ends.
function stopped(ctx: Ctx): null {
  ctx.p.write(`${stopNote(ctx)}\n`)
  return null
}

// Returns the exit code.
export async function onboard(opts: OnboardOptions): Promise<number> {
  const given = opts.env || process.env
  const path = opts.configPath || defaultConfigPath(given)
  const env = withSecrets(given, path)
  const p = new Prompter(opts, given)
  // The commands setup suggests work with the config and the state of this run. The shell has
  // CLANKERINBOX_CONFIG and CLANKERINBOX_STATE already, so the commands stay short and one line
  // says that they need the same values; paths from the old AGENTMAIL_ names are written out.
  const configWritten = !!given.AGENTMAIL_CONFIG || path !== defaultConfigPath(given)
  const stateWritten = !!given.AGENTMAIL_STATE
  const custom = `${configWritten ? `CLANKERINBOX_CONFIG=${path} ` : ''}${stateWritten ? `CLANKERINBOX_STATE=${stateDir(given)} ` : ''}`
  const cli = `${custom}${opts.command || 'clankerinbox'}`
  const vars = [...(!configWritten && given.CLANKERINBOX_CONFIG ? ['CLANKERINBOX_CONFIG'] : []), ...(!stateWritten && given.CLANKERINBOX_STATE ? ['CLANKERINBOX_STATE'] : [])]
  const same = vars.length ? `(with the same ${vars.join(' and ')})` : ''
  const ctx: Ctx = {
    p, opts, env, given, path, typed: {}, unsaved: new Set(), generated: {}, cli, same, made: [], added: [], problems: [],
    replacing: false, dnsLater: false, saved: false,
    async need(name, question, hint, optional = false) {
      if (env[name]) return env[name]!
      const value = await p.secret(question, { optional, hint })
      if (value) {
        ctx.typed[name] = value
        env[name] = value
      }
      return value
    },
    async allow() {
      let list: string[] = []
      await p.ask('Your email address:', {
        def: gitEmail(),
        hint: 'The agent sends its questions here and only accepts replies from here. Separate several addresses with commas.',
        check: (v) => {
          const problems: string[] = []
          list = typedAddresses(v, problems)
          return problems.length ? problems.map((x) => x.replace(/\.?$/, '.')).join(' ') : null
        },
      })
      p.write(`  ${p.paint('2', `Only replies from ${list.join(', ')} count.`)}\n`)
      return list
    },
    // On the same domain, the default is the name from before. Then the address stays.
    async name(domain) {
      const before = Object.values(ctx.previous?.inboxes || {}).find((i) => i.mode === 'answers' && i.address.endsWith(`@${domain}`))
      const answer = await p.ask('Agent name:', {
        def: before ? before.address.split('@')[0] : 'agent',
        hint: `The agent's address will be <name>@${domain}. Verification codes go to signup@${domain}.\nAdd more addresses later (e.g. one per agent) with: ${cli} create <name>`,
        check: (v) => { try { agentName(v); return null } catch { return 'Start with a letter, then letters, digits or "-" (max 32). "signup" is taken.' } },
      })
      return agentName(answer)
    },
  }
  p.stopNote = () => stopNote(ctx)
  try {
    return await steps(ctx)
  } catch (e) {
    if (!(e instanceof SetupStopped)) throw e
    p.write(`\n${stopNote(ctx)}\n`)
    return 1
  }
}

async function steps(ctx: Ctx): Promise<number> {
  const { p, opts, env, given, path, cli } = ctx
  p.write(`\n${p.paint('1', 'clankerinbox setup')}\n${p.paint('2', 'Give your agent its own email address, so it can ask you questions, read your replies and receive verification codes.\nPress Ctrl+C to stop at any time.')}\n`)
  // The default folders only: a config path given by the caller is where it is on purpose.
  const legacy = opts.configPath ? null : legacyNotice(given)
  if (legacy) {
    p.write('\n')
    p.warn(legacy)
  }

  if (existsSync(path)) {
    let config: Config | undefined
    let broken = ''
    try {
      config = loadConfig(path)
      ctx.previous = config
    } catch (e: any) {
      broken = e?.message || String(e)
    }
    if (config) p.write(`\nAlready set up: ${describe(config)}\n`)
    else {
      p.write('\n')
      p.warn(`${broken[0].toUpperCase()}${broken.slice(1)}`)
      p.write('  Setup can write a new one. The old file is kept as config.json.bak.\n')
    }
    const what = await p.select('What do you want to do?', [
      ...(config ? [{ label: 'Check it', value: 'check', note: 'log in and test, changes nothing' }] : []),
      { label: 'Set up again', value: 'replace', note: 'the old config is backed up' },
      { label: 'Leave it', value: 'leave' },
    ])
    if (what === 'leave') {
      p.write('Your config is unchanged.\n')
      return 0
    }
    if (what === 'check') {
      if (opts.flags?.apiUrl || opts.flags?.tenant) p.write(`  ${p.paint('2', 'The check uses the existing config. --api-url and --tenant only apply to a new setup.')}\n`)
      p.write('\n')
      ctx.saved = true
      const extra = providerName(config!) === 'cloudflare' ? [routingCheck(config!, path, env, opts.cloudflareApi)] : []
      const ready = await verify(ctx, config!, 'ask', extra)
      unsavedLine(ctx)
      if (!ready) return fixLine(p, cli, ctx.same)
      if (ctx.problems.length) return incomplete(ctx)
      if (!(await testQuestion(ctx, config!, 'ask'))) return incomplete(ctx)
      summary(p, config!, cli, ctx.same)
      return 0
    }
    ctx.replacing = true
  }

  let kind: string
  if (opts.flags?.apiUrl || opts.flags?.tenant) {
    kind = 'postshiba'
    p.write(`\nMail service: PostShiba ${p.paint('2', `(${[opts.flags.apiUrl ? `--api-url ${opts.flags.apiUrl}` : '', opts.flags.tenant ? `--tenant ${opts.flags.tenant}` : ''].filter(Boolean).join(', ')})`)}\n`)
  } else {
    kind = await p.select('Which mail service?', [
      { label: 'PostShiba', value: 'postshiba', note: 'email API, addresses on your own domain' },
      { label: 'Cloudflare', value: 'cloudflare', note: 'a Worker on your Cloudflare domain' },
    ], 'Cloudflare\'s free plan only sends to addresses you verify, which is enough for questions to yourself. Sending to anyone needs Workers Paid ($5 a month).')
  }

  const plan = kind === 'postshiba' ? await postshibaFlow(ctx) : await cloudflareFlow(ctx)
  if (!plan) return 1

  const names = Object.keys(ctx.typed)
  if (names.length) p.hint('Keys are saved next to the config, never in it. If you skip this, set them in your shell yourself.')
  const save = names.length > 0 && await p.confirm(`Save ${names.length === 1 ? 'the key' : 'the keys'} in a file only you can read?`, true)
  if (!save) for (const name of names) ctx.unsaved.add(name)
  p.write('\n')

  if (ctx.replacing) {
    let older = ''
    const bak = backupConfig(path, Date.now(), (o) => { older = o })
    if (bak) p.ok(`Old config saved as ${bak}${older ? ` (the previous backup is now ${older})` : ''}`)
  }
  let config: Config
  let written: Awaited<ReturnType<typeof setup>>
  try {
    written = await setup({ ...plan.input, configPath: path, env, force: true })
    config = written.config
  } catch (e: any) {
    p.fail(e?.message || String(e))
    return 1
  }
  ctx.saved = true
  p.ok(`Saved the config to ${path}`)
  for (const line of keptLines(written)) p.ok(line)
  for (const n of written.dropped || []) p.warn(`Dropped the old inbox ${n}: a new inbox uses its name or address`)
  if (save) {
    for (const name of names) saveSecret(name, ctx.typed[name], path)
    p.ok(`Saved the ${names.length === 1 ? 'key' : 'keys'} to ${secretsPath(path)}`)
  }
  for (const [name, value] of Object.entries(ctx.generated)) {
    saveSecret(name, value, path)
    p.ok(`Saved the Worker token to ${secretsPath(path)}`)
    // A token in the shell wins over the saved one, so later commands would use the old one.
    if (given[name] && given[name] !== value) {
      ctx.problems.push({
        what: `${name} in your shell holds a different token`,
        fix: `It overrides the token setup just saved, so every command gets "401 unauthorized". Run \`unset ${name}\` and remove it from your shell profile (~/.bashrc, ~/.zshrc).`,
      })
    }
  }
  if (plan.after) await plan.after(config)

  p.write('\n')
  // A deploy made the routing rules itself; a Worker deployed before has its rules checked here.
  const extra = providerName(config) === 'cloudflare' && !plan.after ? [routingCheck(config, path, env, opts.cloudflareApi)] : []
  const keep = names.length ? save : 'ask'
  const ready = await verify(ctx, config, keep, extra)
  unsavedLine(ctx)
  if (!ready) return fixLine(p, cli, ctx.same)
  if (ctx.problems.length) return incomplete(ctx)
  if (!(await testQuestion(ctx, config, keep))) return incomplete(ctx)
  summary(p, config, cli, ctx.same)
  return 0
}

// What a new config kept of the old one: entries added to the lists by hand, and inboxes.
export function keptLines(res: { config: Config; kept?: string[]; keptEntries?: { inbox: string; allow: string[]; send: string[] }[] }): string[] {
  const entries = (res.keptEntries || []).flatMap((k) => [
    ...(k.allow.length ? [`on the allow list of ${k.inbox}: ${k.allow.join(', ')}`] : []),
    ...(k.send.length ? [`on the send list of ${k.inbox}: ${k.send.join(', ')}`] : []),
  ])
  return [
    ...(entries.length ? [`Kept from the old config: ${entries.join('; ')}`] : []),
    ...(res.kept || []).map((n) => `Kept the inbox ${n} (${res.config.inboxes[n]?.address})`),
  ]
}

// Keys typed in this run that are not saved must come from the shell later.
function unsavedLine(ctx: Ctx): void {
  const names = [...ctx.unsaved]
  if (!names.length) return
  const stale = names.filter((n) => loadSecrets(ctx.path)[n] && loadSecrets(ctx.path)[n] !== ctx.typed[n])
  ctx.p.write(`\nThe keys were not saved. Set ${names.join(' and ')} in your shell before running other commands.\n`)
  if (stale.length) ctx.p.write(`${secretsPath(ctx.path)} still holds the old value of ${stale.join(' and ')}, so the one in your shell has to override it.\n`)
}

// The steps that did not pass and what to do about each. Exit code 1: mail cannot flow yet.
function incomplete(ctx: Ctx): number {
  const { p } = ctx
  p.write(`\n${p.paint('1', 'Setup isn\'t finished.')} The config is saved, but these steps failed:\n`)
  for (const x of ctx.problems) p.write(`${p.paint('31', '✗')} ${x.what}\n  ${x.fix}\n`)
  p.write(`\nFix those, then run ${p.paint('1', `${ctx.cli} check`)}. Or run setup again. It reuses what's already there.\n${ctx.same ? `${ctx.same}\n` : ''}`)
  return 1
}

function fixLine(p: Prompter, cli: string, same: string): number {
  p.write(`\nFix that, then run: ${p.paint('1', `${cli} check`)}\n${same ? `${same}\n` : ''}`)
  return 1
}

function summary(p: Prompter, config: Config, cli: string, same: string): void {
  const ask = Object.values(config.inboxes).find((i) => i.mode === 'answers')
  const signup = Object.values(config.inboxes).find((i) => i.mode === 'codes')
  const signupShown = signup ? (signup.address === ask?.address ? signup.address.replace('@', '+<tag>@') : signup.address) : ''
  const width = Math.max(ask?.address.length || 0, signupShown.length) + 3
  p.write(`\n${p.paint('1', 'Setup is complete.')} Your agent's addresses:\n`)
  if (ask) p.write(`    ${ask.address.padEnd(width)}${p.paint('2', 'asks you questions and gets your replies')}\n`)
  if (signup) p.write(`    ${signupShown.padEnd(width)}${p.paint('2', 'receives verification codes')}\n`)
  p.write(`\nTry it:       ${p.paint('1', `${cli} ask "Ship it?" --option Yes --option No --wait`)}\n`)
  p.write(`All commands: ${p.paint('1', `${cli} --help`)}\n`)
  if (same) p.write(`${same}\n`)
}

// Runs the checks; on a failure says what it means and offers to fix it here: type the
// key or the Worker URL again, or check again after fixing DNS or a setting elsewhere.
// `save`: whether a key typed here is saved; 'ask' asks after it is typed.
async function verify(ctx: Ctx, config: Config, save: boolean | 'ask', extra: Check[] = []): Promise<boolean> {
  const { p, given, path } = ctx
  for (;;) {
    const failed = await firstFailure(config, ctx.env, p, ctx.opts.provider, extra)
    if (!failed) return true
    // The user chose to add the sending records later: the rest of setup is done, and the
    // check says when the domain may send.
    if (ctx.dnsLater && /^PostShiba lets .* send$/.test(failed.label)) {
      ctx.problems.push({ what: `${failed.label}: not yet`, fix: advice(config, failed, false) || failed.message })
      return true
    }
    const tip = advice(config, failed, true, given, loadSecrets(path))
    if (tip) p.write(`  ${tip}\n`)
    const name = secretOf(config, failed)
    const src = name ? sourceOf(name, given, path) : 'none'
    const where = keySource(config, failed, given, path)
    if (where) p.write(`  ${where}\n`)
    const wrongUrl = config.provider === 'cloudflare' && /^Worker answers/.test(failed.label) && !/401|unauthorized/i.test(failed.message)
    const what = await p.select('What do you want to do?', [
      ...(name && src !== 'env' ? [{ label: `Enter the ${keyWord(config, name)}${src === 'none' && !ctx.typed[name] ? '' : ' again'}`, value: 'retype' }] : []),
      ...(wrongUrl ? [{ label: 'Enter the URL again', value: 'url' }] : []),
      { label: 'Check again', value: 'again', note: 'once it\'s fixed' },
      { label: 'Stop here', value: 'stop' },
    ])
    if (what === 'stop') return false
    if (what === 'url') {
      const url = await p.ask('Worker URL:', { check: urlCheck, def: config.cloudflare!.url })
      config.cloudflare = { ...config.cloudflare!, url: url.trim().replace(/\/+$/, '') }
      saveConfig(config, path)
    }
    if (what === 'retype') await retype(ctx, config, name!, save)
    p.write('\n')
  }
}

// Asks for a key again, by its name; saves it when the user chose to save keys (or says so now).
async function retype(ctx: Ctx, config: Config, name: string, save: boolean | 'ask'): Promise<void> {
  const { p, path } = ctx
  const value = await p.secret(keyPrompt(config, name))
  ctx.env[name] = value
  ctx.typed[name] = value
  const keep = save === 'ask' ? await p.confirm(`Save it in ${secretsPath(path)}?`, !!loadSecrets(path)[name]) : save
  if (keep) {
    saveSecret(name, value, path)
    ctx.unsaved.delete(name)
    p.ok(`Saved the ${keyWord(config, name)} to ${secretsPath(path)}`)
  } else ctx.unsaved.add(name)
}

// The end-to-end proof: a real question to the owner, and their reply read back through
// every rule. Says at once when a reply arrives but does not count, and why. Returns false
// when the test mail cannot go out (the reason is in ctx.problems): then setup is not complete.
async function testQuestion(ctx: Ctx, config: Config, save: boolean | 'ask'): Promise<boolean> {
  const { p, env, opts, cli, given, path } = ctx
  const inbox = Object.values(config.inboxes).find((i) => i.mode === 'answers')
  const to = inbox && Array.isArray(inbox.send) ? inbox.send[0] : undefined
  if (!inbox || !to) return true
  p.hint(`Last step: a real test. Your agent emails ${to}, and you reply from that address.\nCtrl+C stops setup here. Your config is already saved.`)
  if (!(await p.confirm('Send the test question?', true))) {
    p.write(`Skipped the test. To run it later: ${p.paint('1', `${cli} ask "Hello?" --wait`)}\n`)
    return true
  }
  p.write('\n')
  const cloudflare = providerName(config) === 'cloudflare'
  const keyName = cloudflare ? config.cloudflare?.tokenEnv || DEFAULT_CF_TOKEN_ENV : config.sendKeyEnv || DEFAULT_SEND_KEY_ENV
  let mail: ClankerInbox
  let tag: string
  for (;;) {
    mail = new ClankerInbox({ config, env, provider: opts.provider?.(config, env) })
    try {
      tag = (await p.step(`Sent to ${to}`, () => mail.ask({ question: 'This is the clankerinbox test. Reply with anything, e.g. "ok".', subject: 'clankerinbox test', to }))).tag
      break
    } catch (e: any) {
      const message = e?.message || String(e)
      if (/approval|production|not allowed/i.test(message)) {
        const fix = 'Until PostShiba approves your account for production, it only sends to your own team. Ask PostShiba for approval.'
        p.write(`  ${fix}\n`)
        ctx.problems.push({ what: 'The test mail wasn\'t sent', fix })
        return false
      }
      if (errorKind(e) !== 'auth') {
        ctx.problems.push({ what: 'The test mail wasn\'t sent', fix: `${cleanLine(message)}. To retry: ${cli} ask "Hello?" --wait` })
        return false
      }
      const src = sourceOf(keyName, given, path)
      const word = keyWord(config, keyName)
      p.write(`  ${cloudflare ? 'The Worker rejected the token' : `PostShiba rejected the send key. Use a Send only key (or the Full access key) from this team: ${KEY_HELP}`}.\n`)
      if (src === 'env') p.write(`  ${keyName} is set in your environment, which wins over the saved one. Fix it there.\n`)
      else if (src === 'file') p.write(`  The ${word} comes from ${secretsPath(path)} (${keyName}).\n`)
      const what = await p.select('What do you want to do?', [
        ...(src !== 'env' ? [{ label: `Enter the ${word} again`, value: 'retype' }] : []),
        { label: 'Stop here', value: 'stop' },
      ])
      if (what === 'stop') {
        ctx.problems.push({ what: `The ${word} in ${keyName} doesn't work`, fix: src === 'env' ? `Fix ${keyName} in your shell, or unset it.` : 'Run setup again and enter it.' })
        return false
      }
      await retype(ctx, config, keyName, save)
      p.write('\n')
    }
  }
  const wait = opts.replyWait || { timeoutMs: 15 * 60_000, intervalMs: 5000 }
  ctx.waiting = tag
  const start = () => p.spin('Waiting for your reply. Open the mail "clankerinbox test" and reply to it.')
  let spin = start()
  const told = new Set<string>()
  const say = (id: string, write: () => void) => {
    if (told.has(id)) return
    told.add(id)
    spin.stop()
    write()
    spin = start()
  }
  const deadline = Date.now() + wait.timeoutMs
  try {
    while (Date.now() < deadline) {
      // A new mail from the owner (not a reply) answers nothing; the owner hears why.
      const onUnmatched = (m: { id: string; from: string }) => say(m.id, () => {
        p.warn(`Got a mail from ${m.from}, but it isn't a reply to the test question.`)
        p.write('  Hit Reply on the "clankerinbox test" mail, so it goes to the right address.\n')
      })
      const res = await mail.poll({ consume: false, onUnmatched }).catch(() => null)
      const answer = mail.store.question(tag)?.answer
      if (answer) {
        mail.store.saveQuestion({ ...mail.store.question(tag)!, reported: true })
        spin.stop()
        const text = answer.answer.replace(/\s+/g, ' ').trim()
        p.ok(`Got your reply from ${answer.from}: "${text.length > 50 ? text.slice(0, 47) + '…' : text}"`)
        p.ok('Everything works.')
        return true
      }
      const allowed = (Array.isArray(inbox.allow) ? inbox.allow : []).map((a) => a.toLowerCase())
      for (const s of res?.skipped || []) {
        if (!(s.tag === tag || (s.from && allowed.includes(s.from.toLowerCase())))) continue
        say(s.id, () => {
          p.warn(`Got a mail from ${s.from || 'an unknown sender'}, but it doesn't count: ${s.reason}.`)
          p.write(`  ${whyIgnored(s.reason, s.from)}\n`)
        })
      }
      await new Promise((r) => setTimeout(r, wait.intervalMs))
    }
    spin.stop()
    p.warn(`No reply after ${wait.timeoutMs >= 60_000 ? plural(Math.round(wait.timeoutMs / 60_000), 'minute') : plural(Math.round(wait.timeoutMs / 1000), 'second')}.`)
    p.write(`  It can still arrive. To wait for it: ${p.paint('1', `${cli} wait ${tag}`)}\n  To see what arrived and why it didn't count: ${p.paint('1', `${cli} poll`)}\n`)
    return true
  } finally {
    spin.stop()
    ctx.waiting = undefined
  }
}

// The MX hosts of a name that are not PostShiba's: the name gets its mail somewhere else now.
async function otherMailServers(name: string, lookup = resolveMx): Promise<string[]> {
  const records = await withTimeout(lookup(name), 10_000).catch(() => [])
  return records.map((r) => r.exchange.toLowerCase().replace(/\.$/, '')).filter((h) => h && !/(^|\.)postshiba\.com$/.test(h))
}

const SIGN_UP = [
  'No account yet? Sign up at https://app.postshiba.com/users/sign_up',
  'In PostShiba: API keys → Create API key → Access: Full access. Copy the token.',
  `Setup uses it to create the agent's inboxes and read replies. Help: ${KEY_HELP}`,
].join('\n')

async function postshibaFlow(ctx: Ctx): Promise<Plan | null> {
  const { p, env, opts, given, path, cli } = ctx
  const problems: string[] = []
  const keyName = setupKeyName(given, DEFAULT_READ_KEY_ENV, problems)
  const apiUrl = postshibaApi({ apiUrl: opts.flags?.apiUrl || opts.apiUrl }, given)
  if (!safeApiUrl(apiUrl)) problems.push(`The PostShiba API must be an https:// URL (plain http only to this machine), not ${apiUrl}`)
  if (problems.length) {
    for (const x of problems) p.fail(x)
    return stopped(ctx)
  }
  const client = new PostShiba(apiUrl)
  let full = ''
  let teams: { id: string; name: string }[] = []
  let hint = SIGN_UP
  for (;;) {
    full = await ctx.need(keyName, 'PostShiba full-access key:', hint)
    hint = 'Enter the Full access key again (API keys → Create API key → Access: Full access).'
    try {
      teams = await client.listTeams(full)
      break
    } catch (e: any) {
      const src = ctx.typed[keyName] ? 'typed' : sourceOf(keyName, given, path)
      if (e?.status === 403) p.fail('That\'s a send-only key. Use a Full access key (API keys → Create API key → Access: Full access).')
      else p.fail(`That key doesn't work: ${e?.message || e}`)
      if (errorKind(e) === 'unavailable' || NETWORK.test(e?.message || '')) {
        p.write(`  Can't reach PostShiba at ${apiUrl}. Check your internet connection.\n`)
        if ((await p.select('What do you want to do?', [{ label: 'Try again', value: 'again' }, { label: 'Stop here', value: 'stop' }])) === 'stop') return stopped(ctx)
        continue
      }
      if (src === 'env') {
        p.write(`  The key comes from ${keyName} in your environment, which wins over ${secretsPath(path)}. Fix or unset it there, then run setup again.\n`)
        return stopped(ctx)
      }
      if (src === 'file') {
        p.write(`  The key comes from ${secretsPath(path)} (${keyName}).\n`)
        if ((await p.select('What do you want to do?', [{ label: 'Enter the key again', value: 'retype' }, { label: 'Stop here', value: 'stop' }])) === 'stop') return stopped(ctx)
      }
      delete ctx.typed[keyName]
      delete env[keyName]
    }
  }
  if (teams.length === 0) {
    p.fail('This key has no PostShiba team.')
    return stopped(ctx)
  }
  if (!env[DEFAULT_SEND_KEY_ENV]) {
    const send = await ctx.need(DEFAULT_SEND_KEY_ENV, `PostShiba send-only key${p.paint('2', ' (Enter to use the full-access key)')}:`,
      'Optional but safer: a Send only key (API keys → Create API key → Send only). It can send mail but not read it.', true)
    if (!send || send === full) {
      ctx.typed[DEFAULT_SEND_KEY_ENV] = full
      env[DEFAULT_SEND_KEY_ENV] = full
      p.write(`  ${p.paint('2', 'Sending with the full-access key. It can read mail too, so a Send only key is safer.')}\n`)
    }
  }
  const teamId = teams.length === 1
    ? teams[0].id
    : await p.select('Which team?', teams.map((t) => ({ label: t.name, value: t.id, note: t.id })), 'This key has access to more than one team.')
  if (teams.length === 1) {
    p.write('\n')
    p.ok(`Team: ${teams[0].name}`)
  }

  // Domains come from PostShiba, so the user picks one, or setup adds a new one.
  const domains = await client.listSendingDomains(full, teamId).catch(() => null)
  const hosts = (await client.listInboxes(full, teamId).catch(() => [])).map((i) => (i.host || i.address.split('@')[1] || '').toLowerCase()).filter(Boolean)
  const known = new Map<string, SendingDomain | null>()
  for (const d of domains || []) known.set(d.name.toLowerCase(), d)
  for (const h of hosts) if (!known.has(h)) known.set(h, null)
  const NEW = '\0new'
  let suggest: string | undefined
  let domain: string
  for (;;) {
    let picked = !suggest && known.size
      ? await p.select('Which domain?', [
        ...[...known.entries()].map(([name, d]) => ({ label: name, value: name, note: d?.sending_allowed === false ? 'not verified' : undefined })),
        ...(domains ? [{ label: 'Add a new domain', value: NEW, note: 'setup adds it and shows the DNS records' }] : []),
      ], 'Your agent\'s addresses go on this domain, e.g. agent@<domain>.')
      : NEW
    if (picked === NEW) {
      if (!known.size && !suggest) p.write('\nYour PostShiba team has no domain yet, so setup adds one.\n')
      const name = await askDomain(p, 'New domain:', {
        def: suggest,
        hint: 'A domain you own, or a subdomain like agents.example.com. A subdomain keeps the agent\'s mail separate from yours. You\'ll add a few DNS records next.',
      })
      suggest = undefined
      if (domains && !known.get(name)) {
        try {
          known.set(name, await p.step(`Added ${name} to PostShiba`, () => client.createSendingDomain(full, teamId, name)))
          ctx.added.push(name)
        } catch {
          p.write('  Add the domain in PostShiba (Domains → Add domain). Then run setup again.\n')
          return stopped(ctx)
        }
      }
      picked = name
    }
    domain = picked
    // Replies reach the inboxes only with PostShiba's MX record on the domain, and that
    // record takes the mail of every other address on it too.
    const others = await otherMailServers(domain, opts.mxLookup)
    if (!others.length) break
    const service = cf.mailService(others)
    p.warn(`${domain} currently gets its mail through ${service} (${others.join(', ')}).`)
    p.write(`  The agent's inboxes need an MX record for PostShiba on ${domain}. That sends all mail for ${domain} to PostShiba instead of ${service}.\n  A subdomain like inbox.${domain} leaves your existing mail alone.\n`)
    if (await p.confirm(`Move all mail for ${domain} to PostShiba?`, false)) break
    suggest = `inbox.${domain}`
  }
  const picked = known.get(domain)
  if (picked && picked.sending_allowed === false) {
    const go = await domainDns(ctx, client, full, picked)
    if (!go) return null
  }
  const name = await ctx.name(domain)
  const allow = await ctx.allow()
  return {
    input: {
      provider: 'postshiba', teamId, domain, allow, name,
      ...(apiUrl !== DEFAULT_API_URL ? { apiUrl } : {}),
      ...(opts.flags?.tenant ? { tenant: opts.flags.tenant } : {}),
    },
  }
}

async function cloudflareFlow(ctx: Ctx): Promise<Plan | null> {
  const { p, env, opts, path } = ctx
  const how = await p.select('Deploy the Worker now?', [
    { label: 'Yes, deploy it for me', value: 'deploy', note: 'about 2 minutes' },
    { label: 'It\'s already deployed', value: 'have', note: 'on this account, from any machine' },
  ], [
    'The Worker is a small program on your Cloudflare account. It receives mail, keeps it for 7 days, and sends your agent\'s mail.',
    'One Worker per account is enough. On a second machine, pick "It\'s already deployed" and use the token from the first machine\'s config.secrets.json.',
  ].join('\n'))
  if (how === 'have') {
    const domain = await askDomain(p, 'Mail domain:', { hint: 'The domain (or subdomain) that Email Routing sends to the Worker.' })
    const name = await ctx.name(domain)
    const allow = await ctx.allow()
    const url = await p.ask('Worker URL:', { check: urlCheck, hint: 'For example https://clankerinbox.example.com.' })
    await ctx.need(DEFAULT_CF_TOKEN_ENV, 'Worker token:', 'The Worker\'s API_TOKEN. It\'s CLANKERINBOX_CF_TOKEN in config.secrets.json on the machine that deployed it, or whatever you set with `wrangler secret put API_TOKEN`.')
    return { input: { provider: 'cloudflare', url, domain, allow, tokenEnv: DEFAULT_CF_TOKEN_ENV, name } }
  }
  const cfa = await cloudflareLogin(ctx, join(dirname(path), 'worker'))
  if (!cfa) return null
  const { zone } = cfa
  const mail = await pickMailDomain(p, zone.name, opts.mxLookup)
  if (!mail) return null
  const mailDomain = mail.name
  const name = await ctx.name(mailDomain)
  const allow = await ctx.allow()
  const sending = await sendingMode(p, cfa, zone, allow)
  if (!sending) return null
  const addresses = [`${name}@${mailDomain}`, `signup@${mailDomain}`]
  const plan = await planDeploy(ctx, cfa, mailDomain, addresses, allow, sending, mail)
  if (!plan) return null
  const deployed = await deployWorker(ctx, cfa, plan, mailDomain, allow, sending)
  if (!deployed) return null
  const { worker, url, token, waiting } = deployed
  ctx.generated[DEFAULT_CF_TOKEN_ENV] = token
  env[DEFAULT_CF_TOKEN_ENV] = token
  return {
    input: { provider: 'cloudflare', url, domain: mailDomain, allow, tokenEnv: DEFAULT_CF_TOKEN_ENV, name, worker },
    // After the config and the token are saved: the long waits, which Ctrl+C may stop.
    after: async (config) => {
      const all = Object.values(config.inboxes).map((i) => i.address)
      const dash = `https://dash.cloudflare.com/${cfa.account.id}/${zone.name}/email/routing`
      const link = (sub: string) => p.paint('1', `${dash}/${sub}`)
      const step = async (label: string, fn: () => Promise<unknown>, fix: string, made?: string) => {
        try {
          await p.step(label, fn)
          if (made) ctx.made.push(made)
        } catch (e: any) {
          const hint = cf.permissionHint(e)
          ctx.problems.push({ what: label, fix: hint ? `${fix}\n  Or: ${hint}, then run setup again.` : fix })
        }
      }
      const online = opts.workerOnline || cf.waitOnline
      // A new custom domain needs a certificate first; the checks after this need the Worker.
      await step('The Worker is online (a new certificate can take a few minutes)', () => online(url, token),
        `The Worker at ${url} isn't answering yet. A new certificate can take a few more minutes. Then run: ${ctx.cli} check`)
      await step(`Email Routing on ${mailDomain}`, () => cf.startRouting(cfa.run, cfa.api, zone, mailDomain),
        `${mailDomain === zone.name ? 'Turn on Email Routing' : `Add the subdomain ${mailDomain}`} at ${link('settings')}`,
        `Email Routing on ${mailDomain}`)
      await step(`Mail for ${all.join(' and ')} goes to the Worker`, () => cf.addRules(cfa.run, cfa.api, zone, all, worker, plan.replaceRules),
        `Route each address to the Worker "${worker}" at ${link('routes')}`, `the routing rules for ${all.join(', ')}`)
      await step(`Subaddressing on ${zone.name} (signup+<tag>@ goes to signup@)`, () => cf.enableSubaddressing(cfa.api, zone),
        `Turn on "Subaddressing" at ${link('settings')}. Until then, codes sent to signup+<tag>@${mailDomain} won't arrive.`)
      if (waiting.length) {
        const left = await waitForClicks(p, cfa.api, cfa.account.id, waiting, opts.verifyWait)
        for (const a of left) {
          ctx.problems.push({ what: `${a} is not verified`, fix: `Click "Verify email address" in Cloudflare's mail to ${a} (check spam). The agent can't send to ${a} until then. Then run: ${ctx.cli} check` })
        }
      }
    },
  }
}

// The agent gets its addresses on a subdomain by default. Then the mail of the domain does
// not change. If the name already gets mail from other servers, setup names that service and
// asks before it replaces their MX records.
async function pickMailDomain(p: Prompter, zone: string, lookup?: (name: string) => Promise<{ exchange: string; priority: number }[]>) {
  for (;;) {
    const OTHER = '\0other'
    let name = await p.select('Which domain for the agent\'s addresses?', [
      { label: `mail.${zone}`, value: `mail.${zone}`, note: `recommended, leaves the mail of ${zone} alone` },
      { label: zone, value: zone, note: `Cloudflare takes over all mail for ${zone}` },
      { label: 'Another subdomain', value: OTHER },
    ], `For example agent@mail.${zone}.`)
    if (name === OTHER) {
      name = await askDomain(p, 'Subdomain:', {
        def: `agents.${zone}`,
        check: (v) => (v.endsWith(`.${zone}`) ? null : `Must end with .${zone}.`),
      })
    }
    const mx = await cf.otherMx(name, lookup)
    if (!mx.length) return { name, mx, service: '' }
    const service = cf.mailService(mx)
    p.warn(`${name} currently gets its mail through ${service} (${mx.join(', ')}).`)
    p.write(`  Email Routing replaces these MX records, so all mail for ${name} goes to Cloudflare instead of ${service}.\n`)
    if (await p.confirm(`Replace the MX records of ${name}?`, false)) return { name, mx, service }
  }
}

interface CloudflareAccess { run: cf.Wrangler; api: cf.Api; dir: string; account: cf.Account; zone: cf.Zone }

// Logs in with wrangler (in a browser, or with a code on SSH), selects the account and the
// domain. A failed login can be tried again; an account without a usable domain goes back to
// the account choice. This step does not change the account.
async function cloudflareLogin(ctx: Ctx, dir: string): Promise<CloudflareAccess | null> {
  const { p, env, opts } = ctx
  const runEnv: Env = { ...env }
  const run: cf.Wrangler = (args, o) => cf.wrangler(dir, runEnv)(args, o)
  const api = cf.cloudflareApi(run, cf.apiBase(env, opts.cloudflareApi))
  const unchanged = () => p.write('\nNothing on your account was changed.\n')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  p.write('\n')
  try {
    await p.step('Wrangler (Cloudflare\'s CLI)', async () => {
      const r = await run(['--version'])
      if (r.code === 127) throw new Error(`${cf.wranglerCommand(env)[0]} won't start. Install Node.js from https://nodejs.org (or fix CLANKERINBOX_WRANGLER), then run setup again.`)
      if (r.code !== 0) throw new Error(cf.tail(r))
    })
    let accounts = await cf.whoami(run)
    while (!accounts) {
      const remote = !!(env.SSH_CONNECTION || env.SSH_TTY) || (process.platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY)
      const device = remote && await cf.supportsDevice(run)
      p.write(`\n${p.paint('1', 'Log in to Cloudflare.')} ${device ? 'Open the link below on any device and enter the code.' : remote ? 'Open the link below in a browser and click Allow.' : 'Your browser will open. Click Allow.'}\n\n`)
      await run(['login', ...(device ? ['--device'] : [])], { inherit: true })
      p.write('\n')
      accounts = await cf.whoami(run)
      if (accounts) break
      p.fail('Not logged in to Cloudflare.')
      p.write(`  Setup ran: ${cf.loginCommand(device)}${remote && !device ? '. This wrangler can\'t log in with a code. Update it, or log in on a machine with a browser' : ''}.\n`)
      const what = await p.select('What do you want to do?', [{ label: 'Try again', value: 'again' }, { label: 'Stop here', value: 'stop' }])
      if (what === 'stop') {
        unchanged()
        return null
      }
    }
    if (!accounts.length) throw new Error('Your Cloudflare login has no account.')
    for (;;) {
      let account = accounts[0]
      if (accounts.length > 1) {
        const id = await p.select('Which Cloudflare account?', accounts.map((a) => ({ label: a.name, value: a.id, note: a.id })), 'Pick the one that has your domain.')
        account = accounts.find((a) => a.id === id)!
      }
      runEnv.CLOUDFLARE_ACCOUNT_ID = account.id
      p.ok(`Logged in to Cloudflare: ${account.name}`)
      const zones = await p.step('Your domains on Cloudflare', () => cf.listZones(api, account.id))
      const back = accounts.length > 1 ? [{ label: 'Select another account', value: 'again' }] : [{ label: 'Check again', value: 'again' }]
      if (!zones.length) {
        p.fail('This Cloudflare account has no domain.')
        p.write(`  Add a domain at ${p.paint('1', `https://dash.cloudflare.com/${account.id}/add-site`)}.\n`)
        if ((await p.select('What do you want to do?', [...back, { label: 'Stop here', value: 'stop' }])) === 'stop') {
          unchanged()
          return null
        }
        continue
      }
      const zoneName = await p.select('Which domain?', zones.map((z) => ({ label: z.name, value: z.name, note: z.status !== 'active' ? `${z.status}: not active yet` : undefined })),
        'The agent\'s mail and the Worker go on this domain.')
      const zone = zones.find((z) => z.name === zoneName)!
      if (zone.status === 'active') return { run, api, dir, account, zone }
      p.fail(`${zone.name} is not active on Cloudflare yet (status: ${zone.status}).`)
      p.write(`  Cloudflare activates a domain once its name servers point to the ones shown at ${p.paint('1', `https://dash.cloudflare.com/${account.id}/${zone.name}`)}. That can take a few hours.\n`)
      const what = await p.select('What do you want to do?', [
        { label: accounts.length > 1 ? 'Select another account or domain' : 'Select another domain', value: 'again' },
        { label: 'Stop here', value: 'stop' },
      ])
      if (what === 'stop') {
        unchanged()
        return null
      }
    }
  } catch (e) {
    if (!(e as any)?.shown) p.fail((e as Error)?.message || String(e))
    const hint = cf.permissionHint(e)
    if (hint) p.write(`  ${hint}.\n`)
    unchanged()
    return null
  }
}

type Sending = 'all' | 'verified'

// Email Sending to all addresses needs the Workers Paid plan. On the free plan, the Worker
// can send only to addresses that the user verifies. For an agent that asks its owner, this
// is sufficient. Returns null if the user stops. A refusal that is not about the plan is a
// missing permission of the login, and says so.
async function sendingMode(p: Prompter, cfa: CloudflareAccess, zone: cf.Zone, allow: string[]): Promise<Sending | null> {
  const plans = `https://dash.cloudflare.com/${cfa.account.id}/workers/plans`
  for (;;) {
    let plan: 'all' | 'free'
    try {
      plan = await p.step('Your Cloudflare plan', () => cf.sendingPlan(cfa.api, zone.id))
    } catch (e: any) {
      if (e instanceof cf.PermissionError) p.write(`  ${e.message}.\n`)
      p.write('Nothing on your account was changed.\n')
      return null
    }
    if (plan === 'all') return 'all'
    p.warn('Your account is on Workers Free. Sending to any address needs Workers Paid ($5 a month).')
    const how = await p.select('Who can the agent email?', [
      { label: 'Only the people who answer', value: 'verified', note: `free: ${allow.join(', ')}` },
      { label: 'I have Workers Paid now', value: 'again', note: 'check again' },
      { label: 'Stop here', value: 'stop' },
    ], [
      'On the free plan the agent can only email addresses you verify. Cloudflare sends each one a verification link.',
      `Upgrade to Workers Paid at ${p.paint('1', plans)}`,
    ].join('\n'))
    if (how === 'stop') {
      p.write('Nothing on your account was changed.\n')
      return null
    }
    if (how === 'verified') return 'verified'
  }
}

interface DeployPlan { worker: string; host: string; keepToken: string | null; replaceRules: Set<string>; db: boolean }

// The next host name that is not in use, for a Worker that cannot have its first choice.
async function askHost(p: Prompter, cfa: CloudflareAccess, worker: string, taken: string): Promise<string> {
  const base = taken.slice(0, taken.indexOf('.'))
  const stem = base.replace(/\d+$/, '')
  const n = Number(base.slice(stem.length)) || 1
  return askDomain(p, 'Worker host name:', {
    def: `${stem}${n + 1}.${cfa.zone.name}`,
    hint: `The Worker "${worker}" gets its own host name on ${cfa.zone.name}. Setup adds its DNS record and certificate.`,
    check: (v) => (v.endsWith(`.${cfa.zone.name}`) ? null : `Must end with .${cfa.zone.name}.`),
  })
}

// Reads what is on the account (the database, a Worker with the name, the host name, the
// routing rules), settles each conflict with the user, then lists every change and asks.
// Returns null when the user stops; nothing is changed until then.
async function planDeploy(ctx: Ctx, cfa: CloudflareAccess, mailDomain: string, addresses: string[], allow: string[], sending: Sending, mail: { mx: string[]; service: string }): Promise<DeployPlan | null> {
  const { p, env, opts } = ctx
  const { run, api, account, zone } = cfa
  const tokenCheck = opts.tokenCheck || cf.tokenWorks
  let worker = cf.WORKER_NAME
  let host = `${worker}.${zone.name}`
  let keepToken: string | null = null
  let decided = false
  for (;;) {
    let facts: { db: boolean; exists: boolean; holder: string | null; rules: cf.Rule[]; domain: boolean | null; routing: { on: boolean; subaddress: boolean } | null }
    try {
      facts = await p.step('What is on your account', async () => ({
        db: !!(await cf.databaseId(run, worker)),
        exists: await cf.workerExists(api, account.id, worker),
        holder: await cf.hostHolder(api, account.id, zone, host, worker),
        rules: await cf.routingRules(api, zone.id),
        domain: await cf.hostOfWorker(api, account.id, host, worker).catch(() => null),
        routing: await cf.routingState(api, zone, mailDomain),
      }))
    } catch (e: any) {
      const hint = cf.permissionHint(e)
      if (hint) p.write(`  ${hint}.\n`)
      p.write('Nothing on your account was changed.\n')
      return null
    }
    if (facts.holder) {
      p.warn(`https://${host} is taken by ${facts.holder}.`)
      host = await askHost(p, cfa, worker, host)
      continue
    }
    if (facts.exists && !decided) {
      const saved = env[DEFAULT_CF_TOKEN_ENV]
      if (saved && (await tokenCheck(`https://${host}`, saved)) === true) {
        keepToken = saved
        decided = true
        p.ok(`The Worker "${worker}" already exists and the saved token works, so setup keeps it.`)
      } else {
        p.warn(`A Worker named "${worker}" already exists on this account.`)
        p.write('  A new token cuts off every other machine that uses this Worker until it gets the new token.\n')
        const what = await p.select('What do you want to do?', [
          { label: 'Keep its token', value: 'keep', note: 'paste it from config.secrets.json of a machine that uses it' },
          { label: 'Give it a new token', value: 'replace', note: 'other machines that use it stop working' },
          { label: 'Use another name', value: 'rename', note: 'a second Worker next to it' },
          { label: 'Stop here', value: 'stop' },
        ])
        if (what === 'stop') {
          p.write('Nothing on your account was changed.\n')
          return null
        }
        if (what === 'rename') {
          worker = (await p.ask('New Worker name:', {
            def: `${cf.WORKER_NAME}2`,
            check: (v) => (/^[a-z0-9][a-z0-9-]{0,62}$/.test(v) ? null : 'Use lowercase letters, digits and "-".'),
          })).toLowerCase()
          host = `${worker}.${zone.name}`
          continue
        }
        if (what === 'keep') {
          const token = await p.secret('Worker token:', { hint: 'CLANKERINBOX_CF_TOKEN in config.secrets.json on a machine that uses this Worker.' })
          const works = await tokenCheck(`https://${host}`, token)
          if (works === false) {
            p.fail('The Worker rejected this token.')
            continue
          }
          if (works === null) p.warn(`The Worker at https://${host} didn't answer, so setup checks the token after deploying.`)
          else p.ok('The Worker accepts this token.')
          keepToken = token
        }
        decided = true
      }
    }
    const conflicts = addresses.map((a) => ({ a, rule: cf.ruleFor(facts.rules, a) })).filter((x) => x.rule && !cf.sendsToWorker(x.rule, worker))
    const sender = `clankerinbox@${mailDomain}`
    // What is there already stays as it is: each line says so, or that it is new. Nothing is
    // said when the login could not read it.
    const mark = (there: boolean | null | undefined) => (there == null ? '' : there ? ' (exists: kept)' : ' (new)')
    const lines = [
      `Setup will make these changes on your Cloudflare account "${account.name}":`,
      `  - The D1 database "${worker}" for the mail${facts.db ? ' (exists: reused)' : ''}.`,
      `  - The Worker "${worker}" at https://${host}${facts.exists ? `. It already exists: setup replaces its code and ${keepToken ? 'keeps its token' : 'gives it a new token'}` : ', with a new secret token'}.`,
      `  - A DNS record and a certificate for ${host}, the Worker's custom domain${mark(facts.domain)}.`,
      sending === 'all'
        ? `  - Email Sending on ${mailDomain}. The Worker can send only as ${sender}.`
        : allow.length > 1
          ? `  - The destination addresses ${allow.join(', ')}: the Worker sends only to them.\n    It sends as ${sender}.\n    Cloudflare mails each one a verification link, unless it's already verified.`
          : `  - The destination address ${allow[0]}: the Worker sends only to it.\n    It sends as ${sender}.\n    Cloudflare mails it a verification link, unless it's already verified.`,
      `  - Email Routing on ${mailDomain}${mark(facts.routing?.on)}, with a routing rule to the Worker for each address:`,
      ...addresses.map((a) => {
        const c = conflicts.find((x) => x.a === a)
        return `      ${a}  ${c ? `(replaces its rule, which ${cf.describeRule(c.rule!)})` : mark(cf.sendsToWorker(cf.ruleFor(facts.rules, a), worker)).trim()}`
      }),
      `  - Subaddressing on ${zone.name}${mark(facts.routing?.subaddress)}: mail to name+tag@ goes to the rule of name@.`,
    ]
    p.hint(lines.join('\n'))
    if (mail.mx.length) {
      p.warn(`The MX records of ${mailDomain} (${mail.service}: ${mail.mx.join(', ')}) will be replaced. All mail for ${mailDomain} then stops reaching ${mail.service}.`)
    }
    for (const c of conflicts) p.warn(`The rule for ${c.a} currently ${cf.describeRule(c.rule!)}. Setup changes it to send the mail to the Worker.`)
    // A new token was picked from the menu just above, so it is not asked about twice.
    const risky = mail.mx.length > 0 || conflicts.length > 0
    if (!(await p.confirm('Make these changes?', !risky))) {
      p.write('Nothing on your account was changed.\n')
      return null
    }
    return { worker, host, keepToken, replaceRules: new Set(conflicts.map((c) => c.a.toLowerCase())), db: facts.db }
  }
}

// Database, sending, deploy, token. Returns null if a step fails, after it says what now
// exists on the account and what to do.
async function deployWorker(ctx: Ctx, cfa: CloudflareAccess, plan: DeployPlan, mailDomain: string, allow: string[], sending: Sending) {
  const { p } = ctx
  const { run, api, dir, account, zone } = cfa
  const { worker } = plan
  let host = plan.host
  const sender = `clankerinbox@${mailDomain}`
  const waiting: string[] = []
  p.write('\n')
  try {
    const db = await p.step(`Database "${worker}"`, () => cf.ensureDatabase(run, worker))
    if (!plan.db) ctx.made.push(`the D1 database "${worker}"`)
    cf.writeWorker(dir, db, sender, host, worker)
    await p.step('Database tables', () => cf.applySchema(run, worker))
    if (sending === 'all') {
      try {
        await p.step(`Email Sending on ${mailDomain}`, () => cf.enableSending(run, mailDomain))
        ctx.made.push(`Email Sending on ${mailDomain}`)
      } catch {
        ctx.problems.push({ what: `Email Sending on ${mailDomain}`, fix: 'Run setup again. The agent can\'t send mail until Email Sending is on.' })
      }
    } else {
      for (const a of allow) {
        try {
          const done = await p.step(`Destination address ${a}`, () => cf.addDestination(api, account.id, a))
          ctx.made.push(`the destination address ${a}`)
          if (!done) waiting.push(a)
        } catch (e: any) {
          ctx.problems.push({ what: `The destination address ${a}`, fix: `Add ${a} under "Destination addresses" at ${p.paint('1', `https://dash.cloudflare.com/${account.id}/${zone.name}/email/routing`)}${cf.permissionHint(e) ? ` (${cf.permissionHint(e)})` : ''}` })
        }
      }
    }
    let url = ''
    for (;;) {
      try {
        url = await p.step(`Worker "${worker}" deployed at ${host}`, () => cf.deploy(run, host))
        break
      } catch (e: any) {
        if (!cf.hostTaken(e?.message || '')) throw e
        p.write(`  ${host} is taken. Pick another host name for the Worker.\n`)
        host = await askHost(p, cfa, worker, host)
        cf.writeWorker(dir, db, sender, host, worker)
      }
    }
    ctx.made.push(`the Worker "${worker}" at https://${host}, with its DNS record and certificate`)
    const token = plan.keepToken || await p.step('Secret token set', () => cf.setToken(run))
    return { url, token, waiting, worker, host }
  } catch (e) {
    if (!(e as any)?.shown) p.fail((e as Error)?.message || String(e))
    const hint = cf.permissionHint(e)
    if (hint) p.write(`  ${hint}.\n`)
    p.write(`\nThe config was not saved. Fix that, then run setup again. It reuses what's already there.\n`)
    nowOnAccount(p, ctx)
    return null
  }
}

// What setup made on the account in this run, so a person who stops knows what is there.
function nowOnAccount(p: Prompter, ctx: Ctx): void {
  if (!ctx.made.length) {
    p.write('Nothing on your account was changed.\n')
    return
  }
  p.write(`Created on your Cloudflare account (to remove these, see "Remove the Worker" in the README):\n${ctx.made.map((m) => `  - ${m}`).join('\n')}\n`)
}

// Waits for the click on the link in each verification mail from Cloudflare, for all
// addresses at once. In a terminal, Enter goes on without the click. Returns the addresses
// that are still not verified.
export async function waitForClicks(p: Prompter, api: cf.Api, accountId: string, addresses: string[], wait = { timeoutMs: 15 * 60_000, intervalMs: 3000 }): Promise<string[]> {
  let left = [...addresses]
  p.write(`\n${p.paint('1', `Open Cloudflare's mail to ${left.join(', ')} and click "Verify email address"${left.length > 1 ? ' in each' : ''}.`)}\n`)
  if (p.tty) p.write(`${p.paint('2', 'Press Enter to continue and verify later.')}\n`)
  const key = p.onEnter()
  const spin = p.spin('Waiting for the click')
  const end = Date.now() + wait.timeoutMs
  let why = ''
  try {
    for (;;) {
      const still: string[] = []
      for (const a of left) if (!(await cf.destinationVerified(api, accountId, a).catch(() => false))) still.push(a)
      left = still
      if (!left.length) break
      if (Date.now() > end) {
        why = `no click after ${Math.round(wait.timeoutMs / 60_000) || 1} minutes`
        break
      }
      const next = await Promise.race([new Promise((r) => setTimeout(() => r('tick'), wait.intervalMs)), key.pressed])
      if (next === 'enter') {
        why = 'you chose to verify later'
        break
      }
    }
  } finally {
    spin.stop()
    key.stop()
  }
  const done = addresses.filter((a) => !left.includes(a))
  if (done.length) p.ok(`${done.join(', ')} ${done.length > 1 ? 'are' : 'is'} verified`)
  if (left.length) p.warn(`Not verified yet: ${left.join(', ')} (${why})`)
  return left
}

export function dnsTable(rows: string[][]): string {
  const all = [['Type', 'Name', 'Value'], ...rows]
  const w = [0, 1].map((c) => Math.max(...all.map((r) => r[c].length)))
  return all.map((r) => `    ${r[0].padEnd(w[0])}  ${r[1].padEnd(w[1])}  ${r[2]}`).join('\n')
}

// Lists the records a new or unverified domain needs (sending and the MX for replies),
// and runs PostShiba's DNS check on request until it passes or the user goes on. Returns
// false when the user stops (after it says what stays and how to go on).
async function domainDns(ctx: Ctx, client: PostShiba, key: string, d: SendingDomain): Promise<boolean> {
  const { p, cli } = ctx
  const mxTarget = 'inbound.postshiba.com'
  for (;;) {
    const mx = await withTimeout((ctx.opts.mxLookup || resolveMx)(d.name), 10_000).catch(() => [])
    const rows = missingRecords(d)
    if (!mx.some((r) => r.exchange.toLowerCase().replace(/\.$/, '') === mxTarget)) rows.unshift(['MX', d.name, `${mxTarget} (priority 10)`])
    p.write(`\nAdd these DNS records for ${d.name} (at Cloudflare, your registrar, or wherever its DNS lives):\n${dnsTable(rows)}\n`)
    const what = await p.select('What do you want to do?', [
      { label: 'Check the records', value: 'check' },
      { label: 'Continue, check later', value: 'later', note: 'the agent can\'t send until PostShiba verifies them' },
      { label: 'Stop here', value: 'stop' },
    ])
    if (what === 'stop') {
      p.write(`Setup stopped. Nothing was saved. The domain ${d.name}${ctx.added.includes(d.name) ? ', which setup added,' : ''} is still on PostShiba.\nTo continue: add the records above, then run ${cli} setup again and pick ${d.name}.\n`)
      return false
    }
    if (what === 'later') {
      ctx.dnsLater = true
      p.write(`  ${p.paint('2', `Continuing. Once the records are added, run: ${cli} check`)}\n`)
      return true
    }
    try {
      d = await p.step('PostShiba checks the records', async () => {
        const now = await client.verifySendingDomain(key, d.id)
        if (now.sending_allowed === false) {
          const open = [['DKIM', now.dkim_status], ['return path', now.return_path_status], ['DMARC', now.dmarc_status]].filter(([, s]) => s && s !== 'verified')
          throw Object.assign(new Error(`not all records are verified yet (${open.map(([n, s]) => `${n} ${s}`).join(', ')})`), { domain: now })
        }
        return now
      })
      return true
    } catch (e: any) {
      if (e?.domain) d = e.domain
      p.write('  New DNS records can take a few minutes to show up.\n')
    }
  }
}
