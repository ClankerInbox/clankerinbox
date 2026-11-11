// Anyone can send a mail, and every poll reads it again, so each function that reads
// mail text must stay linear on hostile input: 200 KB to 1 MB of the worst shapes.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseAddresses, stripQuoted, matchOption, extractCode, maskSecrets, cleanText, safeFilename } from '../src/safety.ts'
import { htmlToText, parseMail } from '../src/mime.ts'
import { parseAuthResults } from '../src/auth-results.ts'

const LIMIT_MS = 1000

function fast(name: string, f: () => unknown) {
  const t = performance.now()
  f()
  const ms = performance.now() - t
  assert.ok(ms < LIMIT_MS, `${name} took ${ms.toFixed(0)} ms`)
}

const big = (s: string, size = 500_000) => s.repeat(Math.ceil(size / s.length))

test('html to text stays fast on hostile HTML', () => {
  for (const [name, html] of [
    ['spaces', '<p>' + ' '.repeat(1_000_000)],
    ['open script', big('<script')],
    ['script tags never closed', big('<script>x')],
    ['a with spaces', '<a ' + ' '.repeat(500_000)],
    ['a tags', big('<a href="x">')],
    ['lt only', big('<')],
    ['tags', big('<b>')],
    ['blockquotes', big('<blockquote>')],
    ['entities', big('&#1234567')],
    ['spaces then newline', big(' \t') + '\n'],
    ['newlines', big('\n')],
  ] as [string, string][]) fast(name, () => htmlToText(html))
  fast('parseMail html', () => parseMail(`From: a@b.c\r\nContent-Type: text/html\r\n\r\n${big('<script')}`))
})

test('address and Authentication-Results parsing stays fast', () => {
  for (const s of [big('a'), big('a@'), big('a@a.'), big('(('), big('"a'), big('<a@b.c>,')]) {
    fast('parseAddresses', () => parseAddresses(s))
  }
  for (const s of [big('('), big('"'), big('x; '), big('a=b '), big(' = ')]) fast('parseAuthResults', () => parseAuthResults('x; ' + s))
})

test('quote stripping and option matching stay fast', () => {
  for (const s of [
    'Am ' + big('schrieb'), 'On ' + big(' x'), big('From: x\n'), big('> a\n'), big('Le écrit'), big('On '), big('wrote:\n'),
    big('a\n'), big('\n'), big(' '), big('-'), big('_'), big('>'), 'x\n' + big('> \n'), big('Von: a\nGesendet: b\n'),
  ]) fast('stripQuoted', () => stripQuoted(s))
  for (const s of [big('1'), big(' '), big('option '), big('#'), big('yes ')]) fast('matchOption', () => matchOption(s, ['Yes, ship it', 'Wait', '1']))
})

test('code extraction and masking stay fast', () => {
  for (const s of [
    big('1234 '), big('1'), big('https://verify'), big('https://'), big('https://a.b/c?'), big('482-913 '),
    big('+1 415 555 0123 '), big('code '), big('a.'), big('1-'), big('https://x.example/' + 'a'.repeat(50) + ' '),
  ]) {
    fast('extractCode', () => extractCode(s, s))
    fast('maskSecrets', () => maskSecrets(s))
  }
  for (const s of [big('\u001b['), big('\u001b]'), big('\u009b'), big('\r'), big('\u001b[1;'), big('/')]) {
    fast('cleanText', () => cleanText(s))
    fast('safeFilename', () => safeFilename(s))
  }
})
