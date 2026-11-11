// DMARC from Authentication-Results headers (RFC 8601). Anyone can write such a
// header into the mail they send, so only a header from the server we trust counts,
// and only the topmost one from it: the receiving server adds its header above
// everything the sender wrote.

import { parseAddresses, domainOf } from './safety.ts'

export interface DmarcResult {
  result: string
  aligned: boolean
}

// Splits a header into its `;` parts and each part into words, in one pass from the left:
// a comment (which may nest) is dropped, a quoted string is part of its word, and spaces
// around `=` join. The sender writes parts of this header (the envelope address, say), so
// whatever two parsers could read two ways gives null: an unclosed quote or comment, a stray
// `)`, a quote inside a comment, a parenthesis inside a quoted string.
function splitParts(value: string): string[][] | null {
  const parts: string[][] = [[]]
  let word = ''
  let gap = false
  let depth = 0
  let quoted = false
  const endWord = () => {
    if (word) parts[parts.length - 1].push(word)
    word = ''
    gap = false
  }
  const add = (c: string) => {
    if (gap && c !== '=' && !word.endsWith('=')) endWord()
    gap = false
    word += c
  }
  for (let i = 0; i < value.length; i++) {
    const c = value[i]
    if (depth) {
      if (c === '\\') i++
      else if (c === '"') return null
      else if (c === '(') depth++
      else if (c === ')') depth--
      continue
    }
    if (quoted) {
      if (c === '\\') word += value[++i] ?? ''
      else if (c === '"') quoted = false
      else if (c === '(' || c === ')') return null
      else word += c
      continue
    }
    if (c === '(') { depth = 1; gap = true; continue }
    if (c === ')') return null
    if (c === ';') { endWord(); parts.push([]); continue }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { gap = true; continue }
    if (c === '"') { add(''); quoted = true; continue }
    add(c)
  }
  if (quoted || depth) return null
  endWord()
  return parts
}

export interface AuthResults {
  authservId: string
  methods: { method: string; result: string; props: Record<string, string> }[]
}

export function parseAuthResults(value: string): AuthResults | null {
  const parts = splitParts(value)
  if (!parts) return null
  const authservId = parts[0][0]?.toLowerCase()
  if (!authservId) return null
  const methods: AuthResults['methods'] = []
  for (const tokens of parts.slice(1)) {
    const head = /^([a-z0-9_-]+)(?:\/[\d.]+)?=([a-z0-9_-]+)$/i.exec(tokens[0] || '')
    if (!head) {
      // Kept so a result we cannot read still counts when results are counted.
      const name = /^([a-z0-9_-]+)/i.exec(tokens[0] || '')?.[1]
      if (name) methods.push({ method: name.toLowerCase(), result: '', props: {} })
      continue
    }
    const props: Record<string, string> = {}
    for (const t of tokens.slice(1)) {
      const kv = /^([a-z0-9_.-]+)=(.*)$/i.exec(t)
      if (kv) props[kv[1].toLowerCase()] = kv[2]
    }
    methods.push({ method: head[1].toLowerCase(), result: head[2].toLowerCase(), props })
  }
  return { authservId, methods }
}

function asList(v: string | string[] | undefined): string[] {
  return v == null ? [] : Array.isArray(v) ? v : [v]
}

// The DMARC verdict of the trusted server for this mail, or null when it gave none.
// `aligned` also checks the domain the verdict was for (header.from) against the From
// header, so a pass for some other domain does not count. A verdict that names no
// header.from is never aligned: the server may have read another From than we did.
export function trustedDmarc(
  headers: Record<string, string | string[]>,
  trusted: string | string[] | undefined,
): DmarcResult | null {
  const ids = asList(trusted as any).map((t) => t.trim().toLowerCase()).filter(Boolean)
  if (ids.length === 0) return null
  // The topmost header from the trusted server, readable or not: one we cannot read is
  // never passed over for a readable copy below it.
  const raw = asList(headers['authentication-results'])
    .find((v) => ids.includes((/^\s*([^\s;(]+)/.exec(v)?.[1] || '').toLowerCase()))
  const ours = raw === undefined ? null : parseAuthResults(raw)
  if (!ours) return null
  // Two DMARC results in one header means part of it was not written by the server.
  const results = ours.methods.filter((m) => m.method === 'dmarc')
  if (results.length !== 1 || !results[0].result) return null
  const dmarc = results[0]
  const fromAddrs = parseAddresses(asList(headers.from).join(', '))
  const fromDomain = fromAddrs.length === 1 ? domainOf(fromAddrs[0]) : null
  const checked = (dmarc.props['header.from'] || '').toLowerCase()
  return { result: dmarc.result, aligned: dmarc.result === 'pass' && !!fromDomain && checked === fromDomain }
}
