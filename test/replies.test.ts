// Real reply styles: what each mail client sends back, and the answer and option read from it.
// The quoted question (with its numbered options) must never become the answer, and the owner's
// own words must never be lost.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stripQuoted, matchOption, answerText, htmlAnswer } from '../src/safety.ts'

const ASK = 'bot@inbox.example.dev'
const OWNER = 'owner@example.org'
const OPTS = ['Yes, ship it', 'Wait until Monday', 'Cancel']
const QT = (pfx = '> ') => [`${pfx}Ship the release?`, `${pfx}`, `${pfx}Reply with a number or your own answer:`, `${pfx}`, `${pfx}1. Yes, ship it`, `${pfx}2. Wait until Monday`, `${pfx}3. Cancel`].join('\n')

// [name, reply text, expected answer, expected option]
const CASES: [string, string, string, string | null][] = [
  ['gmail web', `1\n\nOn Tue, Nov 10, 2026 at 10:00 AM Bot <${ASK}> wrote:\n\n${QT()}\n`, '1', 'Yes, ship it'],
  ['gmail android', `2\n\nOn Tue, 10 Nov 2026, 10:00 Bot, <${ASK}> wrote:\n\n${QT()}\n`, '2', 'Wait until Monday'],
  ['apple mail', `Yes, ship it\n\n> On 10 Nov 2026, at 10:00, Bot <${ASK}> wrote:\n> \n${QT()}\n`, 'Yes, ship it', 'Yes, ship it'],
  ['ios mail sent from', `Cancel\n\nSent from my iPhone\n\n> On 10 Nov 2026, at 10:00, Bot <${ASK}> wrote:\n> \n${QT()}\n`, 'Cancel', 'Cancel'],
  ['ios mail top-only sig', `3\nSent from my iPhone`, '3', 'Cancel'],
  ['outlook desktop', `1\r\n\r\n-----Original Message-----\r\nFrom: Bot <${ASK}>\r\nSent: Tuesday, November 10, 2026 10:00 AM\r\nTo: Owner <${OWNER}>\r\nSubject: Ship the release?\r\n\r\n${QT('')}`, '1', 'Yes, ship it'],
  ['outlook desktop new', `go with 2\r\n\r\n________________________________\r\nFrom: Bot <${ASK}>\r\nSent: Tuesday, November 10, 2026 10:00 AM\r\nTo: Owner\r\nSubject: Ship the release?\r\n\r\n${QT('')}`, 'go with 2', null],
  ['outlook desktop bold From (no blank)', `2\r\nFrom: Bot <${ASK}>\r\nSent: Tuesday, November 10, 2026 10:00 AM\r\nTo: Owner\r\nSubject: Ship\r\n\r\n${QT('')}`, '2', 'Wait until Monday'],
  ['outlook mobile', `2\n\nGet Outlook for iOS<https://aka.ms/o0ukef>\n________________________________\nFrom: Bot <${ASK}>\nSent: Tuesday, November 10, 2026 10:00:00 AM\nTo: owner@example.org <${OWNER}>\nSubject: Ship the release?\n\n${QT('')}`, '2', 'Wait until Monday'],
  ['outlook mobile no-sep', `2\n\nGet Outlook for Android\nFrom: Bot <${ASK}>\nSent: Tuesday, November 10, 2026 10:00:00 AM\nTo: owner@example.org\nSubject: Ship the release?\n\n${QT('')}`, '2', 'Wait until Monday'],
  ['fastmail', `1\n\nOn Tue, 10 Nov 2026, at 10:00, Bot wrote:\n${QT()}`, '1', 'Yes, ship it'],
  ['proton', `2\n\nSent with Proton Mail secure email.\n\nOn Tuesday, November 10th, 2026 at 10:00, Bot <${ASK}> wrote:\n\n${QT()}`, '2', 'Wait until Monday'],
  ['hey', `1\n\n--\nOwner\n\nOn November 10, 2026, Bot <${ASK}> wrote:\n${QT()}`, '1', 'Yes, ship it'],
  ['superhuman', `Yes, ship it\n\nOn Tue, Nov 10, 2026 at 10:00 AM, Bot <${ASK}> wrote:\n\n${QT()}\n`, 'Yes, ship it', 'Yes, ship it'],
  ['sig -- block', `2\n\n-- \nOwner Name\nCEO, Example\n+31 6 1234`, '2', 'Wait until Monday'],
  ['sig -- then quote', `2\n-- \nOwner\n\nOn Tue Bot wrote:\n${QT()}`, '2', 'Wait until Monday'],
  ['bottom posting', `${QT()}\n\n1`, '1', 'Yes, ship it'],
  ['bottom posting w header', `On Tue, Nov 10, 2026 at 10:00 AM Bot <${ASK}> wrote:\n${QT()}\n\nWait until Monday please`, 'Wait until Monday please', null],
  ['bottom posting w signature', `${QT()}\n\n2\n\n-- \nOwner`, '2', 'Wait until Monday'],
  ['inline reply', `On Tue, Nov 10, 2026 at 10:00 AM Bot <${ASK}> wrote:\n> Ship the release?\n\nNo, wait, the tests are red.\n\n> 1. Yes, ship it\n`, 'No, wait, the tests are red.', null],
  ['inline reply no header', `> Ship the release?\n\nWait until Monday\n\n> 1. Yes, ship it\n`, 'Wait until Monday', 'Wait until Monday'],
  ['inline reply two parts', `> Ship the release?\n\nNot today.\n\n> 1. Yes, ship it\n\nMonday is fine.`, 'Not today.\n\nMonday is fine.', null],
  ['dutch', `2\n\nOp di 10 nov 2026 om 10:00 schreef Bot <${ASK}>:\n\n${QT()}`, '2', 'Wait until Monday'],
  ['dutch wrapped', `2\n\nOp di 10 nov 2026 om 10:00 schreef Bot <\n${ASK}>:\n\n${QT()}`, '2', 'Wait until Monday'],
  ['german', `1\n\nAm Di., 10. Nov. 2026 um 10:00 Uhr schrieb Bot <${ASK}>:\n${QT()}`, '1', 'Yes, ship it'],
  ['german apple', `1\n\n> Am 10.11.2026 um 10:00 schrieb Bot <${ASK}>:\n${QT()}`, '1', 'Yes, ship it'],
  ['french', `3\n\nLe mar. 10 nov. 2026 à 10:00, Bot <${ASK}> a écrit :\n${QT()}`, '3', 'Cancel'],
  ['french wrapped', `3\n\nLe mar. 10 nov. 2026 à 10:00, Bot <${ASK}> a\nécrit :\n${QT()}`, '3', 'Cancel'],
  ['spanish', `1\n\nEl mar, 10 nov 2026 a las 10:00, Bot (<${ASK}>) escribió:\n${QT()}`, '1', 'Yes, ship it'],
  ['italian', `2\n\nIl giorno mar 10 nov 2026 alle ore 10:00 Bot <${ASK}> ha scritto:\n${QT()}`, '2', 'Wait until Monday'],
  ['portuguese', `2\n\nEm ter., 10 de nov. de 2026 às 10:00, Bot <${ASK}> escreveu:\n${QT()}`, '2', 'Wait until Monday'],
  ['swedish', `2\n\nDen tis 10 nov. 2026 kl 10:00 skrev Bot <${ASK}>:\n${QT()}`, '2', 'Wait until Monday'],
  ['norwegian', `2\n\ntir. 10. nov. 2026 kl. 10:00 skrev Bot <${ASK}>:\n${QT()}`, '2', 'Wait until Monday'],
  ['danish wrapped', `2\n\nDen 10. nov. 2026 kl. 10.00 skrev Bot\n<${ASK}>:\n${QT()}`, '2', 'Wait until Monday'],
  ['english wrapped 3 lines', `1\n\nOn Tue, Nov 10, 2026 at 10:00 AM Bot Name\n<${ASK}>\nwrote:\n${QT()}`, '1', 'Yes, ship it'],
  ['emoji only', `👍\n\nOn Tue Bot wrote:\n${QT()}`, '👍', null],
  ['yes vs option', `yes`, 'yes', 'Yes, ship it'],
  ['Yes, ship it lowercase', `yes, ship it`, 'yes, ship it', 'Yes, ship it'],
  ['1.', `1.`, '1.', 'Yes, ship it'],
  ['1)', `1)`, '1)', 'Yes, ship it'],
  ['option 1', `option 1`, 'option 1', 'Yes, ship it'],
  ['#1', `#1`, '#1', 'Yes, ship it'],
  ['the first one', `the first one`, 'the first one', null],
  ['10 minutes', `10 minutes`, '10 minutes', null],
  ['2 days', `2 days from now`, '2 days from now', null],
  ['3 with text', `3 because the build failed`, '3 because the build failed', null],
  ['" 2 "', `  2  `, '2', 'Wait until Monday'],
  ['2 with blank lines', `\n\n2\n`, '2', 'Wait until Monday'],
  ['1.0', `1.0`, '1.0', null],
  ['0x2', `0x2`, '0x2', null],
  ['+2', `+2`, '+2', null],
  ['1e0', `1e0`, '1e0', null],
  ['answer starts with >', `>2 weeks is too long, ship it now`, '>2 weeks is too long, ship it now', null],
  ['contains On Monday I wrote:', `Ship it.\nOn Monday I wrote: hold.\nNow go.`, 'Ship it.\nOn Monday I wrote: hold.\nNow go.', null],
  ['On ... then a line with wrote:', `On second thought, wait.\nYou wrote: ship? No.`, 'On second thought, wait.\nYou wrote: ship? No.', null],
  ['answer with "Sent from my"', `Sent from my laptop because phone died: 2`, 'Sent from my laptop because phone died: 2', null],
  ['answer with From: line', `From: the team: wait\nTo: you: ok\n`, 'From: the team: wait\nTo: you: ok', null],
  ['answer with -- inside', `wait\n--\nreason: tests`, 'wait', 'Wait until Monday'],
  ['answer then forward line', `Yes\n---------- Forwarded message ---------\nFrom: x`, 'Yes', 'Yes, ship it'],
  ['empty', ``, '', null],
  ['only white space and a quote', `\n\nOn Tue Bot wrote:\n${QT()}`, '', null],
  ['forwarded instead of reply', `---------- Forwarded message ---------\nFrom: Bot <${ASK}>\nDate: Tue\nSubject: Ship\nTo: <${OWNER}>\n\n${QT('')}`, '', null],
  ['forward with note', `FYI 1\n\n---------- Forwarded message ---------\nFrom: Bot <${ASK}>\nDate: Tue\nSubject: Ship\nTo: <${OWNER}>\n\n${QT('')}`, 'FYI 1', null],
  ['lowercase with !', `wait until monday!`, 'wait until monday!', 'Wait until Monday'],
  ['Cancel?', `Cancel?`, 'Cancel?', null],
  ['cancel. with sign-off', `Cancel.\n\nThanks,\nOwner`, 'Cancel.\n\nThanks,\nOwner', 'Cancel'],
  ['Thanks then 2', `Thanks!\n2`, 'Thanks!\n2', 'Wait until Monday'],
  ['Hi, 2, name', `Hi,\n\n2\n\nOwner`, 'Hi,\n\n2\n\nOwner', 'Wait until Monday'],
  ['trailing space', `1 \n\nOn Tue Bot wrote:\n${QT()}`, '1', 'Yes, ship it'],
  ['zero width', `​2`, '​2', 'Wait until Monday'],
  ['fullwidth 2', `２`, '２', 'Wait until Monday'],
  ['arabic digit', `٢`, '٢', null],
  ['option text plus period', `Yes, ship it.`, 'Yes, ship it.', 'Yes, ship it'],
  ['option text with quotes', `"Cancel"`, '"Cancel"', 'Cancel'],
  ['option text with *bold*', `*Cancel*`, '*Cancel*', 'Cancel'],
  ['outlook html as text', `2\r\n\r\n\r\n\r\nFrom: Bot <${ASK}>\r\nDate: Tuesday, 10 November 2026 at 10:00\r\nTo: Owner <${OWNER}>\r\nSubject: Ship the release?\r\n\r\n${QT('')}`, '2', 'Wait until Monday'],
  ['outlook web, Dutch', `2\r\n\r\n________________________________\r\nVan: Bot <${ASK}>\r\nVerzonden: dinsdag 10 november 2026 10:00\r\nAan: Owner\r\nOnderwerp: Ship\r\n\r\n${QT('')}`, '2', 'Wait until Monday'],
  ['outlook Dutch, no line', `2\r\n\r\nVan: Bot <${ASK}>\r\nVerzonden: dinsdag 10 november 2026 10:00\r\nAan: Owner\r\nOnderwerp: Ship\r\n\r\n${QT('')}`, '2', 'Wait until Monday'],
  ['outlook German', `2\r\n\r\nVon: Bot <${ASK}>\r\nGesendet: Dienstag, 10. November 2026 10:00\r\nAn: Owner\r\nBetreff: Ship\r\n\r\n${QT('')}`, '2', 'Wait until Monday'],
  ['outlook French', `2\r\n\r\nDe : Bot <${ASK}>\r\nEnvoyé : mardi 10 novembre 2026 10:00\r\nÀ : Owner\r\nObjet : Ship\r\n\r\n${QT('')}`, '2', 'Wait until Monday'],
  ['outlook Spanish', `2\r\n\r\nDe: Bot <${ASK}>\r\nEnviado: martes, 10 de noviembre de 2026 10:00\r\nPara: Owner\r\nAsunto: Ship\r\n\r\n${QT('')}`, '2', 'Wait until Monday'],
  ['yahoo', `2\n\n    On Tuesday, November 10, 2026 at 10:00:00 AM GMT+1, Bot <${ASK}> wrote:  \n\n ${QT('')}`, '2', 'Wait until Monday'],
]

for (const [name, text, answer, option] of CASES) {
  test(`reply style: ${name}`, () => {
    const got = stripQuoted(text)
    assert.equal(got, answer)
    assert.equal(got ? matchOption(got, OPTS) : null, option)
    // The answer of a text-only reply reads the same option.
    const full = answerText(text)
    assert.equal(full ? matchOption(full, OPTS) : null, option)
  })
}

// A real Gmail reply, with the name, the company and the addresses replaced. The signature has no
// "-- " line: only the HTML part marks it (gmail_signature), and the quote (gmail_quote).
const REAL_OPTS = ['It works', 'Something is off']
const GMAIL_TEXT = [
  '1', '', '', 'Owner Name', 'Founder at ExampleCo',
  '[image: LinkedIn] <https://www.card.example/x/linkedin> [image:', 'X] <https://www.card.example/x/x> [image: Reviews]',
  '<https://www.card.example/x/reviews>', '[image: QR code for my digital business card]', '<https://www.card.example/x/qr>',
  'Scan to save', 'my contact', '[image: Create your free email signature: Try it now]', '<https://www.card.example/x>', '',
  'On Wed, 11 Nov 2026 at 11:37, Clanker Inbox <', 'clankerinbox@inbox.example.dev> wrote:', '',
  '> Reply with a number or your own answer:', '>', '> 1. It works', '> 2. Something is off', '>', '',
].join('\n')
const GMAIL_SIGNATURE = '<div dir="ltr" class="gmail_signature" data-smartmail="gmail_signature"><div dir="ltr"><table cellpadding="0" cellspacing="0" border="0"><tbody>'
  + '<tr><td><img src="https://cdn.card.example/a.png" alt="" width="80" height="80"></td><td><table><tbody>'
  + '<tr><td style="font-size:17px;font-weight:700">Owner Name</td></tr><tr><td style="font-size:13px">Founder at ExampleCo</td></tr>'
  + '<tr><td><a href="https://www.card.example/x/linkedin" target="_blank"><img src="https://cdn.card.example/li.png" alt="LinkedIn"></a></td></tr>'
  + '</tbody></table></td><td align="right"><a href="https://www.card.example/x/qr"><img alt="QR code for my digital business card"></a>'
  + '<div>Scan to save<br>my contact</div></td></tr></tbody></table></div></div>'
const GMAIL_QUOTE = '<div class="gmail_quote gmail_quote_container"><div dir="ltr" class="gmail_attr">On Wed, 11 Nov 2026 at 11:37, Clanker Inbox &lt;<a href="mailto:clankerinbox@inbox.example.dev">clankerinbox@inbox.example.dev</a>&gt; wrote:<br></div>'
  + '<blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left-width:1px;border-left-style:solid;padding-left:1ex">Reply with a number or your own answer:<br>\n<br>\n1. It works<br>\n2. Something is off<br>\n</blockquote></div>'
const GMAIL_HTML = `<div dir="auto">1</div><div><br clear="all"><br clear="all"><div>${GMAIL_SIGNATURE}</div></div><div><br>${GMAIL_QUOTE}</div>\n`

// [name, text part, HTML part, expected answer, expected option]
const HTML_CASES: [string, string, string | undefined, string, string | null][] = [
  ['gmail, real: signature without "-- "', GMAIL_TEXT, GMAIL_HTML, '1', 'It works'],
  ['gmail, real, text part only: the signature stays (nothing marks it)', GMAIL_TEXT, undefined, stripQuoted(GMAIL_TEXT), 'It works'],
  ['gmail, two lines and a signature', 'Not yet.\nThe tests are red.\n\nOwner Name\n\nOn Wed Bot wrote:\n> q\n',
    `<div dir="ltr">Not yet.<div>The tests are red.</div><br clear="all"><div>${GMAIL_SIGNATURE}</div></div><br>${GMAIL_QUOTE}`, 'Not yet.\nThe tests are red.', null],
  ['apple mail, iOS signature and a cited quote', '2\n\nSent from my iPhone\n\n> On 10 Nov 2026, at 10:00, Bot wrote:\n> 1. It works\n',
    '<html><body dir="auto"><div>2</div><div><br><div dir="ltr" id="AppleMailSignature">Owner Name<br>ExampleCo</div><div dir="ltr"><br><blockquote type="cite">On 10 Nov 2026, at 10:00, Bot wrote:<br><br>1. It works</blockquote></div></div></body></html>', '2', 'Something is off'],
  ['outlook, signature and reply header', 'Something is off\n\nOwner Name\nExampleCo\n\n________________________________\nFrom: Bot\nSent: Tuesday\nTo: Owner\nSubject: q\n\n1. It works',
    '<div style="font-family:Aptos">Something is off</div><div id="Signature"><p>Owner Name</p><p>ExampleCo</p></div><div id="appendonsend"></div><hr><div id="divRplyFwdMsg"><b>From:</b> Bot</div><div>1. It works</div>', 'Something is off', 'Something is off'],
  ['thunderbird, moz-signature and cite prefix', '1\n\n-- \nOwner\n\nOn 10/11/2026 10:00, Bot wrote:\n> 1. It works',
    '<p>1</p><div class="moz-signature">-- <br>Owner Name<br>ExampleCo</div><div class="moz-cite-prefix">On 10/11/2026 10:00, Bot wrote:<br></div><blockquote type="cite">1. It works</blockquote>', '1', 'It works'],
  ['html without marks: the text part decides', '2\n\nOn Tue Bot wrote:\n> 1. It works', '<div>2</div><div>On Tue Bot wrote:</div><div>1. It works</div>', '2', 'Something is off'],
  ['bottom-posted html: the text part decides', '> 1. It works\n> 2. Something is off\n\n2', '<blockquote type="cite">1. It works<br>2. Something is off</blockquote><div>2</div>', '2', 'Something is off'],
  ['text only: a signature that the quoted earlier mail of the sender repeats is cut',
    'Ship it now.\n\nOwner Name\nFounder at ExampleCo\n\nOn Tue, Bot <bot@inbox.example.dev> wrote:\n> Ready?\n>\n>> Should I wait?\n>>\n>> Owner Name\n>> Founder at ExampleCo\n', undefined, 'Ship it now.', null],
  ['text only: a last paragraph that the quote does not repeat stays', 'Ship it now.\n\nOwner Name\nFounder at ExampleCo\n\nOn Tue, Bot wrote:\n> Ready?\n', undefined, 'Ship it now.\n\nOwner Name\nFounder at ExampleCo', null],
  ['text only: one repeated line is not enough', '2\n\nOwner\n\nOn Tue, Bot wrote:\n> Owner\n', undefined, '2\n\nOwner', 'Something is off'],
]

for (const [name, text, html, answer, option] of HTML_CASES) {
  test(`reply with HTML: ${name}`, () => {
    const got = answerText(text, html)
    assert.equal(got, answer)
    assert.equal(got ? matchOption(got, REAL_OPTS) : null, option)
  })
}

test('reply with HTML: a hostile part is read in linear time and gives nothing', () => {
  const t0 = Date.now()
  assert.equal(htmlAnswer('<div class="' + 'a'.repeat(2_000_000)), null)
  assert.equal(htmlAnswer('<blockquote ' + ' type'.repeat(400_000) + '>'), null)
  assert.equal(htmlAnswer('<'.repeat(1_000_000)), null)
  assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`)
})
