import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  checkSender, checkRecipients, isBounce, isAutomated, automation, AGENT_MAIL, stripQuoted, matchOption, extractCode,
  maskSecrets, parseAddresses, singleFrom, cleanText, cleanLine, safeFilename, senderDomain,
} from '../src/safety.ts'
import { type InboundMessage, toMail } from '../src/postshiba.ts'
import type { Mail } from '../src/provider.ts'
import type { InboxConfig } from '../src/config.ts'

const OWNER = 'owner+clankerinbox@example.org'

// Written as PostShiba sends it, then normalized the way the PostShiba provider does.
function msg(over: Partial<InboundMessage> = {}): Mail {
  return toMail({
    id: 'm1', inbox_id: 'ib1', to: 'ask+q1@inbox.example.dev', from: 'owner@example.org',
    subject: 'Re: q', text: 'yes', thread_id: 'q1',
    headers: { from: 'Owner <owner@example.org>' },
    envelope: { mail_from: 'owner@example.org' },
    authentication: { dmarc: { result: 'pass', aligned: true } },
    ...over,
  })
}

test('receive: default deny when the allowlist is empty or missing', () => {
  assert.equal(checkSender(msg(), []).ok, false)
  assert.equal(checkSender(msg(), undefined as any).ok, false)
  assert.match(checkSender(msg(), []).reason!, /empty/)
})

test('receive: allowlisted sender with aligned DMARC pass is accepted; plus tags are the same mailbox', () => {
  const v = checkSender(msg(), [OWNER])
  assert.equal(v.ok, true)
  assert.equal(v.from, 'owner@example.org')
})

test('receive: sender not on the allowlist is rejected', () => {
  const v = checkSender(msg({ from: 'eve@example.org', headers: { from: 'eve@example.org' } }), [OWNER])
  assert.equal(v.ok, false)
  assert.match(v.reason!, /allowlist/)
})

test('receive: From must be exactly one address', () => {
  assert.equal(checkSender(msg({ from: null, headers: {} }), [OWNER]).reason, 'no From address')
  const two = msg({ headers: { from: 'owner@example.org, eve@evil.com' } })
  assert.equal(checkSender(two, [OWNER]).reason, 'more than one From address')
  const differ = msg({ headers: { from: 'eve@evil.com' } })
  assert.equal(checkSender(differ, [OWNER]).ok, false)
  // A quoted display name that looks like an address is not a second address.
  assert.deepEqual(parseAddresses('"eve@evil.com" <owner@example.org>'), ['owner@example.org'])
  assert.equal(singleFrom(msg({ headers: { from: '"eve@evil.com" <owner@example.org>' } })).ok, true)
})

test('receive: comments and quoted strings are read as RFC 5322 reads them; anything unclear is not one address', () => {
  // A comment ends at its own `)`; a quote inside it opens nothing.
  assert.deepEqual(parseAddresses('(owner@example.org ") attacker@evil.example (")'), [])
  assert.deepEqual(parseAddresses('owner@example.org (Owner)'), ['owner@example.org'])
  assert.deepEqual(parseAddresses('"Doe, J (work)" <owner@example.org>'), ['owner@example.org'])
  assert.deepEqual(parseAddresses('Grp: owner@example.org;'), ['owner@example.org'])
  for (const unclear of [
    '(") attacker@evil.example ("owner@example.org) ',
    '"a\\" <owner@example.org> \\"b" <attacker@evil.example>',
    '(unclosed owner@example.org',
    'owner@example.org)',
    '"unclosed <owner@example.org>',
    '<owner@example.org',
    '<<owner@example.org>>',
    '"owner"@example.org',
    'owner@example.org@evil.example',
    '<@evil.example:owner@example.org>',
    'x'.repeat(5000) + ' <owner@example.org>',
  ]) assert.deepEqual(parseAddresses(unclear), [], unclear)
  const trick = msg({ from: 'owner@example.org', headers: { from: '(owner@example.org ") attacker@evil.example (")' } })
  assert.equal(checkSender(trick, [OWNER]).ok, false)
  // A From header that is there but unclear is never replaced by the provider's own field.
  const unclear = msg({ from: 'owner@example.org', headers: { from: '"owner@example.org' } })
  assert.equal(checkSender(unclear, [OWNER]).ok, false)
  assert.equal(checkSender(msg({ from: 'owner@example.org', headers: { from: 'undisclosed' } }), [OWNER]).ok, false)
})

test('receive: DMARC must pass and be aligned', () => {
  assert.equal(checkSender(msg({ authentication: { dmarc: { result: 'fail', aligned: true } } }), [OWNER]).ok, false)
  assert.equal(checkSender(msg({ authentication: { dmarc: { result: 'pass', aligned: false } } }), [OWNER]).ok, false)
  assert.equal(checkSender(msg({ authentication: {} }), [OWNER]).ok, false)
  assert.equal(checkSender(msg({ authentication: undefined }), '*').ok, false)
})

test('receive: bounces are recognised', () => {
  assert.equal(isBounce(msg({ from: 'MAILER-DAEMON@mx.example.com', headers: { from: 'MAILER-DAEMON@mx.example.com' } })), true)
  assert.equal(isBounce(msg({ envelope: { mail_from: '' } })), true)
  assert.equal(isBounce(msg({ headers: { from: 'owner@example.org', 'content-type': 'multipart/report; report-type=delivery-status' } })), true)
  assert.equal(isBounce(msg({ envelope: { mail_from: null } })), true)
  assert.equal(isBounce(msg()), false)
})

test('receive: Auto-Submitted and X-Loop mail is automated', () => {
  assert.equal(isAutomated(msg({ headers: { from: 'a@b.com', 'auto-submitted': 'auto-replied' } })), true)
  assert.equal(isAutomated(msg({ headers: { from: 'a@b.com', 'x-loop': 'clankerinbox' } })), true)
  assert.equal(isAutomated(msg({ headers: { from: 'a@b.com', precedence: 'bulk' } })), true)
  assert.equal(isAutomated(msg({ headers: { from: 'a@b.com', 'auto-submitted': 'no' } })), false)
  assert.equal(isAutomated(msg()), false)
})

test('receive: the marks of another agent of this tool are told apart from auto-replies and lists', () => {
  const kind = (headers: Record<string, string | string[]>) => automation(msg({ headers: { from: 'a@b.com', ...headers } }))
  assert.equal(kind({}), null)
  assert.equal(kind({ 'auto-submitted': 'no' }), null)
  // What another agent sends, and PostShiba (which adds Auto-Submitted to all it sends) too.
  assert.equal(kind({ 'auto-submitted': 'auto-generated' }), AGENT_MAIL)
  assert.equal(kind({ 'x-loop': 'clankerinbox' }), AGENT_MAIL)
  assert.equal(kind({ 'auto-submitted': 'Auto-Generated', 'x-loop': 'ClankerInbox' }), AGENT_MAIL)
  assert.equal(kind({ 'auto-submitted': ['auto-generated', 'auto-generated'], 'x-loop': 'clankerinbox' }), AGENT_MAIL)
  assert.equal(kind({ 'auto-submitted': 'auto-generated; owner-email="x@b.com"' }), AGENT_MAIL)
  // Anything more is a robot that could answer back for ever.
  assert.match(kind({ 'auto-submitted': 'auto-replied' })!, /auto-reply/)
  assert.match(kind({ 'auto-submitted': 'auto-generated, auto-replied' })!, /auto-reply/)
  assert.match(kind({ 'auto-submitted': 'auto-notified' })!, /auto-reply/)
  assert.match(kind({ 'x-loop': 'helpdesk@b.com' })!, /X-Loop/)
  assert.match(kind({ 'x-loop': ['clankerinbox', 'other'] })!, /X-Loop/)
  assert.match(kind({ 'x-loop': ' ' })!, /X-Loop/)
  assert.match(kind({ 'auto-submitted': 'auto-generated', precedence: 'bulk' })!, /Precedence/)
  assert.match(kind({ precedence: 'Bulk; x=1' })!, /Precedence/)
  assert.match(kind({ precedence: 'list' })!, /Precedence/)
  assert.match(kind({ precedence: 'auto_reply' })!, /Precedence/)
  assert.equal(kind({ precedence: 'first-class' }), null)
  assert.match(kind({ 'x-autoreply': 'yes', 'auto-submitted': 'auto-generated' })!, /auto-reply/)
  assert.match(kind({ 'x-autorespond': 'yes' })!, /auto-reply/)
  assert.match(kind({ 'list-id': '<team.example.org>' })!, /mailing list/)
  assert.match(kind({ 'list-unsubscribe': '<mailto:x@b.com>', 'x-loop': 'clankerinbox' })!, /mailing list/)
})

test('send: allowlist refuses any other recipient; own inboxes are allowed', () => {
  const inbox: InboxConfig = { id: 'i', address: 'ask@inbox.example.dev', mode: 'answers', allow: [OWNER], send: [OWNER] }
  const own = ['ask@inbox.example.dev', 'signup@inbox.example.dev']
  assert.equal(checkRecipients([OWNER], inbox, own).ok, true)
  assert.equal(checkRecipients(['Owner <owner+clankerinbox@example.org>'], inbox, own).ok, true)
  assert.equal(checkRecipients(['signup+t1@inbox.example.dev'], inbox, own).ok, true)
  assert.equal(checkRecipients(['eve@evil.com'], inbox, own).ok, false)
  assert.equal(checkRecipients([OWNER, 'eve@evil.com'], inbox, own).ok, false)
  assert.equal(checkRecipients(['owner@example.org, eve@evil.com'], inbox, own).ok, false)
  assert.equal(checkRecipients([], inbox, own).ok, false)
  assert.equal(checkRecipients([OWNER], { ...inbox, send: [] }, own).ok, false)
})

test('quoted text is stripped before the answer is read', () => {
  const gmail = 'Option B please\n\nOn Mon, 9 Nov 2026 at 15:02, Clanker Inbox <clankerinbox@inbox.example.dev> wrote:\n> Which one?\n> 1. Option A\n> 2. Option B\n'
  assert.equal(stripQuoted(gmail), 'Option B please')
  const wrapped = 'yes\n\nOn Mon, 9 Nov 2026 at 15:02, Clanker Inbox <\nclankerinbox@inbox.example.dev> wrote:\n> q'
  assert.equal(stripQuoted(wrapped), 'yes')
  const outlook = 'go ahead\r\n\r\nFrom: Clanker Inbox <a@b.com>\r\nSent: Monday\r\nTo: Owner\r\nSubject: q\r\n\r\nWhich one?'
  assert.equal(stripQuoted(outlook), 'go ahead')
  assert.equal(stripQuoted('ok\n-- \nOwner'), 'ok')
  assert.equal(stripQuoted('ok\n\nSent from my iPhone'), 'ok')
  assert.equal(stripQuoted('> only a quote'), '')
  assert.equal(stripQuoted(null), '')
})

test('answers match options by number or text, else stay free text', () => {
  const opts = ['Ship it', 'Wait']
  assert.equal(matchOption('2', opts), 'Wait')
  assert.equal(matchOption('ship it.', opts), 'Ship it')
  assert.equal(matchOption('Wait\nbecause reasons', opts), 'Wait')
  assert.equal(matchOption('3', opts), null)
  assert.equal(matchOption('maybe later', opts), null)
  assert.equal(matchOption('', opts), null)
})

test('codes: 4–8 digit code is extracted, preferring one near code words', () => {
  assert.deepEqual(extractCode('Your verification code is 482913', ''), { code: '482913' })
  assert.deepEqual(extractCode('Welcome', 'Order 2026 shipped. Your code: 7731'), { code: '7731' })
  assert.deepEqual(extractCode('Sign in', 'Use 123-456 to log in'), { code: '123456' })
  assert.deepEqual(extractCode('Hi', 'no digits here 12 or 123456789'), {})
})

test('codes: a sign-in link is returned when there is no code', () => {
  assert.deepEqual(
    extractCode('Log in to Tool', 'Click https://tool.example.com/auth/magic?token=abc. Thanks'),
    { link: 'https://tool.example.com/auth/magic?token=abc' },
  )
  assert.deepEqual(extractCode('News', 'Read https://tool.example.com/blog'), {})
  // A footer ZIP code does not beat the sign-in link.
  assert.deepEqual(
    extractCode('Your sign-in link', 'Open https://tool.example.com/magic/abc\n\nTool Inc, San Francisco, CA 94107'),
    { link: 'https://tool.example.com/magic/abc' },
  )
})

test('mail log masks codes and link secrets', () => {
  assert.equal(maskSecrets('code 482913'), 'code ••••••')
  assert.equal(maskSecrets('code 482-913 or 482 913'), 'code •••-••• or ••• •••')
  assert.equal(maskSecrets('open https://x.dev/verify?t=abc now'), 'open https://x.dev/… now')
  assert.equal(maskSecrets('open https://x.dev/magic/Zm9vYmFy, then'), 'open https://x.dev/…, then')
  assert.equal(maskSecrets('see https://x.dev/ or https://x.dev'), 'see https://x.dev/ or https://x.dev')
  assert.equal(maskSecrets('https://x.dev?t=abc'), 'https://x.dev/…')
  // What is no code stays: short numbers, phone numbers, dates, years in words.
  assert.equal(maskSecrets('option 2, call +1 415 555 0123 on 2026-11-10'), 'option 2, call +1 415 555 0123 on 2026-11-10')
})

test('terminal control sequences from mail never reach the terminal; attachment names stay plain names', () => {
  assert.equal(cleanText('ok\u001b[2K\u001b[1A\r✓ done'), 'ok✓ done')
  assert.equal(cleanText('a\u001b]8;;https://evil.example\u0007link\u001b]8;;\u001b\\b'), 'alinkb')
  assert.equal(cleanText('a\u009b31mb\u0085c\u0007d\u202ee'), 'abcde')
  assert.equal(cleanText('line 1\nline 2\ttab'), 'line 1\nline 2\ttab')
  assert.equal(cleanLine('Subject\nBcc: x\u001b[31m'), 'Subject Bcc: x')
  assert.equal(safeFilename('../../.ssh/authorized_keys'), '.._.._.ssh_authorized_keys')
  assert.equal(safeFilename('a\u001b[31m\r\nb.txt'), 'a b.txt')
  assert.equal(safeFilename('C:\\Windows\\x.dll'), 'C:_Windows_x.dll')
  for (const bad of ['..', '.', '', '\u001b']) assert.equal(safeFilename(bad), 'attachment')
})

test('codes: no digits out of phone numbers, dates or longer runs; a code near code words wins', () => {
  assert.deepEqual(extractCode('Verify your email', 'Click the button in the app to verify. Questions? Call us at +1 415 555 0123.'), {})
  assert.deepEqual(extractCode('Hi', 'Call (415) 555-0123 or 415.555.0123 or 415 555 0123'), {})
  assert.deepEqual(extractCode('Your code', 'On 10/11/2026 at 10:00. Your one-time code: 4821'), { code: '4821' })
  assert.deepEqual(extractCode('Your code', 'Reference 2026-11-10-4471. Your code is 482 913'), { code: '482913' })
  assert.deepEqual(extractCode('Hi', 'Order 55512 shipped.\n\nYour verification code is 9921.'), { code: '9921' })
  assert.deepEqual(extractCode('Your code', 'code 31337420'), { code: '31337420' })
  assert.deepEqual(extractCode('Your code', 'Your PIN: 12345678901'), {})
})

test('codes: a link is https to a public host, and to the expected domain when one is given', () => {
  for (const bad of [
    'Sign in: https://127.0.0.1:8080/admin/reset?confirm=1',
    'Sign in: https://0x7f.1/login',
    'Sign in: https://[::1]/login',
    'Sign in: https://localhost/login',
    'Sign in: https://intranet/login',
    'Sign in: https://db.internal/login',
    'Sign in: https://printer.local/login',
    'Sign in: https://github.com@evil.example/login',
    'Sign in: http://service.example/login',
  ]) assert.deepEqual(extractCode('Sign in', bad), {}, bad)
  const mail = 'Log in: https://login.service.example/magic?t=1 or https://evil.example/login?t=2'
  assert.deepEqual(extractCode('Log in', mail), { link: 'https://login.service.example/magic?t=1' })
  assert.deepEqual(extractCode('Log in', mail, { domain: 'service.example' }), { link: 'https://login.service.example/magic?t=1' })
  assert.deepEqual(extractCode('Log in', 'https://evil.example/login?t=2', { domain: 'service.example' }), {})
  assert.deepEqual(extractCode('Log in', 'https://notservice.example/login', { domain: 'service.example' }), {})
})

test('codes: --from takes a domain, an address or a URL, in any case, with or without a trailing dot', () => {
  for (const v of ['service.example', '@service.example', 'no-reply@service.example', 'SERVICE.EXAMPLE.', 'https://service.example/x', ' service.example ']) {
    assert.equal(senderDomain(v), 'service.example', v)
  }
  for (const v of ['', 'not a domain', 'https://', 'a@b@c', 'localhost']) assert.throws(() => senderDomain(v), /--from/, v)
})

test('options: exact text beats an index, an index is plain digits in range, natural forms are read', () => {
  assert.equal(matchOption('1', ['4', '2', '1']), '1')
  assert.equal(matchOption('2', ['3', '2']), '2')
  assert.equal(matchOption('10', ['5', '10']), '10')
  assert.equal(matchOption('3', ['5', '10']), null)
  const opts = ['Yes, ship it', 'Wait until Monday', 'Cancel']
  for (const [reply, want] of [
    ['1)', 'Yes, ship it'], ['1.', 'Yes, ship it'], ['#1', 'Yes, ship it'], ['option 1', 'Yes, ship it'], ['Option #2', 'Wait until Monday'],
    ['  2  ', 'Wait until Monday'], ['２', 'Wait until Monday'], ['​2', 'Wait until Monday'],
    ['yes', 'Yes, ship it'], ['wait', 'Wait until Monday'], ['yes, ship it', 'Yes, ship it'], ['Yes, ship it.', 'Yes, ship it'],
    ['wait until monday!', 'Wait until Monday'], ['"Cancel"', 'Cancel'], ['*Cancel*', 'Cancel'], ['Cancel.\n\nThanks,\nOwner', 'Cancel'],
    ['Thanks!\n2', 'Wait until Monday'], ['Hi,\n\n2\n\nOwner', 'Wait until Monday'],
  ] as [string, string][]) assert.equal(matchOption(reply, opts), want, JSON.stringify(reply))
  for (const reply of [
    '4', '0', '0x2', '+2', '1e0', '1.0', '-1', '3 because the build failed', '10 minutes', 'the first one', 'Cancel?', 'w',
    '👍', '٢', 'maybe later', '', 'Thanks!\nmaybe', 'Sure thing, but first:\n2',
  ]) assert.equal(matchOption(reply, opts), null, JSON.stringify(reply))
  // A prefix that fits two options picks neither.
  assert.equal(matchOption('ship', ['Ship it now', 'Ship it Monday']), null)
  assert.equal(matchOption('Ship it!', ['Ship it!', 'Wait']), 'Ship it!')
})
