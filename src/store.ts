// Local state on the machine that runs clankerinbox: open questions, processed
// message ids and the mail log. PostShiba drops mail after its retention, so
// the log is also the long-term history.
//
// Several processes share this folder (a poll service, agents that ask and wait, parallel
// sends), so every read-modify-write runs under one lock file, and every file is replaced
// whole (a temp file, then a rename), so a reader never sees half a file.

import {
  readFileSync, appendFileSync, mkdirSync, openSync, writeSync, closeSync, unlinkSync, renameSync, readdirSync, statSync,
} from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { writeJsonAtomic } from './config.ts'
import { maskSecrets } from './safety.ts'
import { ClankerError } from './errors.ts'

export interface Answer {
  tag: string
  question: string
  answer: string
  option: string | null
  from: string
  at: string
  // The provider's id of the reply mail.
  id: string
  // The reply's Message-ID header, as `send --in-reply-to` takes it.
  messageId: string
}

export interface Question {
  tag: string
  inbox: string
  question: string
  options: string[]
  to: string[]
  subject: string
  messageId: string | null
  sentAt: string
  context?: string
  answer?: Answer
  // False until a consuming poll (or the waiter for this question) has handed the answer out.
  reported?: boolean
}

export interface LogEntry {
  at: string
  dir: 'sent' | 'received'
  inbox: string
  thread: string
  from: string
  to: string
  subject: string
  text?: string
  messageId?: string
  // Received mail: the mail service's own id of the mail, as poll printed it.
  id?: string
  // Received mail from another agent of this tool (its only marks are the ones this tool sends).
  agent?: boolean
  // Received mail that came back on a thread this machine started (its plus tag, or a request's
  // follow-up): a reply to our own mail.
  reply?: boolean
  // Received mail from another agent: its Reply-To, kept only when it is one address on the
  // domain of the checked From. `send --reply` answers there.
  replyTo?: string
}

export interface StoreOptions {
  // How long a processed id is kept: longer than the provider keeps mail, so nothing is read twice.
  processedTtlMs?: number
}

export const DEFAULT_PROCESSED_TTL_MS = 8 * 24 * 3600_000
// Answered questions stay this long, so `wait <tag>` still finds a recent answer.
const ANSWERED_KEEP_MS = 30 * 24 * 3600_000
// The log keeps the start of a long body; the provider and the mail itself hold the rest.
export const MAX_LOG_TEXT_BYTES = 64 * 1024
// A lock is held for a few milliseconds; one older than this belongs to a process that died.
const LOCK_STALE_MS = 15_000
const LOCK_WAIT_MS = 20_000
const HOUR_MS = 3600_000
// Clocks of different machines differ a bit; a log entry further in the future than this is
// a wrong clock, and it does not block sends.
const CLOCK_SKEW_MS = 60_000

const sleepCell = new Int32Array(new SharedArrayBuffer(4))
function sleepSync(ms: number): void {
  Atomics.wait(sleepCell, 0, 0, ms)
}

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (e: any) {
    return e?.code === 'EPERM'
  }
}

function stamp(t = Date.now()): string {
  return new Date(t).toISOString().replace(/[:.]/g, '-')
}

export class Store {
  dir: string
  processedTtlMs: number
  private depth = 0

  constructor(dir: string, opts: StoreOptions = {}) {
    this.dir = dir
    this.processedTtlMs = opts.processedTtlMs ?? DEFAULT_PROCESSED_TTL_MS
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
    } catch (e: any) {
      throw new ClankerError('state', `cannot make the state folder ${dir} (${e?.code || e?.message}). Set CLANKERINBOX_STATE to a folder you can write`)
    }
    this.removeOrphanTemps()
  }

  private file(name: string): string {
    return join(this.dir, name)
  }

  // A temp file left by a process that died before its rename is never read; remove it.
  private removeOrphanTemps(): void {
    let names: string[] = []
    try {
      names = readdirSync(this.dir)
    } catch {
      return
    }
    for (const n of names) {
      const m = /\.(\d+)\.tmp$/.exec(n)
      if (m && !alive(Number(m[1]))) {
        try { unlinkSync(this.file(n)) } catch { /* another process removed it */ }
      }
    }
  }

  // A file that is missing is empty. A file that cannot be read as JSON is never taken as
  // empty, since the next write would then drop every open question or processed id: it is
  // moved aside and the command stops.
  private read<T extends object>(name: string, fallback: T): T {
    const path = this.file(name)
    let raw: string
    try {
      raw = readFileSync(path, 'utf8')
    } catch (e: any) {
      if (e?.code === 'ENOENT') return fallback
      throw new ClankerError('state', `cannot read ${path} (${e?.code || e?.message})`)
    }
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      value = undefined
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as T
    const aside = `${path}.corrupt-${stamp()}`
    let moved = true
    try {
      renameSync(path, aside)
    } catch {
      moved = false
    }
    throw new ClankerError('state', moved
      ? `the state file ${path} is damaged (not a JSON object). It was moved to ${aside}. Repair it and move it back, or run the command again to start ${name} empty`
      : `the state file ${path} is damaged (not a JSON object). Repair it or move it away`)
  }

  private write(name: string, value: unknown): void {
    try {
      writeJsonAtomic(this.file(name), value)
    } catch (e: any) {
      throw new ClankerError('state', `cannot write ${this.file(name)} (${e?.code || e?.message})`)
    }
  }

  // Runs fn while this process holds the state lock. Nested calls share the lock. fn must not
  // wait for anything: the lock is meant to be held for milliseconds.
  withLock<T>(fn: () => T): T {
    if (this.depth > 0) {
      this.depth++
      try { return fn() } finally { this.depth-- }
    }
    const path = this.file('state.lock')
    this.acquire(path)
    this.depth = 1
    try {
      return fn()
    } finally {
      this.depth = 0
      try { unlinkSync(path) } catch { /* removed as stale by another process */ }
    }
  }

  private acquire(path: string): void {
    const start = Date.now()
    let delay = 2
    while (true) {
      try {
        const fd = openSync(path, 'wx', 0o600)
        try { writeSync(fd, `${process.pid} ${Date.now()}\n`) } finally { closeSync(fd) }
        return
      } catch (e: any) {
        if (e?.code !== 'EEXIST') {
          throw new ClankerError('state', `cannot write to the state folder ${this.dir} (${e?.code || e?.message}). Set CLANKERINBOX_STATE to a folder you can write`)
        }
      }
      const holder = this.lockHolder(path)
      if (holder === null) continue
      if (Date.now() - start > LOCK_WAIT_MS) {
        throw new ClankerError('state', `the state folder ${this.dir} stays locked${holder ? ` by process ${holder}` : ''}. If no clankerinbox command runs, delete ${path}`)
      }
      sleepSync(delay + Math.random() * delay)
      delay = Math.min(delay * 2, 50)
    }
  }

  // The pid that holds the lock, or null when the lock is gone or was stale and is removed now.
  private lockHolder(path: string): string | null {
    let content = ''
    let age = 0
    try {
      content = readFileSync(path, 'utf8')
      age = Date.now() - statSync(path).mtimeMs
    } catch {
      return null
    }
    // An empty file is a lock being written right now.
    const pid = Number(content.split(' ')[0])
    const stale = age > LOCK_STALE_MS || (content !== '' && !alive(pid))
    if (!stale) return content ? String(pid) : ''
    try {
      // Only the lock judged stale is removed, not one another process made since.
      if (readFileSync(path, 'utf8') === content) unlinkSync(path)
    } catch { /* gone already */ }
    return null
  }

  questions(): Record<string, Question> {
    return this.read('questions.json', {})
  }

  // Tags are lowercase; a question stored under a tag with capitals by an older version is still found.
  question(tag: string): Question | undefined {
    const all = this.questions()
    if (Object.hasOwn(all, tag)) return all[tag]
    const key = Object.keys(all).find((k) => k.toLowerCase() === tag.toLowerCase())
    return key ? all[key] : undefined
  }

  saveQuestion(q: Question): void {
    this.updateQuestions((all) => { all[q.tag] = q })
  }

  // Read, change and write questions.json under the lock, so a poll service and a waiting
  // CLI never undo each other's writes. Long-answered questions are dropped on the way.
  updateQuestions<T>(fn: (all: Record<string, Question>) => T, now = Date.now()): T {
    return this.withLock(() => {
      const all = this.questions()
      const out = fn(all)
      for (const [tag, q] of Object.entries(all)) {
        const at = Date.parse(q?.answer?.at || '')
        if (q?.answer && !Number.isNaN(at) && now - at > ANSWERED_KEEP_MS) delete all[tag]
      }
      this.write('questions.json', all)
      return out
    })
  }

  processed(): Record<string, number> {
    return this.read('processed.json', {})
  }

  markProcessed(ids: string[], now: number): void {
    if (ids.length === 0) return
    this.withLock(() => {
      const all = this.processed()
      for (const id of ids) all[id] = now
      for (const [id, t] of Object.entries(all)) if (now - t > this.processedTtlMs) delete all[id]
      this.write('processed.json', all)
    })
  }

  // Per inbox address: the receive time from which the next listing must start, so a poll
  // does not download mail it read before. See ClankerInbox.poll.
  cursor(key: string): number | undefined {
    const all = this.read<Record<string, number>>('cursors.json', {})
    return Object.hasOwn(all, key) && Number.isFinite(all[key]) ? all[key] : undefined
  }

  setCursor(key: string, at: number): void {
    this.withLock(() => {
      const all = this.read<Record<string, number>>('cursors.json', {})
      all[key] = at
      this.write('cursors.json', all)
    })
  }

  // Marks one mail processed unless another process did so first; true when this one did.
  // A mail is handed out only after its claim, so two pollers never both hand it out.
  claim(id: string, now: number): boolean {
    return this.withLock(() => {
      const all = this.processed()
      if (Object.hasOwn(all, id)) return false
      all[id] = now
      this.write('processed.json', all)
      return true
    })
  }

  // Mail ids whose code `code` has handed out, per sign-up tag, so a wait after "send the
  // code again" waits for the new mail instead of returning the old code at once.
  returnedCodes(tag: string): string[] {
    const all = this.read<Record<string, Record<string, number>>>('codes.json', {})
    return Object.hasOwn(all, tag) ? Object.keys(all[tag]) : []
  }

  markCodeReturned(tag: string, id: string, now: number): void {
    this.withLock(() => {
      const all = this.read<Record<string, Record<string, number>>>('codes.json', {})
      const ids = Object.hasOwn(all, tag) ? all[tag] : {}
      ids[id] = now
      all[tag] = ids
      for (const [t, byId] of Object.entries(all)) {
        for (const [i, at] of Object.entries(byId)) if (now - at > this.processedTtlMs) delete byId[i]
        if (!Object.keys(byId).length) delete all[t]
      }
      this.write('codes.json', all)
    })
  }

  // The send cap, counted under the lock: sends in the log and sends under way. A slot is
  // taken before the mail goes out, so parallel sends cannot pass the cap together.
  reserveSend(cap: number, now: number): string {
    return this.withLock(() => {
      const pending = this.read<Record<string, number>>('sending.json', {})
      for (const [id, t] of Object.entries(pending)) if (now - t > HOUR_MS || t > now + CLOCK_SKEW_MS) delete pending[id]
      const times = [
        ...this.entries().filter((e) => e.dir === 'sent').map((e) => Date.parse(e.at)),
        ...Object.values(pending),
      ].filter((t) => t > now - HOUR_MS && t <= now + CLOCK_SKEW_MS).sort((a, b) => a - b)
      if (times.length >= cap) {
        const next = times[times.length - cap] + HOUR_MS
        const wait = Math.max(1, Math.ceil((next - now) / 1000))
        throw new ClankerError('cap',
          `refused: the limit of ${cap} sent mails in one hour (caps.sendPerHour in the config) is reached. The next send is possible at ${new Date(next).toISOString()} (in ${wait < 120 ? `${wait} s` : `${Math.ceil(wait / 60)} min`})`,
          { retryAfter: wait })
      }
      const id = `${process.pid}-${randomBytes(4).toString('hex')}`
      pending[id] = now
      this.write('sending.json', pending)
      return id
    })
  }

  // Ends a reserved send: with a log entry when the mail went out, without one when it did not.
  finishSend(id: string, entry?: LogEntry): void {
    this.withLock(() => {
      if (entry) this.log(entry)
      const pending = this.read<Record<string, number>>('sending.json', {})
      if (!Object.hasOwn(pending, id)) return
      delete pending[id]
      this.write('sending.json', pending)
    })
  }

  // A process that waits for the answer to `tag`: while it lives, a consuming poll leaves that
  // answer to it, so the answer is handed out once.
  addWaiter(tag: string, until: number, now = Date.now()): void {
    this.withLock(() => {
      const all = this.read<Record<string, { pid: number; until: number }[]>>('waiters.json', {})
      for (const [t, list] of Object.entries(all)) {
        all[t] = (Array.isArray(list) ? list : []).filter((w) => w && w.until > now && alive(w.pid) && !(t === tag && w.pid === process.pid))
        if (!all[t].length) delete all[t]
      }
      all[tag] = [...(all[tag] || []), { pid: process.pid, until }]
      this.write('waiters.json', all)
    })
  }

  removeWaiter(tag: string): void {
    this.withLock(() => {
      const all = this.read<Record<string, { pid: number; until: number }[]>>('waiters.json', {})
      if (!Object.hasOwn(all, tag) || !Array.isArray(all[tag])) return
      all[tag] = all[tag].filter((w) => w?.pid !== process.pid)
      if (!all[tag].length) delete all[tag]
      this.write('waiters.json', all)
    })
  }

  // Tags that a live process waits for right now.
  waitedFor(now = Date.now()): Set<string> {
    const all = this.read<Record<string, { pid: number; until: number }[]>>('waiters.json', {})
    const out = new Set<string>()
    for (const [tag, list] of Object.entries(all)) {
      if (Array.isArray(list) && list.some((w) => w && w.until > now && alive(w.pid))) out.add(tag)
    }
    return out
  }

  // `secret`: sign-up mail, whose codes and link tokens are masked before they are written.
  // Questions, answers and requests keep their numbers: there they are the owner's words.
  log(entry: LogEntry, opts: { secret?: boolean } = {}): void {
    let written: LogEntry = opts.secret
      ? { ...entry, subject: maskSecrets(entry.subject || ''), ...(entry.text !== undefined ? { text: maskSecrets(entry.text) } : {}) }
      : entry
    if (written.text !== undefined && Buffer.byteLength(written.text) > MAX_LOG_TEXT_BYTES) {
      const head = Buffer.from(written.text).subarray(0, MAX_LOG_TEXT_BYTES).toString('utf8').replace(/�+$/, '')
      written = { ...written, text: head + '\n… (cut)' }
    }
    try {
      appendFileSync(this.file('log.jsonl'), JSON.stringify(written) + '\n', { mode: 0o600 })
    } catch (e: any) {
      throw new ClankerError('state', `cannot write ${this.file('log.jsonl')} (${e?.code || e?.message})`)
    }
  }

  entries(): LogEntry[] {
    let raw = ''
    try {
      raw = readFileSync(this.file('log.jsonl'), 'utf8')
    } catch {
      return []
    }
    const out: LogEntry[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line))
      } catch {
        // A torn last line from a crash is skipped, not fatal.
      }
    }
    return out
  }

  threads(): { thread: string; entries: LogEntry[] }[] {
    const map = new Map<string, LogEntry[]>()
    for (const e of this.entries()) {
      if (!map.has(e.thread)) map.set(e.thread, [])
      map.get(e.thread)!.push(e)
    }
    return [...map.entries()]
      .map(([thread, entries]) => ({ thread, entries }))
      .sort((a, b) => a.entries[a.entries.length - 1].at.localeCompare(b.entries[b.entries.length - 1].at))
  }
}
