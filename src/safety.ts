// Every rule that decides what mail goes out and what mail counts.
// Email content never authorizes an action: these checks only decide whether
// a mail is passed on as an answer or a code, never what an agent does with it.

import type { Mail } from './provider.ts'
import type { InboxConfig } from './config.ts'
import { htmlToText } from './mime.ts'

export interface Verdict {
  ok: boolean
  reason?: string
  from?: string
}

// Longer address headers are not read at all: no real From needs this much, and a
// hostile one should cost nothing to refuse.
export const MAX_ADDRESS_HEADER = 2048

const ADDRESS_SHAPE = /^[^@]+@[^@.][^@]*\.[^@]+$/

// The addresses in an address-list header, read left to right the way RFC 5322 reads it:
// a comment runs to its own `)`, a quoted string to its own `"`, and both are dropped, so
// `"a@b.com" <c@d.com>` is one address. Null when the value can be read more than one way
// (an unbalanced quote, comment or angle bracket, a quote inside a comment, a backslash
// escape, a quoted local part, a word with an @ that is no plain address), since another
// parser could then see another sender.
export function addressList(value: string): string[] | null {
  if (value.length > MAX_ADDRESS_HEADER || value.includes('\\')) return null
  let out = ''
  let angle = false
  for (let i = 0; i < value.length; i++) {
    const c = value[i]
    if (c === '"') {
      const j = value.indexOf('"', i + 1)
      if (j < 0 || value[j + 1] === '@') return null
      out += ' '
      i = j
      continue
    }
    if (c === '(') {
      let depth = 0
      let j = i
      for (; j < value.length; j++) {
        const d = value[j]
        if (d === '"') return null
        if (d === '(') depth++
        else if (d === ')' && --depth === 0) break
      }
      if (depth !== 0) return null
      out += ' '
      i = j
      continue
    }
    if (c === ')') return null
    if (c === '<') { if (angle) return null; angle = true }
    if (c === '>') { if (!angle) return null; angle = false }
    out += c
  }
  if (angle) return null
  const found: string[] = []
  for (const word of out.split(/[\s<>,;:]+/)) {
    if (!word.includes('@')) continue
    if (!ADDRESS_SHAPE.test(word)) return null
    found.push(word.toLowerCase())
  }
  return [...new Set(found)]
}

// All addresses in a header value; none when it cannot be read one way only.
export function parseAddresses(value: string | null | undefined): string[] {
  if (!value) return []
  return addressList(value) ?? []
}

// A plus tag addresses the same mailbox, so `owner+x@` and `owner@` are one sender.
export function baseAddress(address: string): string {
  const at = address.lastIndexOf('@')
  if (at < 0) return address.toLowerCase()
  const local = address.slice(0, at).toLowerCase()
  const domain = address.slice(at + 1).toLowerCase()
  return `${local.split('+')[0]}@${domain}`
}

export function plusTag(address: string): string | null {
  const local = address.slice(0, address.lastIndexOf('@'))
  const i = local.indexOf('+')
  return i < 0 ? null : local.slice(i + 1)
}

export function withTag(address: string, tag: string): string {
  const at = address.lastIndexOf('@')
  const local = address.slice(0, at).split('+')[0]
  return `${local}+${tag}@${address.slice(at + 1)}`
}

export function domainOf(address: string): string {
  return address.slice(address.lastIndexOf('@') + 1).toLowerCase()
}

export function header(msg: Mail, name: string): string {
  const v = msg.headers?.[name.toLowerCase()] ?? msg.headers?.[name]
  if (Array.isArray(v)) return v.join(', ')
  return v == null ? '' : String(v)
}

// One From address, the same one the provider saw, or nothing.
// A From that is there must be exactly one readable address: an unreadable header is never
// filled in from the provider's field.
export function singleFrom(msg: Mail): Verdict {
  const rawHeader = header(msg, 'from').trim()
  const rawField = (msg.from || '').trim()
  const fromHeader = rawHeader ? addressList(rawHeader) : []
  const fromField = rawField ? addressList(rawField) : []
  if (!fromHeader || !fromField || (rawHeader && !fromHeader.length) || (rawField && !fromField.length)) {
    return { ok: false, reason: 'From is not one readable address' }
  }
  if (fromHeader.length === 0 && fromField.length === 0) return { ok: false, reason: 'no From address' }
  if (fromHeader.length > 1 || fromField.length > 1) return { ok: false, reason: 'more than one From address' }
  const from = fromField[0] || fromHeader[0]
  if (fromHeader.length && fromField.length && fromHeader[0] !== fromField[0]) {
    return { ok: false, reason: 'From header and sender differ' }
  }
  return { ok: true, from }
}

// The DMARC result the provider vouches for; a header the sender could write is never trusted for this.
export function dmarcAligned(msg: Mail): boolean {
  const d = msg.dmarc
  return !!d && d.result === 'pass' && d.aligned === true
}

// Default deny: a mail counts only when an allowlist exists, its single From is
// on it, and DMARC passed aligned for that From.
export function checkSender(msg: Mail, allow: InboxConfig['allow']): Verdict {
  if (allow !== '*' && (!Array.isArray(allow) || allow.length === 0)) return { ok: false, reason: 'allowlist is empty' }
  const single = singleFrom(msg)
  if (!single.ok) return single
  const from = single.from!
  if (allow !== '*') {
    const allowed = allow.map(baseAddress)
    if (!allowed.includes(baseAddress(from))) return { ok: false, reason: `sender not on allowlist`, from }
  }
  if (!dmarcAligned(msg)) return { ok: false, reason: 'DMARC did not pass aligned', from }
  return { ok: true, from }
}

export function isBounce(msg: Mail): boolean {
  const from = (msg.from || header(msg, 'from')).toLowerCase()
  if (/^(mailer-daemon|postmaster)@/.test(from) || /mailer-daemon/.test(from)) return true
  const mailFrom = msg.mailFrom
  if (mailFrom === null || mailFrom === '' || mailFrom === '<>') return true
  const ct = header(msg, 'content-type').toLowerCase()
  if (ct.includes('multipart/report') || ct.includes('delivery-status')) return true
  if (header(msg, 'x-failed-recipients')) return true
  return false
}

// Mail from another robot (or from ourselves): any loop or automation mark at all.
export function isAutomated(msg: Mail): boolean {
  return automation(msg) !== null
}

export const LOOP_HEADERS: Record<string, string> = {
  'Auto-Submitted': 'auto-generated',
  'X-Loop': 'clankerinbox',
}

// The values of a header that may come more than once (`a, b`), each without its parameters
// (`auto-generated; x=y` is `auto-generated`), in lowercase.
function tokens(msg: Mail, name: string): string[] {
  return header(msg, name).split(',').map((v) => v.split(';')[0].trim().toLowerCase()).filter(Boolean)
}

// The kind of mail another agent of this tool sends.
export const AGENT_MAIL = 'agent'

// What kind of robot sent a mail. null: no mark at all (a person). AGENT_MAIL: its only marks are
// `Auto-Submitted: auto-generated` and `X-Loop: clankerinbox`, which every mail of this tool
// carries (and PostShiba puts the first on every mail it sends), so two agents can write to each
// other. Else the reason to skip it: an auto-reply (vacation and the like), bulk or list mail, or
// the loop mark of another tool. Answering any of those could start a loop with a robot that never
// stops by itself.
export function automation(msg: Mail): string | null {
  if (tokens(msg, 'precedence').some((p) => ['bulk', 'junk', 'list', 'auto_reply'].includes(p))) return 'automated mail (Precedence: bulk, list or junk)'
  if (header(msg, 'x-autoreply') || header(msg, 'x-autorespond')) return 'automated mail (an auto-reply)'
  if (header(msg, 'list-id') || header(msg, 'list-unsubscribe')) return 'automated mail (a mailing list)'
  const auto = tokens(msg, 'auto-submitted').filter((v) => v !== 'no')
  if (auto.some((v) => v !== 'auto-generated')) return 'automated mail (an auto-reply)'
  // An X-Loop that is there but empty or unreadable is another tool's too.
  const loop = tokens(msg, 'x-loop')
  if ((header(msg, 'x-loop') !== '' && !loop.length) || loop.some((v) => v !== 'clankerinbox')) return 'automated mail (the X-Loop of another tool)'
  return auto.length || loop.length ? AGENT_MAIL : null
}

// Send allowlist: each `to` must be on the inbox's send list or be one of this
// machine's own inboxes, which reaches nobody else. Plus tags address the same
// mailbox, so they don't widen who can be reached.
export function checkRecipients(to: string[], inbox: InboxConfig, ownInboxes: string[]): Verdict {
  if (to.length === 0) return { ok: false, reason: 'no recipient' }
  const allowed = new Set([...inbox.send, ...ownInboxes].map(baseAddress))
  for (const raw of to) {
    const parsed = parseAddresses(raw)
    if (parsed.length !== 1) return { ok: false, reason: `not one address: ${raw}` }
    if (!allowed.has(baseAddress(parsed[0]))) return { ok: false, reason: `recipient not on send allowlist: ${parsed[0]}` }
  }
  return { ok: true }
}

// C0 and C1 controls (line breaks and tabs among them), DEL, and the Unicode line and
// paragraph separators: none belongs in a header value.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/

export function hasControlChars(value: string | null | undefined): boolean {
  return !!value && CONTROL.test(value)
}

// Mail text shown in a terminal: escape sequences (CSI, OSC such as hyperlinks, any other
// ESC pair), other C0 and C1 controls, DEL and bidi overrides are dropped, so a mail cannot
// move the cursor, rewrite a line or hide text. Line breaks and tabs stay.
export function cleanText(value: string | null | undefined): string {
  if (!value) return ''
  return value
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]?/g, '')
    .replace(/(?:\u001b\]|\u009d)[^\u0007\u001b\u009c]*(?:\u0007|\u001b\\|\u009c)?/g, '')
    .replace(/\u001b[\s\S]?/g, '')
    .replace(/\r\n?/g, (m) => (m === '\r\n' ? '\n' : ''))
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
}

// The same, for one line of output: line breaks and tabs become spaces.
export function cleanLine(value: string | null | undefined): string {
  return cleanText(value).replace(/[\n\t\u2028\u2029]/g, ' ')
}

// An attachment name as the sender wrote it is only ever a label: no path, no controls.
export function safeFilename(value: string | null | undefined): string {
  const name = cleanLine(value).replace(/[/\\]/g, '_').trim().slice(0, 255)
  return name === '' || name === '.' || name === '..' ? 'attachment' : name
}

// Header lines are short; a longer line is the owner's text, and is never matched against
// the patterns below, which keeps them cheap on hostile input.
const MAX_HEADER_LINE = 300

// "wrote" in the attribution line of the languages mail clients write it in.
const WROTE = /(?<!\p{L})(wrote|schrieb|écrit|escribió|schreef|scritto|escreveu|skrev|kirjoitti|napisał|napsal)(?!\p{L})/iu
const ATTRIBUTION_START = /^(On|Am|Le|El|Op|Il|Em|Den|På|W dniu|Dne)(?!\p{L})/iu

// The number of lines (1 to 3, since clients wrap it) of an attribution line such as
// "On Tue, … Bot <bot@…> wrote:" that starts at line i, or 0.
function attribution(lines: string[], i: number): number {
  let joined = ''
  for (let k = 0; k < 3 && i + k < lines.length; k++) {
    const line = lines[i + k].trim()
    if (!line || line.length > MAX_HEADER_LINE) return 0
    joined = k ? `${joined} ${line}` : line
    if (!joined.endsWith(':')) continue
    if (/^On(?!\p{L})/iu.test(joined) && /(?<!\p{L})wrote\s*:$/iu.test(joined)) return k + 1
    if (WROTE.test(joined) && (ATTRIBUTION_START.test(joined) || joined.includes('@'))) return k + 1
  }
  return 0
}

// Outlook's quoted header block, in the languages it writes it in: a From line followed
// closely by a date line and a To or Subject line.
const FROM_LABEL = /^(From|Von|Van|De|Da|Från|Fra|Od|Lähettäjä)\s?:/i
const DATE_LABEL = /^(Sent|Date|Gesendet|Datum|Verzonden|Envoyé|Enviado|Inviato|Data|Skickat|Sendt|Odesláno|Wysłano|Lähetetty)\s?:/i
const OTHER_LABEL = /^(To|Subject|Cc|An|Betreff|Aan|Onderwerp|À|Objet|Para|Asunto|A|Oggetto|Till|Ämne|Til|Emne|Komu|Předmět|Do|Temat|Vastaanottaja|Aihe)\s?:/i

function outlookBlock(lines: string[], i: number): boolean {
  if (!FROM_LABEL.test(lines[i].trim())) return false
  const next = lines.slice(i + 1, i + 6).map((l) => l.trim())
  return next.some((l) => DATE_LABEL.test(l)) && next.some((l) => OTHER_LABEL.test(l))
}

// A whole line that mail apps add under what the owner wrote. Kept to the exact shape, so
// "Sent from my laptop because the phone died: 2" stays an answer.
const FOOTER = new RegExp('^(' + [
  'Sent from my [\\p{L}\\p{N} -]{1,40}', 'Sent from (Outlook|Mail for Windows|Yahoo Mail|Proton Mail|ProtonMail)( for [\\p{L} ]{1,20})?',
  'Get Outlook for (iOS|Android)', 'Sent with Proton Mail( secure email)?', 'Sent from Proton Mail( mobile)?',
  'Envoyé de mon [\\p{L} -]{1,30}', 'Von meinem [\\p{L} -]{1,30} gesendet', 'Verzonden (vanaf|met) mijn [\\p{L} -]{1,30}',
  'Enviado desde mi [\\p{L} -]{1,30}', 'Enviado do meu [\\p{L} -]{1,30}', 'Inviato da [\\p{L} -]{1,30}', 'Skickat från min [\\p{L} -]{1,30}',
].join('|') + ')\\.?(\\s*<[^<>]{0,200}>)?$', 'iu')

// Where the owner's own text ends for good: a signature, a forward or separator line,
// an Outlook header block, a mobile or Proton footer.
function endOfText(lines: string[], i: number): boolean {
  const line = lines[i].trim()
  if (lines[i] === '-- ' || line === '--') return true
  if (line.length > MAX_HEADER_LINE) return false
  return /^-{2,}[^-]{3,60}-{2,}$/.test(line) || /^_{10,}$/.test(line) || FOOTER.test(line) || outlookBlock(lines, i)
}

// Answers arrive as replies that quote the question; the quote must not be read as the
// answer, since the quoted options would look like a choice. Text above the quote is the
// answer. With nothing above it (bottom-posted or inline replies), the answer is the text
// between and after the quoted lines. A line starting with `>` is a quote only in a text
// that quotes the usual way (`> `), or after an attribution line: alone, `>2 weeks is too
// long` is the owner's text.
export function stripQuoted(text: string | null | undefined): string {
  if (!text) return ''
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const { cut, quote } = quoteStart(lines)
  const above = lines.slice(0, cut).join('\n').trim()
  if (above || !quote) return above
  const own: string[] = []
  for (let i = cut; i < lines.length; i++) {
    if (lines[i].trim().startsWith('>')) continue
    const header = attribution(lines, i)
    if (header) { i += header - 1; continue }
    if (endOfText(lines, i)) break
    own.push(lines[i].trimEnd())
  }
  return own.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

// Where the owner's own text ends: the line of the first quote, attribution, signature, footer
// or header block. `quote`: it ends at a quote (an answer may follow it).
function quoteStart(lines: string[]): { cut: number; quote: boolean } {
  const spaced = lines.some((l) => /^\s*>(?:\s|>|$)/.test(l))
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line.startsWith('>') && (spaced || /^>(?:\s|>|$)/.test(line))) return { cut: i, quote: true }
    if (attribution(lines, i)) return { cut: i, quote: true }
    if (endOfText(lines, i)) return { cut: i, quote: false }
  }
  return { cut: lines.length, quote: false }
}

// Marks that mail apps put on the signature or the quoted mail in the HTML part of a reply:
// Gmail, Apple Mail (a cited blockquote, the iOS signature), Outlook (its reply header and
// signature), Thunderbird, Yahoo and Proton.
const HTML_CUT_CLASS = /\bclass\s*=\s*["'][^"']*\b(?:gmail_signature|gmail_quote|gmail_extra|moz-signature|moz-cite-prefix|yahoo_quoted|protonmail_signature_block|protonmail_quote)\b/i
const HTML_CUT_ID = /\bid\s*=\s*["']?(?:AppleMailSignature|Signature|divRplyFwdMsg|appendonsend|ms-outlook-mobile-signature)\b/i
const HTML_CUT_CITE = /^blockquote\b[^]*\btype\s*=\s*["']?cite\b/i
const MAX_TAG = 2000

// The owner's own words from the HTML part of a reply: what comes before the first signature or
// quote that a mail app marked, without any quote the text still has. Null when the HTML has
// no such mark, or nothing is before it (a bottom-posted reply): then the text part decides.
// One pass from the left with indexOf, as htmlToText reads it: anyone can send HTML.
export function htmlAnswer(html: string | null | undefined): string | null {
  if (!html) return null
  let i = 0
  while (i < html.length) {
    const lt = html.indexOf('<', i)
    if (lt < 0) return null
    const gt = html.indexOf('>', lt + 1)
    if (gt < 0) return null
    const tag = html.slice(lt + 1, Math.min(gt, lt + 1 + MAX_TAG))
    if (tag[0] !== '/' && tag[0] !== '!' && (HTML_CUT_CLASS.test(tag) || HTML_CUT_ID.test(tag) || HTML_CUT_CITE.test(tag))) {
      return stripQuoted(htmlToText(html.slice(0, lt))) || null
    }
    i = gt + 1
  }
  return null
}

// The last paragraph of an answer, when the quoted part of the same mail has the same lines (at
// least two, one after the other): a signature that the sender's earlier mail in the quote has
// too. Text only; a paragraph the quote does not repeat stays, since it may be the answer.
function repeatedSignature(own: string, lines: string[], cut: number): string {
  const paragraphs = own.split(/\n\s*\n/)
  if (paragraphs.length < 2) return own
  const last = paragraphs[paragraphs.length - 1].split('\n').map((l) => l.trim()).filter(Boolean)
  if (last.length < 2) return own
  const quoted = lines.slice(cut).map((l) => l.replace(/^\s*(?:>\s?)*/, '').trim()).filter(Boolean)
  for (let k = 0; k + last.length <= quoted.length; k++) {
    if (last.every((l, j) => quoted[k + j] === l)) return paragraphs.slice(0, -1).join('\n\n').trim()
  }
  return own
}

// The answer in a reply: from the HTML part when a mail app marked its signature or quote there,
// else from the text without quotes, footers and a signature the quote repeats.
export function answerText(text: string | null | undefined, html?: string | null): string {
  const fromHtml = htmlAnswer(html)
  if (fromHtml) return fromHtml
  if (!text) return ''
  const own = stripQuoted(text)
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const { cut, quote } = quoteStart(lines)
  return own && quote && cut < lines.length && lines.slice(0, cut).join('\n').trim() ? repeatedSignature(own, lines, cut) : own
}

const WRAPPING = '"\'*_`\u201c\u201d\u2018\u2019'

// One form for a reply line and an option alike: width and case folded, zero-width
// characters gone, wrapping quotes or emphasis and a closing `.` or `!` dropped.
// A `?` stays: "Cancel?" is a question back, not a choice.
function normalizeChoice(s: string): string {
  const v = s.normalize('NFKC').replace(/[\u200b-\u200d\u2060\ufeff]/g, '').trim()
  let a = 0
  let b = v.length
  while (a < b && WRAPPING.includes(v[a])) a++
  while (b > a && (WRAPPING.includes(v[b - 1]) || v[b - 1] === '.' || v[b - 1] === '!')) b--
  return v.slice(a, b).trim().replace(/\s+/g, ' ').toLowerCase()
}

// `2`, `2)`, `2.`, `#2`, `option 2`: plain digits only, so `0x2`, `+2` or `1e0` are no index.
const INDEX = /^(?:option ?#? ?|#)?(\d{1,3})\)?$/

const GREETING = /^(hi|hello|hey|dear|thanks|thank you|thx|cheers)( \p{L}+){0,2}[,!.]*$/iu

function matchLine(line: string, options: string[], normalized: string[]): string | null {
  const v = normalizeChoice(line)
  if (!v) return null
  // The text of an option wins over a number, so the reply `1` to options `4, 2, 1` is `1`.
  const exact = normalized.indexOf(v)
  if (exact >= 0) return options[exact]
  const index = INDEX.exec(v)
  if (index) {
    const n = Number(index[1])
    return n >= 1 && n <= options.length ? options[n - 1] : null
  }
  // The start of exactly one option, ending where a word ends: "yes" for "Yes, ship it".
  const starts = normalized
    .map((o, i) => (o.startsWith(v) && !/[\p{L}\p{N}]/u.test(o[v.length] || 'x') ? i : -1))
    .filter((i) => i >= 0)
  return starts.length === 1 ? options[starts[0]] : null
}

// Reads a reply against the offered options: a number or an option's text (or the start of
// exactly one option) picks that option; anything else is free text. A first line that is
// only a greeting ("Thanks!") is passed over for the next one.
export function matchOption(answer: string, options: string[]): string | null {
  if (!options.length) return null
  const lines = answer.split('\n').map((l) => l.trim()).filter(Boolean)
  if (!lines.length) return null
  const normalized = options.map(normalizeChoice)
  const first = matchLine(lines[0], options, normalized)
  if (first || !GREETING.test(lines[0]) || lines.length < 2) return first
  return matchLine(lines[1], options, normalized)
}

const CODE_WORDS = /(code|otp|pin|passcode|verification|verify|confirm|one[- ]time|security|token|login|sign[- ]?in)/i
const LINK_WORDS = /(verify|verification|confirm|magic|login|log-in|signin|sign-in|sign_in|auth|token|activate|validate|callback|session)/i

// A run of digit groups joined by single spaces, dashes or dots, read whole: a phone number,
// a date or a long reference is one run and never gives up a piece of itself as a code.
const NUMBER_RUN = /\+?\d+(?:[ .-]\d+)*/g

// Each code-shaped number in a text: 4–8 digits alone, or two groups of three (`482-913`),
// not glued to a word, a path, a time or a sign. `at` and `length` locate it in the text.
export function codeCandidates(src: string): { code: string; at: number; length: number }[] {
  const out: { code: string; at: number; length: number }[] = []
  for (const m of src.matchAll(NUMBER_RUN)) {
    const run = m[0]
    const before = src[m.index! - 1] || ''
    const after = src[m.index! + run.length] || ''
    if (/[\w.\/:+-]/.test(before) || /[\w\/-]/.test(after)) continue
    if (/^\d{4,8}$/.test(run) || /^\d{3}[- ]\d{3}$/.test(run)) out.push({ code: run.replace(/[- ]/g, ''), at: m.index!, length: run.length })
  }
  return out
}

// Hosts no sign-in link of a real service points to: IP literals, single labels and
// names that only resolve inside a network.
const PRIVATE_TLDS = new Set(['localhost', 'local', 'internal', 'lan', 'arpa', 'intranet', 'corp', 'private', 'home'])

function publicHost(host: string): boolean {
  if (!host.includes('.') || host.startsWith('[') || /^[\d.]+$/.test(host)) return false
  return !PRIVATE_TLDS.has(host.slice(host.lastIndexOf('.') + 1))
}

// A link from a mail, as a normalized https URL to a public host (on `domain` or under it
// when given), or null.
function safeLink(raw: string, domain?: string): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (!publicHost(host)) return null
  if (domain && host !== domain && !host.endsWith('.' + domain)) return null
  return url.href
}

const LINK = /https:\/\/[^\s<>"'`)\]\u0000-\u001f\u007f-\u009f]+/g

// The domain a code must come from, given as a domain, an address, or a URL, in any case
// and with or without a trailing dot.
export function senderDomain(value: string): string {
  const fail = () => new Error(`invalid --from: ${value}. Give the sender's domain, for example github.com`)
  let v = value.trim().toLowerCase()
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(v)) {
    try { v = new URL(v).hostname } catch { throw fail() }
  } else if (v.includes('@')) {
    const parts = v.split('@')
    if (parts.length !== 2) throw fail()
    v = parts[1]
  }
  v = v.replace(/\.$/, '')
  try {
    v = new URL(`https://${v}/`).hostname
  } catch {
    throw fail()
  }
  const labels = v.split('.')
  if (labels.length < 2 || !labels.every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l)) || !publicHost(v)) throw fail()
  return v
}

// Only a 4–8 digit code or a sign-in link ever leaves a codes inbox.
export function extractCode(subject: string, text: string, opts: { domain?: string } = {}): { code?: string; link?: string } {
  const sources = [subject || '', text || '']
  const candidates: { code: string; score: number; order: number }[] = []
  let order = 0
  for (const src of sources) {
    for (const c of codeCandidates(src)) {
      const around = src.slice(Math.max(0, c.at - 60), c.at + c.length + 20)
      let score = CODE_WORDS.test(around) ? 2 : 0
      if (/^(19|20)\d\d$/.test(c.code)) score -= 2
      candidates.push({ code: c.code, score, order: order++ })
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.order - b.order)
  const best = candidates[0]
  // A number next to code words wins; a bare number (a ZIP in a footer, say) loses to a sign-in link.
  if (best && best.score > 0) return { code: best.code }
  for (const src of sources) {
    for (const m of src.matchAll(LINK)) {
      const raw = trimPunctuation(m[0])
      if (!LINK_WORDS.test(raw)) continue
      const link = safeLink(raw, opts.domain)
      if (link) return { link }
    }
  }
  if (best && best.score >= 0) return { code: best.code }
  return {}
}

// Sentence punctuation after a link is not part of it.
function trimPunctuation(s: string): string {
  let end = s.length
  while (end > 0 && '.,;'.includes(s[end - 1])) end--
  return s.slice(0, end)
}

// Sign-up mail in the log is masked, so the log never holds a usable secret: each number
// extractCode could take as a code, and the path and query of each link (a token can sit
// in either). Other numbers stay readable.
export function maskSecrets(text: string): string {
  const links = text.replace(/https?:\/\/[^\s<>"'`)\]]*/g, (raw) => {
    const url = trimPunctuation(raw)
    const start = url.indexOf('//') + 2
    const found = url.slice(start).search(/[/?#]/)
    const end = found < 0 ? url.length : start + found
    const rest = url.slice(end)
    return rest === '' || rest === '/' ? raw : url.slice(0, end) + '/…' + raw.slice(url.length)
  })
  let out = ''
  let from = 0
  for (const c of codeCandidates(links)) {
    out += links.slice(from, c.at) + links.slice(c.at, c.at + c.length).replace(/\d/g, '•')
    from = c.at + c.length
  }
  return out + links.slice(from)
}
