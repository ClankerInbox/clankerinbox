// Just enough MIME to read a mail: headers (folded, RFC 2047),
// multipart trees, base64 and quoted-printable, and charsets through TextDecoder.
// Structure is parsed on latin1 strings so every byte maps to one char and survives.

import type { Attachment } from './provider.ts'

export interface ParsedMail {
  // Lowercase names; a header that appears more than once is an array, top one first.
  headers: Record<string, string | string[]>
  subject: string
  text: string
  // The HTML parts, joined; '' when there is none.
  html: string
  attachments: Attachment[]
}

// Top-down list of [lowercase name, raw value] with folding removed.
export function parseHeaderBlock(block: string): [string, string][] {
  const out: [string, string][] = []
  for (const line of block.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && out.length) {
      out[out.length - 1][1] += ' ' + line.trim()
      continue
    }
    const i = line.indexOf(':')
    if (i <= 0) continue
    out.push([line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim()])
  }
  return out
}

function splitHeadBody(raw: string): [string, string] {
  const m = /\r?\n\r?\n/.exec(raw)
  if (!m) return [raw, '']
  return [raw.slice(0, m.index), raw.slice(m.index + m[0].length)]
}

export function headerMap(list: [string, string][]): Record<string, string | string[]> {
  const map: Record<string, string | string[]> = {}
  for (const [k, v] of list) {
    const cur = map[k]
    if (cur === undefined) map[k] = v
    else if (Array.isArray(cur)) cur.push(v)
    else map[k] = [cur, v]
  }
  return map
}

// `text/plain; charset="utf-8"` → value and lowercase params; RFC 2231 `name*=utf-8''x` is decoded.
export function parseParams(value: string): { value: string; params: Record<string, string> } {
  const parts: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < value.length; i++) {
    const c = value[i]
    if (c === '"' && value[i - 1] !== '\\') quoted = !quoted
    if (c === ';' && !quoted) { parts.push(cur); cur = '' } else cur += c
  }
  parts.push(cur)
  const params: Record<string, string> = {}
  const continued: Record<string, string[]> = {}
  for (const p of parts.slice(1)) {
    const i = p.indexOf('=')
    if (i < 0) continue
    let k = p.slice(0, i).trim().toLowerCase()
    let v = p.slice(i + 1).trim()
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1).replace(/\\(.)/g, '$1')
    const cont = /^(.+)\*(\d+)\*?$/.exec(k)
    if (cont) {
      ;(continued[cont[1]] ||= [])[Number(cont[2])] = (k.endsWith('*') ? '\u0000' : '') + v
      continue
    }
    if (k.endsWith('*')) {
      k = k.slice(0, -1)
      v = decode2231(v)
    }
    params[k] = v
  }
  for (const [k, pieces] of Object.entries(continued)) {
    if (params[k]) continue
    const joined = pieces.filter((x) => x != null).map((x) => x.replace(/^\u0000/, '')).join('')
    params[k] = pieces[0]?.startsWith('\u0000') ? decode2231(joined) : joined
  }
  return { value: parts[0].trim().toLowerCase(), params }
}

function decode2231(v: string): string {
  const m = /^([^']*)'[^']*'(.*)$/.exec(v)
  if (!m) return v
  const bytes = Buffer.from(m[2].replace(/%([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1')
  return decodeCharset(bytes, m[1] || 'utf-8')
}

export function decodeCharset(bytes: Buffer, charset: string | undefined): string {
  const cs = (charset || 'utf-8').trim().toLowerCase()
  try {
    return new TextDecoder(cs === 'us-ascii' || cs === 'ascii' ? 'utf-8' : cs).decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

export function decodeQP(s: string): Buffer {
  const text = s.replace(/[ \t]+(\r?\n)/g, '$1').replace(/=\r?\n/g, '')
  const bytes: number[] = []
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '=' && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16))
      i += 2
    } else bytes.push(text.charCodeAt(i) & 0xff)
  }
  return Buffer.from(bytes)
}

// RFC 2047 encoded words; whitespace between two adjacent encoded words is dropped.
export function decodeWords(value: string): string {
  if (!value.includes('=?')) return value
  const decoded = value.replace(/(=\?[^?\s]+\?[bBqQ]\?[^?\s]*\?=)\s+(?==\?[^?\s]+\?[bBqQ]\?[^?\s]*\?=)/g, '$1')
  return decoded.replace(/=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g, (_, charset: string, enc: string, data: string) => {
    const cs = charset.split('*')[0]
    const bytes = enc.toLowerCase() === 'b'
      ? Buffer.from(data, 'base64')
      : decodeQP(data.replace(/_/g, ' '))
    return decodeCharset(bytes, cs)
  })
}

function decodeBody(body: string, cte: string): Buffer {
  const enc = cte.trim().toLowerCase()
  if (enc === 'base64') return Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64')
  if (enc === 'quoted-printable') return decodeQP(body)
  return Buffer.from(body, 'latin1')
}

function splitMultipart(body: string, boundary: string): string[] {
  const parts: string[] = []
  const delim = '--' + boundary
  const lines = body.split(/\r?\n/)
  let cur: string[] | null = null
  for (const line of lines) {
    const trimmed = line.replace(/[ \t]+$/, '')
    if (trimmed === delim + '--') { if (cur) parts.push(cur.join('\r\n')); cur = null; break }
    if (trimmed === delim) { if (cur) parts.push(cur.join('\r\n')); cur = []; continue }
    if (cur) cur.push(line)
  }
  if (cur) parts.push(cur.join('\r\n'))
  return parts
}

// A numeric entity outside Unicode would throw; anyone can send one, so it stays as written.
function codePoint(n: number, written: string): string {
  return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : written
}

const HIDDEN = new Set(['script', 'style', 'head'])
const BLOCK_END = new Set(['p', 'div', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote'])

// HTML only mails still need readable text for answers and codes; links keep their target.
// One pass from the left with indexOf, never a backtracking regex over the whole mail:
// anyone can send HTML, and each poll reads it again.
export function htmlToText(html: string): string {
  const out: string[] = []
  // Closing tags searched for once and not found: a later search would not find them either.
  const missing = new Set<string>()
  let href: string | null = null
  let i = 0
  while (i < html.length) {
    const lt = html.indexOf('<', i)
    if (lt < 0) { out.push(html.slice(i)); break }
    out.push(html.slice(i, lt))
    const gt = html.indexOf('>', lt + 1)
    // No `>` anywhere after this: the rest is text.
    if (gt < 0) { out.push(html.slice(lt)); break }
    if (gt === lt + 1) { out.push('<>'); i = gt + 1; continue }
    const tag = html.slice(lt + 1, gt)
    const closing = tag[0] === '/'
    const name = (/^\/?([a-z][a-z0-9]*)/i.exec(tag)?.[1] || '').toLowerCase()
    i = gt + 1
    if (!closing && HIDDEN.has(name) && !missing.has(name)) {
      const end = closingTag(html, name, i)
      if (end < 0) missing.add(name)
      else { out.push(' '); i = end; continue }
    }
    if (name === 'a' && !closing && href === null) {
      href = /\shref\s*=\s*["']([^"']+)["']/i.exec(' ' + tag.slice(1))?.[1] ?? null
    } else if (name === 'a' && closing && href !== null) {
      out.push(` ${href} `)
      href = null
    } else if (name === 'br') out.push('\n')
    else if (closing && BLOCK_END.has(name)) out.push('\n')
    else if (!closing && name === 'blockquote') out.push('\n> ')
    // A block that starts inside a line of text (Gmail writes `line 1<div>line 2</div>`) starts
    // a new line.
    else if (!closing && BLOCK_END.has(name) && inLine(out)) out.push('\n')
  }
  return out.join('')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d{1,7});/g, (m, n) => codePoint(Number(n), m))
    .replace(/&#x([0-9a-f]{1,6});/gi, (m, n) => codePoint(parseInt(n, 16), m))
    .replace(/&amp;/g, '&')
    .split('\n').map((line) => line.trimEnd()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// Whether the text so far ends in the middle of a line (after text that is not white space).
function inLine(out: string[]): boolean {
  for (let k = out.length - 1; k >= 0; k--) {
    const piece = out[k]
    if (!piece.trim()) {
      if (piece.includes('\n')) return false
      continue
    }
    return !/\n\s*$/.test(piece)
  }
  return false
}

// The index just past `</name ...>` at or after `from`, or -1.
function closingTag(html: string, name: string, from: number): number {
  let at = html.indexOf('</', from)
  while (at >= 0) {
    const after = at + 2 + name.length
    if (html.slice(at + 2, after).toLowerCase() === name && !/[a-z0-9]/i.test(html[after] || '')) {
      const gt = html.indexOf('>', after)
      return gt < 0 ? -1 : gt + 1
    }
    at = html.indexOf('</', at + 2)
  }
  return -1
}

const MAX_DEPTH = 10

// Parses a whole mail as raw bytes. `sizeHeader`: a header that gives the size of a part whose
// body was left out (only for mail that the store marked as shortened).
export function parseMail(raw: Buffer | string, opts: { sizeHeader?: string } = {}): ParsedMail {
  const str = typeof raw === 'string' ? raw : raw.toString('latin1')
  const [head, body] = splitHeadBody(str)
  const list = parseHeaderBlock(head)
  // Raw 8-bit header bytes are read as UTF-8 (RFC 6532); encoded words stay encoded here.
  const headers = headerMap(list.map(([k, v]) => [k, decodeCharset(Buffer.from(v, 'latin1'), 'utf-8')]))
  const plain: string[] = []
  const html: string[] = []
  const attachments: Attachment[] = []

  const walk = (hdrs: [string, string][], content: string, depth: number) => {
    const get = (n: string) => hdrs.find(([k]) => k === n)?.[1] || ''
    const ct = parseParams(get('content-type') || 'text/plain')
    const disp = parseParams(get('content-disposition') || '')
    const filename = disp.params.filename || ct.params.name
    if (ct.value.startsWith('multipart/') && ct.params.boundary && depth < MAX_DEPTH) {
      for (const part of splitMultipart(content, ct.params.boundary)) {
        const [h, b] = splitHeadBody(part)
        walk(parseHeaderBlock(h), b, depth + 1)
      }
      return
    }
    const bytes = decodeBody(content, get('content-transfer-encoding'))
    const isText = ct.value === 'text/plain' || ct.value === 'text/html'
    const before = opts.sizeHeader && !bytes.length ? Number(get(opts.sizeHeader)) : NaN
    const size = Number.isSafeInteger(before) && before >= 0 ? before : bytes.length
    if (disp.value === 'attachment' || (filename && !isText) || (!isText && !ct.value.startsWith('multipart/'))) {
      attachments.push({ filename: decodeWords(filename || 'attachment'), contentType: ct.value || 'application/octet-stream', size })
      return
    }
    if (filename && disp.value !== 'inline') {
      attachments.push({ filename: decodeWords(filename), contentType: ct.value, size })
      return
    }
    const text = decodeCharset(bytes, ct.params.charset)
    if (ct.value === 'text/html') html.push(text)
    else plain.push(text)
  }
  walk(list, body, 0)

  // A plain part with only white space next to an HTML part is an empty alternative, not the text.
  const plainText = plain.join('\n')
  const text = plainText.trim() || !html.length ? plainText : html.map(htmlToText).join('\n')
  const subject = typeof headers.subject === 'string' ? headers.subject : Array.isArray(headers.subject) ? headers.subject[0] : ''
  return { headers, subject: decodeWords(subject).trim(), text: text.replace(/\r\n?/g, '\n'), html: html.join('\n'), attachments }
}
