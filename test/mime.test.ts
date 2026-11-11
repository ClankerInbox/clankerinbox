import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseMail, decodeWords, htmlToText } from '../src/mime.ts'
import { trustedDmarc } from '../src/auth-results.ts'

const OWNER = 'owner@example.org'

function mail(opts: { to: string; from?: string; subject?: string; body?: string; ar?: string[]; extra?: string[]; delivered?: string }): string {
  const ar = opts.ar ?? [`mx.example.org; spf=pass smtp.mailfrom=example.org; dkim=pass header.i=@example.org; dmarc=pass (p=REJECT) header.from=${(opts.from || OWNER).split('@')[1]}`]
  return [
    ...(opts.delivered ? [`Delivered-To: ${opts.delivered}`] : []),
    `Return-Path: <${opts.from || OWNER}>`,
    ...ar.map((a) => `Authentication-Results: ${a}`),
    `From: Owner <${opts.from || OWNER}>`,
    `To: ${opts.to}`,
    `Subject: ${opts.subject ?? 'Re: question'}`,
    'Message-ID: <m1@example.org>',
    ...(opts.extra || []),
    'Content-Type: text/plain; charset=utf-8',
    '',
    opts.body ?? 'Yes',
    '',
  ].join('\r\n')
}

// ---- MIME ----

test('mime: multipart with quoted-printable, base64, RFC 2047 headers and an attachment', () => {
  const raw = [
    'From: =?UTF-8?Q?J=C3=BCrgen?= <j@example.org>',
    'Subject: =?UTF-8?B?w5xiZXI=?= =?UTF-8?Q?_den_Code?=',
    'To: bot@example.org',
    'Content-Type: multipart/mixed; boundary="outer"',
    '',
    'preamble',
    '--outer',
    'Content-Type: multipart/alternative; boundary=inner',
    '',
    '--inner',
    'Content-Type: text/plain; charset="iso-8859-1"',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    'Gr=FC=DFe, dein Code ist 482913. Eine sehr lange Zeile, die weich umbrochen w=',
    'ird.',
    '--inner',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>ignored when text exists</p>',
    '--inner--',
    '--outer',
    'Content-Type: application/pdf; name="=?UTF-8?Q?Rechnung_=C3=A4.pdf?="',
    'Content-Disposition: attachment; filename*=utf-8\'\'Rechnung%20%C3%A4.pdf',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('%PDF-1.4 fake').toString('base64'),
    '--outer--',
    '',
  ].join('\r\n')
  const p = parseMail(Buffer.from(raw, 'latin1'))
  assert.equal(p.subject, 'Über den Code')
  assert.equal(p.text.trim(), 'Grüße, dein Code ist 482913. Eine sehr lange Zeile, die weich umbrochen wird.')
  assert.deepEqual(p.attachments, [{ filename: 'Rechnung ä.pdf', contentType: 'application/pdf', size: 13 }])
  assert.equal(decodeWords(p.headers.from as string), 'Jürgen <j@example.org>')
})

test('mime: an HTML-only mail gives text with its link targets', () => {
  const raw = 'Subject: Sign in\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n' +
    Buffer.from('<p>Click <a href="https://app.example.com/verify?t=abc">here</a> to sign in &amp; go.</p>').toString('base64') + '\r\n'
  const p = parseMail(raw)
  assert.match(p.text, /here https:\/\/app\.example\.com\/verify\?t=abc/)
  assert.match(p.text, /sign in & go\./)
})

test('mime: html to text hides scripts and styles, keeps link targets and line breaks', () => {
  const html = '<HEAD><title>t</title></head><style>p{}</STYLE><header>Hi</header><p>Code <b>12</b></p>' +
    '<script>alert(1)</script><a class="x" HREF="https://a.example/v?t=1">open</a><br/>end<blockquote>q</blockquote>< not a tag'
  assert.equal(htmlToText(html), 'Hi\nCode 12\n open https://a.example/v?t=1\nend\n> q\n< not a tag')
})

test('mime: numeric entities outside Unicode stay as written; hex entities decode', () => {
  const p = parseMail('From: a@b.org\r\nContent-Type: text/html\r\n\r\n<p>&#99999999; &#x41; &#65; &#x110000;</p>\r\n')
  assert.equal(p.text, '&#99999999; A A &#x110000;')
})

// ---- DMARC from Authentication-Results ----

test('dmarc: only the trusted authserv-id counts; a forged header from another id is ignored', () => {
  const forged = parseMail(mail({
    to: 'bot@example.org',
    ar: ['evil.example.net; dmarc=pass header.from=example.org', 'mx.example.org; dmarc=fail (p=REJECT) header.from=example.org'],
  }))
  assert.deepEqual(trustedDmarc(forged.headers, 'mx.example.org'), { result: 'fail', aligned: false })
  const onlyForged = parseMail(mail({ to: 'bot@example.org', ar: ['evil.example.net; dmarc=pass header.from=example.org'] }))
  assert.equal(trustedDmarc(onlyForged.headers, 'mx.example.org'), null)
  const none = parseMail(mail({ to: 'bot@example.org', ar: [] }))
  assert.equal(trustedDmarc(none.headers, 'mx.example.org'), null)
  assert.equal(trustedDmarc(parseMail(mail({ to: 'bot@example.org' })).headers, undefined), null)
})

test('dmarc: the topmost trusted header wins over a copy the sender wrote below it', () => {
  const p = parseMail(mail({
    to: 'bot@example.org',
    ar: ['mx.example.org; dmarc=fail header.from=example.org', 'mx.example.org; dmarc=pass header.from=example.org'],
  }))
  assert.deepEqual(trustedDmarc(p.headers, 'mx.example.org'), { result: 'fail', aligned: false })
})

test('dmarc: a pass for another domain than From is not aligned; comments and case are handled', () => {
  const other = parseMail(mail({ to: 'bot@example.org', ar: ['mx.example.org; dmarc=pass header.from=other.org'] }))
  assert.deepEqual(trustedDmarc(other.headers, 'mx.example.org'), { result: 'pass', aligned: false })
  const fancy = parseMail(mail({ to: 'bot@example.org', ar: ['MX.Example.ORG 1; (comment; dmarc=fail) DMARC=Pass (p=NONE sp=NONE dis=NONE) header.from=Example.org'] }))
  assert.deepEqual(trustedDmarc(fancy.headers, ['mx2.example.org', 'mx.example.org']), { result: 'pass', aligned: true })
})

test('dmarc: a ; inside quotes or comments splits nothing; unbalanced or doubled results are untrusted', () => {
  const headers = (ar: string) => ({ 'authentication-results': ar, from: 'Owner <owner@example.org>' })
  const verdict = (ar: string) => trustedDmarc(headers(ar), 'mx.cloudflare.net')
  // The sender chose the envelope address; its quoted ; must not start a new result.
  assert.deepEqual(verdict('mx.cloudflare.net; spf=pass smtp.mailfrom="x; dmarc=pass y"@evil.example; dmarc=fail header.from=example.org'), { result: 'fail', aligned: false })
  assert.deepEqual(verdict('mx.cloudflare.net; dmarc=fail (dmarc=pass; x) header.from=example.org'), { result: 'fail', aligned: false })
  assert.equal(verdict('mx.cloudflare.net; spf=pass (domain of "a) ; dmarc=pass header.from=example.org'), null)
  assert.equal(verdict('mx.cloudflare.net; spf=pass smtp.mailfrom="a; dmarc=pass header.from=example.org'), null)
  assert.equal(verdict('mx.cloudflare.net; spf=pass (open; dmarc=pass header.from=example.org'), null)
  assert.equal(verdict('mx.cloudflare.net; dmarc=fail header.from=example.org; dmarc=pass header.from=example.org'), null)
  assert.equal(verdict('mx.cloudflare.net; dmarc=pass header.from=example.org; DMARC = fail'), null)
  // An unreadable trusted header is not skipped for a readable one below it.
  const two = { 'authentication-results': ['mx.cloudflare.net; spf=pass (x', 'mx.cloudflare.net; dmarc=pass header.from=example.org'], from: 'owner@example.org' }
  assert.equal(trustedDmarc(two, 'mx.cloudflare.net'), null)
  assert.deepEqual(verdict('mx.cloudflare.net; dmarc=pass header.from=example.org'), { result: 'pass', aligned: true })
})

test('mime: an empty text/plain part next to an HTML part gives the HTML text', () => {
  const raw = ['From: Owner <owner@example.org>', 'Content-Type: multipart/alternative; boundary=b', '', '--b', 'Content-Type: text/plain', '', '', '--b',
    'Content-Type: text/html', '', '<div>Yes, ship it</div>', '--b--', ''].join('\r\n')
  assert.equal(parseMail(raw).text, 'Yes, ship it')
})
