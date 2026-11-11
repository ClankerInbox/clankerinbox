import { randomBytes } from 'node:crypto'
import { type Config, type InboxConfig, loadConfig, stateDir, inboxByMode, configPath, withSecrets } from './config.ts'
import { type Provider, type Mail, createProvider } from './provider.ts'
import {
  checkRecipients, checkSender, automation, AGENT_MAIL, isBounce, answerText, matchOption,
  extractCode, withTag, header, parseAddresses, baseAddress, domainOf, hasControlChars, safeFilename, senderDomain, cleanLine, LOOP_HEADERS,
} from './safety.ts'
import { Store, type Answer, type Question, type LogEntry } from './store.ts'
import { ClankerError, isTemporary } from './errors.ts'

export type { Answer, Question }

export interface ClankerInboxOptions {
  config?: Config
  configPath?: string
  stateDir?: string
  env?: Record<string, string | undefined>
  // A ready provider, for tests and embedders; by default it comes from the config.
  provider?: Provider
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export interface SendInput {
  to?: string | string[]
  subject: string
  text: string
  html?: string
  inbox?: string
  // Thread tag: replies come back to `<inbox>+<tag>@` with this thread id.
  tag?: string
  // Message-ID of an earlier mail (a `messageId` from send or ask). The mail goes out as a reply to
  // it (In-Reply-To, References), so mail clients show both in one conversation.
  inReplyTo?: string
  // A received mail to answer (the `id` or `messageId` poll printed). It sets the inbox, the
  // recipient, the tag, In-Reply-To and a default subject from this machine's own record of that
  // mail, so it takes none of to, tag, inReplyTo or another inbox.
  reply?: string
}

export interface SendOutput {
  messageId: string | null
  to: string[]
  replyTo: string
  tag: string
}

export interface AskInput {
  question: string
  // More text for the owner, placed under the question in the mail.
  context?: string
  options?: string[]
  to?: string | string[]
  subject?: string
  inbox?: string
  tag?: string
  inReplyTo?: string
}

export interface Unmatched {
  id: string
  inbox: string
  // The thread of the mail in the log (`log --tag <tag>`): the plus tag it was sent to, else its id.
  tag: string
  from: string
  subject: string
  text: string
  attachments: { filename: string; contentType: string; size: number | null }[]
  at: string
  // The Message-ID header, so a reply can go out In-Reply-To it (`send --reply <id>` does that).
  messageId: string
  // The mail was too large to keep whole: the text may be cut, and attachments have no body.
  truncated?: boolean
  // The mail came from another agent of this tool (it carries the marks this tool sends).
  agent?: boolean
  // The mail came back on a thread this machine started: a reply to our own mail.
  reply?: boolean
}

// A mail to a requests inbox from an allowed sender: new work, or a follow-up in a thread the
// caller started. Handed over whole, since the caller decides what it asks for.
export interface Request {
  id: string
  inbox: string
  // The thread: the plus tag of a follow-up (`<inbox>+<thread>@`), or a new tag for a new request.
  // Replies sent with this tag come back here as follow-ups.
  thread: string
  // The same as thread, under the name the other commands use.
  tag: string
  // True when the mail answers a thread the caller started (by plus tag or by its reply headers).
  followUp: boolean
  from: string
  subject: string
  // Everything the sender wrote, forwarded and quoted parts included.
  text: string
  // The text without quoted or forwarded parts: what the sender wrote in this mail.
  body: string
  attachments: { filename: string; contentType: string; size: number | null }[]
  at: string
  // The Message-ID header, so a reply can go out In-Reply-To it.
  messageId: string
  // The mail was too large to keep whole: the text may be cut, and attachments have no body.
  truncated?: boolean
  // The mail came from another agent of this tool (it carries the marks this tool sends).
  agent?: boolean
}

export interface PollResult {
  answers: Answer[]
  unmatched: Unmatched[]
  requests: Request[]
  // `from` when the sender was readable, `tag` of the address it was sent to.
  skipped: { id: string; inbox: string; reason: string; from?: string; tag?: string }[]
}

export interface CodeInput {
  tag: string
  from?: string
  inbox?: string
  windowMs?: number
}

export interface CodeResult {
  tag: string
  code?: string
  link?: string
}

const DEFAULT_SEND_PER_HOUR = 30
const DEFAULT_RECEIVE_PER_SENDER_PER_HOUR = 20
const DEFAULT_RETENTION_HOURS = 168
// Processed ids outlive the provider's retention by this much, so no mail is read twice.
const PROCESSED_MARGIN_HOURS = 24
// A listing starts this long before its cursor: a mail stored while the last listing ran can
// carry a slightly earlier time than the newest mail that listing saw.
const CURSOR_MARGIN_MS = 5 * 60_000

function cursorKey(provider: string, address: string): string {
  return `${provider}:${address.toLowerCase()}`
}

// RFC 5322 caps a header line at 998 characters.
export const MAX_SUBJECT_CHARS = 998

// A subject that fits a phone's list of mail: about 70 characters, cut at a word when it can be.
const SUBJECT_CHARS = 70
function shortSubject(line: string): string {
  if (line.length <= SUBJECT_CHARS) return line
  const cut = line.slice(0, SUBJECT_CHARS - 1)
  const space = cut.lastIndexOf(' ')
  return (space > SUBJECT_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd() + '…'
}
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024
// A wait gives one request at most this much time past its own deadline.
const REQUEST_GRACE_MS = 3000

export function newTag(prefix = ''): string {
  return prefix + randomBytes(5).toString('hex')
}

export const TAG_RULE = 'a tag has 1 to 64 characters: letters, digits, ".", "_" or "-", and starts with a letter or a digit'

// Tags become part of an address; keep them to characters every mail system accepts.
// Tags are also keys in the state files, so names every object already has are refused.
export function validTag(tag: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(tag) && !(tag.toLowerCase() in Object.prototype)
}

// Tags are case-insensitive: mail systems may change the case of an address, so every tag is
// kept and compared in lowercase.
export function normalTag(tag: string): string {
  const t = String(tag ?? '').trim().toLowerCase()
  if (!validTag(t)) throw new ClankerError('usage', `invalid tag "${tag}": ${TAG_RULE}`)
  return t
}

// The plus tag a mail was sent to, when it is one we could have made; anything else
// (`constructor`, a tag with odd characters) is treated as no tag.
function incomingTag(msg: Mail): string | null {
  const tag = typeof msg.tag === 'string' ? msg.tag.toLowerCase() : null
  return tag && validTag(tag) ? tag : null
}

// The key of a question in questions.json: the tag itself, or the same tag with capitals
// as an older version stored it.
function questionKey(all: Record<string, Question>, tag: string): string | undefined {
  if (Object.hasOwn(all, tag)) return tag
  return Object.keys(all).find((k) => k.toLowerCase() === tag)
}

// The command failed after its mail went out: the error says so and carries the tag and the
// Message-ID, so a caller does not send the mail a second time.
function sentButFailed(tag: string, messageId: string | null, e: any): ClankerError {
  return new ClankerError('state',
    `the mail was sent (tag ${tag}${messageId ? `, messageId ${messageId}` : ''}), but then this failed: ${e?.message || e}. Do not send it again`,
    { sent: true, tag, messageId, cause: e })
}

// A value the caller typed, shown in an error on one line and not too long.
function cleanForError(v: string | undefined): string {
  const s = String(v ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
  return s.length > 80 ? s.slice(0, 77) + '…' : s
}

function cleanId(id: string | null | undefined): string {
  return (id || '').trim().replace(/^<|>$/g, '').toLowerCase()
}

// A Message-ID as shown and as sent back in In-Reply-To: its case kept, as mail clients
// compare ids exactly. Only comparisons here use the lowercase cleanId.
function shownId(id: string | null | undefined): string {
  return (id || '').trim().replace(/^<|>$/g, '')
}

export class ClankerInbox {
  config: Config
  store: Store
  provider: Provider
  env: Record<string, string | undefined>
  now: () => number
  sleep: (ms: number) => Promise<void>

  constructor(opts: ClankerInboxOptions = {}) {
    const vars = opts.env || process.env
    const path = opts.configPath || configPath(vars)
    this.config = opts.config || loadConfig(path)
    // Secrets saved by setup sit next to a config read from disk.
    this.env = opts.config ? vars : withSecrets(vars, path)
    this.provider = opts.provider || createProvider(this.config, this.env)
    this.store = new Store(opts.stateDir || stateDir(this.env), { processedTtlMs: this.processedTtlMs() })
    this.now = opts.now || Date.now
    this.sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)))
  }

  // How long a processed id is kept: the provider's retention (what it reports, else the
  // config's retentionHours) plus a margin.
  private processedTtlMs(): number {
    const hours = Number(this.provider?.retentionHours) || this.config.retentionHours || DEFAULT_RETENTION_HOURS
    return Math.max(hours, 1) * 3600_000 + PROCESSED_MARGIN_HOURS * 3600_000
  }

  private ownAddresses(): string[] {
    return Object.values(this.config.inboxes).map((i) => i.address)
  }

  private receivedAt(msg: Mail): number {
    if (msg.receivedAt != null && Number.isFinite(msg.receivedAt)) return msg.receivedAt
    const d = Date.parse(header(msg, 'date'))
    return Number.isNaN(d) ? 0 : d
  }

  private iso(t = this.now()): string {
    return new Date(t).toISOString()
  }

  // Every check runs before the mail goes out, the state folder included, so a failure never
  // leaves a sent mail behind without a tag to show for it.
  async send(input: SendInput): Promise<SendOutput> {
    const out = this.prepareSend(input.reply !== undefined ? this.replyInput(input) : input)
    return this.deliver(out)
  }

  // How to answer a received mail, from this machine's own record of it (the log), never from
  // what the provider or the sender says now. The answer goes to the sender, or for another
  // agent to the Reply-To it was checked to have (one address on the domain of its From), in
  // the thread of that mail. The send list still decides who may get it.
  //
  // Another agent's reply to our own mail is not answered: two agents that each answer every
  // reply would mail each other until the caps stop them.
  private replyInput(input: SendInput): SendInput {
    const ref = cleanId(input.reply)
    if (!ref) throw new ClankerError('usage', '--reply needs the id or messageId of the mail to answer (poll prints both)')
    for (const [flag, v] of [['--to', input.to], ['--tag', input.tag], ['--in-reply-to', input.inReplyTo]] as const) {
      if (v !== undefined) throw new ClankerError('usage', `--reply sets ${flag} itself: leave ${flag} out`)
    }
    const entry = this.store.entries().reverse()
      .find((e) => e.dir === 'received' && (cleanId(e.id) === ref || cleanId(e.messageId) === ref))
    if (!entry) {
      throw new ClankerError('not_found', `this machine received no mail with the id or messageId ${cleanForError(input.reply)} (see poll or log)`)
    }
    if (input.inbox !== undefined && input.inbox !== entry.inbox) {
      throw new ClankerError('usage', `that mail came to the inbox ${entry.inbox}, so its answer goes from there: leave --inbox out`)
    }
    if (entry.agent && entry.reply) {
      throw new ClankerError('refused', 'refused: this mail is another agent\'s reply to mail from this machine, and answering it could start a mail loop between the two agents. To go on, ask a new question (ask --to …)')
    }
    const subject = cleanLine(entry.subject).trim().slice(0, MAX_SUBJECT_CHARS - 4)
    return {
      ...input,
      inbox: entry.inbox,
      to: entry.replyTo || entry.from,
      // A thread that cannot be a tag (an id of odd form) gets a new one.
      tag: validTag(String(entry.thread).toLowerCase()) ? String(entry.thread).toLowerCase() : undefined,
      ...(entry.messageId ? { inReplyTo: shownId(entry.messageId) } : {}),
      subject: input.subject ?? (/^re:/i.test(subject) ? subject : `Re: ${subject || '(no subject)'}`),
    }
  }

  private prepareSend(input: SendInput) {
    // A requests inbox sends too: its replies carry the request's thread in their Reply-To.
    const [inboxName, inbox] = inboxByMode(this.config, input.inbox ? ['answers', 'requests'] : 'answers', input.inbox)
    const to = input.to === undefined ? inbox.send.slice(0, 1) : Array.isArray(input.to) ? input.to : [input.to]
    if (to.length === 0) throw new ClankerError('config', `no recipient: use --to, or add an address to inboxes.${inboxName}.send`)
    const allowed = checkRecipients(to, inbox, this.ownAddresses())
    if (!allowed.ok) throw new ClankerError('refused', `refused: ${allowed.reason}`)
    if (!input.subject?.trim()) throw new ClankerError('usage', 'the subject is empty')
    if (input.subject.length > MAX_SUBJECT_CHARS) throw new ClankerError('usage', `the subject has ${input.subject.length} characters; the most a mail allows is ${MAX_SUBJECT_CHARS}`)
    if (!input.text?.trim()) throw new ClankerError('usage', 'the text is empty')
    const maxBody = this.config.caps?.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
    const size = Buffer.byteLength(input.text) + (input.html ? Buffer.byteLength(input.html) : 0)
    if (size > maxBody) throw new ClankerError('usage', `the text has ${size} bytes; the limit is ${maxBody} (caps.maxBodyBytes in the config)`)
    const tag = input.tag === undefined ? newTag('m') : normalTag(input.tag)
    const parent = input.inReplyTo?.trim().replace(/^<|>$/g, '')
    // Goes into a header as is, so anything but a plain id (a line break above all) is refused.
    if (parent !== undefined && !/^[^\s<>@]+@[^\s<>@]+$/.test(parent)) {
      throw new ClankerError('usage', `invalid --in-reply-to "${cleanForError(input.inReplyTo)}": it takes a Message-ID such as 1d25…@inbox.example.com (the messageId of an earlier send, ask or answer)`)
    }

    // An incoming Reply-To is never used: replies always go to our own tagged inbox,
    // and recipients only ever come from the caller, checked against the send allowlist.
    const replyTo = withTag(inbox.address, tag)
    const recipients = to.map((t) => parseAddresses(t)[0])
    const headers: Record<string, string> = { ...LOOP_HEADERS, ...(parent ? { 'In-Reply-To': `<${parent}>`, References: `<${parent}>` } : {}) }
    // Every value below ends up in a header; a line break there would add headers or recipients.
    for (const [what, value] of [
      ['the subject', input.subject], ['the from address', this.config.from], ['the Reply-To', replyTo],
      ...recipients.map((r) => ['a recipient', r]), ...Object.entries(headers).map(([k, v]) => [`the header ${k}`, v]),
    ]) {
      if (hasControlChars(value)) throw new ClankerError('refused', `refused: ${what} has a line break or another control character`)
    }
    return { inboxName, recipients, replyTo, tag, headers, input }
  }

  private async deliver(p: ReturnType<ClankerInbox['prepareSend']>): Promise<SendOutput> {
    const { inboxName, recipients, replyTo, tag, headers, input } = p
    const cap = this.config.caps?.sendPerHour ?? DEFAULT_SEND_PER_HOUR
    // Takes a slot of the hourly cap under the state lock; this also proves the state folder can be written.
    const slot = this.store.reserveSend(cap, this.now())
    let res: { messageId: string | null }
    try {
      res = await this.provider.send({
        from: this.config.from,
        to: recipients,
        replyTo,
        subject: input.subject,
        text: input.text,
        ...(input.html ? { html: input.html } : {}),
        headers,
      })
    } catch (e) {
      // After a lost connection the mail may have gone out, so its slot keeps counting.
      const unknown = e instanceof ClankerError && e.kind === 'unavailable' && e.status === undefined
      if (!unknown) try { this.store.finishSend(slot) } catch { /* the cap slot expires by itself */ }
      throw e
    }
    const messageId = res.messageId || null
    const entry: LogEntry = {
      at: this.iso(), dir: 'sent', inbox: inboxName, thread: tag,
      from: this.config.from, to: recipients.join(', '), subject: input.subject, text: input.text,
      ...(messageId ? { messageId } : {}),
    }
    try {
      this.store.finishSend(slot, entry)
    } catch (e: any) {
      throw sentButFailed(tag, messageId, e)
    }
    return { messageId, to: recipients, replyTo, tag }
  }

  async ask(input: AskInput): Promise<Question & { replyTo: string }> {
    const [inboxName, inbox] = inboxByMode(this.config, 'answers', input.inbox)
    const question = input.question?.trim()
    if (!question) throw new ClankerError('usage', 'the question is empty')
    const options = (input.options || []).map((o) => o.trim()).filter(Boolean)
    const tag = input.tag === undefined ? newTag('q') : normalTag(input.tag)
    if (this.store.question(tag)) throw new ClankerError('usage', `a question with the tag ${tag} exists already`)
    // The question is mail text and may have paragraphs, but no other control characters.
    // Only its first line can become the default subject, so no line break reaches a header.
    if (hasControlChars(question.replace(/\r?\n|\t/g, ' '))) throw new ClankerError('refused', 'refused: the question has a control character')
    const context = input.context?.replace(/\r\n?/g, '\n').trim() || undefined
    if (context && hasControlChars(context.replace(/\n|\t/g, ' '))) throw new ClankerError('refused', 'refused: the context has a control character')
    const firstLine = question.split(/\r?\n/)[0].trim()
    const subject = input.subject?.trim() || shortSubject(firstLine)
    const replyTo = withTag(inbox.address, tag)

    // A phone shows the subject and the first lines of the body: the body does not say the
    // subject again, so those lines show how to answer. A cut subject leaves the whole
    // question in the body.
    const text0 = question.replace(/\r\n?/g, '\n')
    const rest = text0 === subject ? '' : text0.startsWith(`${subject}\n`) ? text0.slice(subject.length).trim() : text0
    const lines: string[] = []
    if (rest) lines.push(rest, '')
    if (context) lines.push(context, '')
    if (options.length) {
      lines.push('Reply with a number or your own answer:', '')
      options.forEach((o, i) => lines.push(`${i + 1}. ${o}`))
      lines.push('')
    } else {
      lines.push('Reply to this email with your answer.', '')
    }
    const text = lines.join('\n')
    // Plain text only: it reads like a normal email and replies quote cleanly.
    const sent = await this.deliver(this.prepareSend({ to: input.to, subject, text, inbox: inboxName, tag, inReplyTo: input.inReplyTo }))
    const q: Question = {
      tag, inbox: inboxName, question, options, to: sent.to, subject,
      messageId: sent.messageId, sentAt: this.iso(), ...(context ? { context } : {}),
    }
    try {
      this.store.saveQuestion(q)
    } catch (e: any) {
      throw sentButFailed(tag, sent.messageId, e)
    }
    return { ...q, replyTo }
  }

  // Reads every answers inbox once. Each message is looked at once (processed ids),
  // and only mail that passes every rule can become an answer.
  //
  // A waiter (`consume: false`) stores answers but leaves them, and mail that matches
  // no question, for the next consuming poll, so a poll service on the same machine
  // still sees everything.
  //
  // An answer that a live waiter (`waitForAnswer` in any process) waits for is left to that
  // waiter, so one answer is handed out once.
  //
  // `inbox`: read only this inbox. `timeoutMs`: the most one request to the provider may take.
  // `onUnmatched`: a waiter hears of allowed mail that answers no open question, which it leaves.
  // `forTag`: the question a waiter waits for. A waiter marks refused mail as handled only when
  // it belongs to that question; other refused mail stays for the next poll to show.
  async poll(opts: { consume?: boolean; inbox?: string; timeoutMs?: number; forTag?: string; onUnmatched?: (mail: { id: string; from: string; subject: string }) => void } = {}): Promise<PollResult> {
    const consume = opts.consume !== false
    if (opts.inbox !== undefined) inboxByMode(this.config, ['answers', 'requests'], opts.inbox)
    const call = opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}
    this.store.processedTtlMs = this.processedTtlMs()
    const result: PollResult = { answers: [], unmatched: [], requests: [], skipped: [] }
    const processed = this.store.processed()
    const cap = this.config.caps?.receivePerSenderPerHour ?? DEFAULT_RECEIVE_PER_SENDER_PER_HOUR
    const hourAgo = this.now() - 3600_000
    const recent = new Map<string, number>()
    // Answers have their own count: other mail from the owner must not use up the cap that
    // lets their answers in. Each question takes one answer, so answers cannot flood.
    const recentAnswers = new Map<string, number>()
    const entries = this.store.entries()
    const questions = this.store.questions()
    // A question we sent that lands in our own inbox is never its own answer, whatever its headers say.
    const questionIds = new Set(Object.values(questions).map((q) => cleanId(q.messageId)).filter(Boolean))
    // Any other mail this machine sent that comes back to it: never read as mail from someone
    // else, so the tool cannot answer itself in a loop. Only the self-test (allowAutomated) reads it.
    const sent = entries.filter((e) => e.dir === 'sent')
    const sentIds = new Set(sent.map((e) => cleanId(e.messageId)).filter(Boolean))
    // The threads this machine started: mail that comes back on one of them is a reply to our mail.
    const ourThreads = new Set([...sent.map((e) => String(e.thread).toLowerCase()), ...Object.keys(questions).map((k) => k.toLowerCase())])
    const own = { questionIds, sentIds }
    const bump = (map: Map<string, number>, b: string) => map.set(b, (map.get(b) || 0) + 1)
    for (const e of entries) {
      if (e.dir === 'received' && Date.parse(e.at) > hourAgo) {
        bump(recent, baseAddress(e.from))
        if (Object.hasOwn(questions, e.thread)) bump(recentAnswers, baseAddress(e.from))
      }
    }

    for (const [inboxName, inbox] of Object.entries(this.config.inboxes)) {
      if (opts.inbox !== undefined && inboxName !== opts.inbox) continue
      if (inbox.mode === 'requests') {
        // Requests go to the one consuming poller; a waiter leaves them alone.
        if (consume) await this.pollRequests(inboxName, inbox, processed, recent, own, cap, result, call)
        continue
      }
      if (inbox.mode !== 'answers') continue
      const messages = await this.listFrom(inbox, processed, call)
      this.store.processedTtlMs = this.processedTtlMs()
      // Oldest first, so the first reply to a question wins.
      const fresh = messages.filter((m) => m && m.id && !Object.hasOwn(processed, m.id)).reverse()
      const done: string[] = []
      for (const msg of fresh) {
        // A waiter handles only mail of its own question; it leaves the rest to the next poll.
        const mine = () => {
          if (consume) return true
          const tag = incomingTag(msg)
          try {
            return tag === opts.forTag || (!tag && this.matchQuestion(msg)?.tag === opts.forTag)
          } catch {
            return false
          }
        }
        // `later`: not marked processed, so the next poll after the cap's hour reads it again.
        const skip = (reason: string, from?: string, later = false) => {
          if (!later && mine()) done.push(msg.id)
          const tag = incomingTag(msg)
          result.skipped.push({ id: msg.id, inbox: inboxName, reason, ...(from ? { from } : {}), ...(tag ? { tag } : {}) })
        }
        // Anyone can send a mail that trips some parser; it is skipped, never retried forever.
        try {
          if (isBounce(msg)) { skip('bounce'); continue }
          const ownReason = this.ownMail(msg, inbox, own)
          if (ownReason) { skip(ownReason); continue }
          const auto = automation(msg)
          if (auto && auto !== AGENT_MAIL && !inbox.allowAutomated) { skip(auto); continue }
          const agent = auto === AGENT_MAIL
          const verdict = checkSender(msg, inbox.allow)
          if (!verdict.ok) { skip(verdict.reason!, verdict.from); continue }
          const from = verdict.from!
          const body = answerText(msg.text, msg.html)
          if (!body) { skip(msg.truncated ? 'the mail was too large: the Worker kept only its headers and the names of its attachments' : 'empty reply', from); continue }
          const thread = this.matchQuestion(msg)
          const open = !!thread && !thread.answer
          if (open) {
            const refused = this.whoMayAnswer(thread, from, agent)
            if (refused) { skip(refused, from); continue }
          }
          if (!consume && !open) {
            if (!thread) opts.onUnmatched?.({ id: msg.id, from, subject: msg.subject || '' })
            continue
          }
          const sender = baseAddress(from)
          if (((open ? recentAnswers : recent).get(sender) || 0) >= cap) { skip('hourly cap for this sender', from, true); continue }
          const reply = !!thread || (!!incomingTag(msg) && ourThreads.has(incomingTag(msg)!))
          let replyTo: string | null = null
          if (agent && !open && !reply) {
            try {
              replyTo = await this.agentReplyTo(inbox, msg, from, call)
            } catch (e: any) {
              if (e instanceof ClankerError && e.kind === 'state') throw e
              skip(`its Reply-To could not be read, so the next poll tries again: ${e?.message || e}`, from, true)
              continue
            }
          }
          // Another poller (a poll service, a waiter) may have handed this mail out meanwhile.
          if (!this.store.claim(msg.id, this.now())) continue
          bump(recent, sender)
          if (open) bump(recentAnswers, sender)

          const at = this.iso(this.receivedAt(msg) || this.now())
          // Tags are lowercase everywhere, so a thread named after the mail's id is too.
          const logThread = thread?.tag || incomingTag(msg) || msg.id.toLowerCase()
          const messageId = shownId(header(msg, 'message-id'))
          this.store.log({
            at, dir: 'received', inbox: inboxName, thread: logThread,
            from, to: msg.to, subject: msg.subject || '', text: body, messageId: header(msg, 'message-id'),
            id: msg.id, ...(agent ? { agent: true } : {}), ...(reply ? { reply: true } : {}), ...(replyTo ? { replyTo } : {}),
          })
          if (thread && open) {
            const answer: Answer = {
              tag: thread.tag, question: thread.question, answer: body,
              option: matchOption(body, thread.options), from, at,
              id: msg.id, messageId: shownId(header(msg, 'message-id')),
            }
            // Under the lock, so an answer written by another poller in the meantime is kept.
            const stored = this.store.updateQuestions((all) => {
              const key = questionKey(all, thread.tag.toLowerCase())
              if (!key || all[key].answer) return false
              all[key] = { ...all[key], answer, reported: false }
              return true
            })
            if (stored) continue
          }
          result.unmatched.push({
            id: msg.id, inbox: inboxName, tag: logThread, from, subject: msg.subject || '', text: body,
            attachments: this.attachments(msg), at, messageId, ...(msg.truncated ? { truncated: true } : {}),
            ...(agent ? { agent: true } : {}), ...(reply ? { reply: true } : {}),
          })
        } catch (e: any) {
          // A broken state folder stops the poll; only a mail that trips a parser is skipped.
          if (e instanceof ClankerError && e.kind === 'state') throw e
          skip(`could not be read: ${e?.message || e}`)
        }
      }
      this.store.markProcessed(done, this.now())
      this.moveCursor(inbox, messages)
    }
    if (consume && Object.values(this.store.questions()).some((q) => q?.answer && q.reported === false)) {
      result.answers.push(...this.store.updateQuestions((all) => {
        const waited = this.store.waitedFor(this.now())
        const out: Answer[] = []
        for (const [key, q] of Object.entries(all)) {
          if (!q?.answer || q.reported !== false || waited.has(key.toLowerCase())) continue
          out.push(q.answer)
          all[key] = { ...q, reported: true }
        }
        return out
      }))
    }
    return result
  }

  // One requests inbox: the same sender rules as answers (allowlist, DMARC, no bounces, no robots,
  // the per-sender cap), and every mail that passes is handed over as a request.
  private async pollRequests(
    inboxName: string, inbox: InboxConfig, processed: Record<string, number>,
    recent: Map<string, number>, own: { questionIds: Set<string>; sentIds: Set<string> }, cap: number, result: PollResult, call: { timeoutMs?: number },
  ): Promise<void> {
    const messages = await this.listFrom(inbox, processed, call)
    const fresh = messages.filter((m) => m && m.id && !Object.hasOwn(processed, m.id)).reverse()
    const sent = this.store.entries().filter((e) => e.dir === 'sent' && e.inbox === inboxName)
    const threads = new Set(sent.map((e) => e.thread))
    const sentIds = new Map(sent.filter((e) => e.messageId).map((e) => [cleanId(e.messageId), e.thread]))
    const done: string[] = []
    for (const msg of fresh) {
      const skip = (reason: string, from?: string, later = false) => {
        if (!later) done.push(msg.id)
        const tag = incomingTag(msg)
        result.skipped.push({ id: msg.id, inbox: inboxName, reason, ...(from ? { from } : {}), ...(tag ? { tag } : {}) })
      }
      try {
        if (isBounce(msg)) { skip('bounce'); continue }
        const ownReason = this.ownMail(msg, inbox, own)
        if (ownReason) { skip(ownReason); continue }
        const auto = automation(msg)
        if (auto && auto !== AGENT_MAIL && !inbox.allowAutomated) { skip(auto); continue }
        const agent = auto === AGENT_MAIL
        const verdict = checkSender(msg, inbox.allow)
        if (!verdict.ok) { skip(verdict.reason!, verdict.from); continue }
        const from = verdict.from!
        const text = (msg.text || '').replace(/\r\n?/g, '\n').trim()
        // A name the sender chose is only a label for the caller, never a path to write to.
        const attachments = this.attachments(msg)
        if (!text && !attachments.length) { skip('empty mail'); continue }
        const count = recent.get(baseAddress(from)) || 0
        if (count >= cap) { skip('hourly cap for this sender', from, true); continue }

        // A follow-up only by a thread this inbox started: a made-up plus tag is a new request.
        const tag = incomingTag(msg) || ''
        const refs = [msg.inReplyTo, header(msg, 'in-reply-to'), header(msg, 'references')]
          .join(' ').split(/[\s,]+/).map(cleanId).filter(Boolean)
        const byRef = refs.map((r) => sentIds.get(r)).find(Boolean)
        const known = threads.has(tag) ? tag : byRef
        let replyTo: string | null = null
        if (agent && !known) {
          try {
            replyTo = await this.agentReplyTo(inbox, msg, from, call)
          } catch (e: any) {
            if (e instanceof ClankerError && e.kind === 'state') throw e
            skip(`its Reply-To could not be read, so the next poll tries again: ${e?.message || e}`, from, true)
            continue
          }
        }
        const thread = known || newTag('r')
        if (!this.store.claim(msg.id, this.now())) continue
        recent.set(baseAddress(from), count + 1)
        const at = this.iso(this.receivedAt(msg) || this.now())
        const messageId = shownId(header(msg, 'message-id'))
        this.store.log({
          at, dir: 'received', inbox: inboxName, thread, from, to: msg.to, subject: msg.subject || '', text, messageId,
          id: msg.id, ...(agent ? { agent: true } : {}), ...(known ? { reply: true } : {}), ...(replyTo ? { replyTo } : {}),
        })
        result.requests.push({
          id: msg.id, inbox: inboxName, thread, tag: thread, followUp: !!known, from, subject: msg.subject || '',
          text, body: answerText(text, msg.html), attachments, at, messageId, ...(msg.truncated ? { truncated: true } : {}),
          ...(agent ? { agent: true } : {}),
        })
      } catch (e: any) {
        if (e instanceof ClankerError && e.kind === 'state') throw e
        skip(`could not be read: ${e?.message || e}`)
      }
    }
    this.store.markProcessed(done, this.now())
    this.moveCursor(inbox, messages)
  }

  // The mail of an inbox from where the last listing left off. Mail read before comes back
  // unparsed, since only its id and time matter.
  private listFrom(inbox: InboxConfig, processed: Record<string, number>, call: { timeoutMs?: number }): Promise<Mail[]> {
    const since = this.store.cursor(cursorKey(this.provider.name, inbox.address))
    return this.provider.listInbound(inbox, {
      ...call,
      ...(since !== undefined ? { since: Math.max(0, since - CURSOR_MARGIN_MS) } : {}),
      known: (id) => Object.hasOwn(processed, id),
    })
  }

  // The next listing starts at the oldest mail that is still not processed (over the cap, or
  // left by a waiter for the poll service), else at the newest mail seen. Mail that arrives
  // later always has a later receive time, so nothing is passed over.
  private moveCursor(inbox: InboxConfig, messages: Mail[]): void {
    if (!messages.length || messages.some((m) => m.receivedAt == null || !Number.isFinite(m.receivedAt))) return
    const processed = this.store.processed()
    const open = messages.filter((m) => !Object.hasOwn(processed, m.id)).map((m) => m.receivedAt!)
    const at = open.length ? Math.min(...open) : Math.max(...messages.map((m) => m.receivedAt!))
    this.store.setCursor(cursorKey(this.provider.name, inbox.address), at)
  }

  // Why a mail is this machine's own, or null. A question that lands in our own inbox is never its
  // own answer. Any other mail this machine sent is never read as mail from someone else, so an
  // agent cannot answer itself in a loop, whatever From it shares with another machine; only the
  // self-test (allowAutomated) reads it.
  private ownMail(msg: Mail, inbox: InboxConfig, own: { questionIds: Set<string>; sentIds: Set<string> }): string | null {
    const id = cleanId(header(msg, 'message-id'))
    if (!id) return null
    if (own.questionIds.has(id)) return 'our own question'
    if (own.sentIds.has(id) && !inbox.allowAutomated) return 'our own mail'
    return null
  }

  // Where an answer to another agent's mail goes: its Reply-To (the tagged address of its own
  // inbox), kept only when it is one address on the domain of the checked From, so the DMARC check
  // of that domain vouches for it too. Null: the answer goes to the From.
  private async agentReplyTo(inbox: InboxConfig, msg: Mail, from: string, call: { timeoutMs?: number }): Promise<string | null> {
    const raw = header(msg, 'reply-to') || (this.provider.replyTo ? await this.provider.replyTo(inbox, msg, call) : '') || ''
    const list = parseAddresses(raw)
    if (list.length !== 1 || hasControlChars(list[0]) || domainOf(list[0]) !== domainOf(from)) return null
    return list[0]
  }

  // A name the sender chose is only a label for the caller, never a path to write to.
  private attachments(msg: Mail): Request['attachments'] {
    return (msg.attachments || []).map((a) => ({ ...a, filename: safeFilename(a.filename) }))
  }

  // The plus tag first; when a mail client dropped it, the reply headers: In-Reply-To names
  // the mail replied to, then References from its last (newest) entry back to the first, so a
  // reply to the newest question of a chain never lands on an older one.
  private matchQuestion(msg: Mail): Question | undefined {
    const questions = this.store.questions()
    const tag = incomingTag(msg)
    const key = tag ? questionKey(questions, tag) : undefined
    if (key) return questions[key]
    const ids = (v: string | null | undefined) => (v || '').split(/[\s,]+/).map(cleanId).filter(Boolean)
    const refs = [...ids(msg.inReplyTo), ...ids(header(msg, 'in-reply-to')), ...ids(header(msg, 'references')).reverse()]
    if (refs.length === 0) return undefined
    const byId = new Map(Object.values(questions).filter((q) => q.messageId).map((q) => [cleanId(q.messageId), q]))
    for (const r of refs) {
      const q = byId.get(r)
      if (q) return q
    }
    return undefined
  }

  // Why `from` may not answer this question, or null when it may: it must be someone the
  // question went to (or, for a question with no record of that, on its inbox's allowlist),
  // and the question's own inbox must allow them, whichever inbox the reply came through.
  // A question sent only to this machine's own inboxes (a self-test) has no person to wait
  // for, so there the inbox allowlist alone decides.
  //
  // Another agent (`agent`: the mail carries this tool's marks) answers from the address it sends
  // as, not from the inbox the question went to: its From may be any allowed address on the domain
  // of an address the question went to. A person's reply keeps the exact rule.
  private whoMayAnswer(q: Question, from: string, agent = false): string | null {
    const sender = baseAddress(from)
    const inbox = Object.hasOwn(this.config.inboxes, q.inbox) ? this.config.inboxes[q.inbox] : undefined
    const allow = inbox && Array.isArray(inbox.allow) ? inbox.allow.map(baseAddress) : []
    if (!allow.includes(sender)) return 'the inbox of the question does not allow this sender'
    const to = Array.isArray(q.to) ? q.to.map(baseAddress) : []
    const own = new Set(this.ownAddresses().map(baseAddress))
    if (!to.length || to.every((t) => own.has(t)) || to.includes(sender)) return null
    if (agent && to.some((t) => domainOf(t) === domainOf(sender))) return null
    return 'the question was not sent to this sender'
  }

  // `onSkipped` hears once about each mail that was refused although it was sent to this
  // question's tag or came from someone the question went to, so a waiter can say why no
  // answer arrives instead of timing out in silence.
  //
  // A failure that passes by itself (a rate limit, a 5xx, a timeout, no network) does not end
  // the wait: `onRetry` hears about it and the next check follows. When the time is up while
  // the last check failed that way, that error is thrown, since nobody knows if an answer came.
  async waitForAnswer(
    tag: string,
    opts: {
      timeoutMs?: number; intervalMs?: number
      onSkipped?: (s: PollResult['skipped'][number]) => void
      onRetry?: (e: Error, waitMs: number) => void
    } = {},
  ): Promise<(Answer & { delivered?: true }) | null> {
    tag = normalTag(tag)
    const q = this.store.question(tag)
    if (!q) throw new ClankerError('not_found', `no question with the tag ${tag}`)
    const deadline = this.now() + (opts.timeoutMs ?? 30 * 60_000)
    const interval = opts.intervalMs ?? 5000
    const askedBase = new Set((q.to || []).map(baseAddress))
    const told = new Set<string>()
    // Hand the answer out once, here: a poll in another process leaves it to this waiter. An
    // answer that a poll or an earlier wait handed out already comes back again, marked so.
    const take = (): (Answer & { delivered?: true }) | null => this.store.updateQuestions((all) => {
      const key = questionKey(all, tag)
      if (!key || !all[key].answer) return null
      if (all[key].reported === true) return { ...all[key].answer!, delivered: true }
      all[key] = { ...all[key], reported: true }
      return all[key].answer!
    })
    this.store.addWaiter(tag, deadline + 60_000)
    try {
      while (true) {
        if (this.store.question(tag)?.answer) return take()
        let failed: Error | null = null
        let pause = interval
        try {
          const res = await this.poll({ consume: false, forTag: tag, timeoutMs: this.requestTime(deadline) })
          for (const s of res.skipped) {
            const ours = s.tag === tag || (!!s.from && askedBase.has(baseAddress(s.from)))
            if (ours && !told.has(s.id)) {
              told.add(s.id)
              opts.onSkipped?.(s)
            }
          }
        } catch (e: any) {
          if (!isTemporary(e)) throw e
          failed = e
          if (e.retryAfter) pause = Math.max(interval, e.retryAfter * 1000)
        }
        if (this.store.question(tag)?.answer) return take()
        if (this.now() >= deadline) {
          if (failed) throw Object.assign(failed, { tag })
          return null
        }
        const ms = Math.min(pause, Math.max(0, deadline - this.now()))
        if (failed) opts.onRetry?.(failed, ms)
        await this.sleep(ms)
      }
    } finally {
      try { this.store.removeWaiter(tag) } catch { /* the marker expires by itself */ }
    }
  }

  // The time one request may take: never more than what is left of the wait, plus a little.
  private requestTime(deadline: number): number {
    return Math.max(1000, deadline - this.now() + REQUEST_GRACE_MS)
  }

  address(inboxName?: string): { address: string; tag: string } {
    const [, inbox] = inboxByMode(this.config, 'codes', inboxName)
    const tag = newTag('s')
    return { address: withTag(inbox.address, tag), tag }
  }

  // Never returns a body: only a code or a link from mail to this tag, from the
  // expected sender domain when given, received inside a short window.
  // `exclude`: ids of mail whose code was handed out before, which a waiter passes over.
  async code(input: CodeInput, opts: { exclude?: Set<string>; timeoutMs?: number } = {}): Promise<CodeResult | null> {
    const tag = normalTag(input.tag)
    const [inboxName, inbox] = inboxByMode(this.config, 'codes', input.inbox)
    const windowMs = input.windowMs ?? 15 * 60_000
    const since = this.now() - windowMs
    const want = input.from !== undefined ? senderDomain(input.from) : undefined
    // Only the window is asked for (with a margin for clocks that differ), not all stored mail.
    const messages = await this.provider.listInbound(inbox, {
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      since: Math.max(0, since - CURSOR_MARGIN_MS),
    })
    for (const msg of messages) {
      if (!msg || incomingTag(msg) !== tag || opts.exclude?.has(msg.id)) continue
      let verdict: ReturnType<typeof checkSender>
      let found: ReturnType<typeof extractCode>
      // A mail that trips a parser is passed over, so the next one can still bring the code.
      try {
        if (this.receivedAt(msg) < since) continue
        if (isBounce(msg)) continue
        verdict = checkSender(msg, inbox.allow)
        if (!verdict.ok) continue
        const domain = domainOf(verdict.from!).replace(/\.$/, '')
        if (want && domain !== want && !domain.endsWith('.' + want)) continue
        // A link must point at the sender's own domain too, not only come from it.
        found = extractCode(msg.subject || '', msg.text || '', { domain: want })
      } catch {
        continue
      }
      if (!found.code && !found.link) continue
      const processed = this.store.processed()
      if (!Object.hasOwn(processed, msg.id)) {
        this.store.log({
          at: this.iso(this.receivedAt(msg)), dir: 'received', inbox: inboxName, thread: tag,
          from: verdict.from!, to: msg.to, subject: msg.subject || '', messageId: header(msg, 'message-id'),
        }, { secret: true })
        this.store.markProcessed([msg.id], this.now())
      }
      this.store.markCodeReturned(tag, msg.id, this.now())
      return { tag, ...found }
    }
    return null
  }

  // Like waitForAnswer, a failure that passes by itself does not end the wait.
  async waitForCode(input: CodeInput & { timeoutMs?: number; intervalMs?: number; onRetry?: (e: Error, waitMs: number) => void }): Promise<CodeResult | null> {
    const tag = normalTag(input.tag)
    const deadline = this.now() + (input.timeoutMs ?? 180_000)
    const interval = input.intervalMs ?? 3000
    // A wait is for a code not seen yet: after "send the code again", the old one is no answer.
    const exclude = new Set(this.store.returnedCodes(tag))
    while (true) {
      let failed: Error | null = null
      let pause = interval
      try {
        const found = await this.code({ ...input, tag }, { exclude, timeoutMs: this.requestTime(deadline) })
        if (found) return found
      } catch (e: any) {
        if (!isTemporary(e)) throw e
        failed = e
        if (e.retryAfter) pause = Math.max(interval, e.retryAfter * 1000)
      }
      if (this.now() >= deadline) {
        if (failed) throw Object.assign(failed, { tag })
        return null
      }
      const ms = Math.min(pause, Math.max(0, deadline - this.now()))
      if (failed) input.onRetry?.(failed, ms)
      await this.sleep(ms)
    }
  }
}

// Module shortcuts for callers that just want one call with the default config.
export async function poll(opts: ClankerInboxOptions = {}): Promise<PollResult> {
  return new ClankerInbox(opts).poll()
}

export async function send(input: SendInput, opts: ClankerInboxOptions = {}): Promise<SendOutput> {
  return new ClankerInbox(opts).send(input)
}

export async function ask(input: AskInput, opts: ClankerInboxOptions = {}) {
  return new ClankerInbox(opts).ask(input)
}

export async function code(input: CodeInput, opts: ClankerInboxOptions = {}) {
  return new ClankerInbox(opts).code(input)
}

export type { Config, InboxConfig }
