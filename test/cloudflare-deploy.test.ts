import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tail } from '../src/cloudflare-deploy.ts'

test('tail shows the ✘ [ERROR] block of wrangler, without bug-report and log lines', () => {
  const err = [
    '▲ [WARNING] 🚧 `wrangler email sending enable` is an open beta command.',
    '',
    '✘ [ERROR] A request to the Cloudflare API (/zones/z1/email/sending/subdomains) failed.',
    '',
    '  Unauthorized [code: 2036]',
    '  ',
    '  If you think this is a bug, please open an issue at: https://github.com/cloudflare/workers-sdk/issues/new/choose',
    '🪵  Logs were written to "/x/wrangler.log"',
  ].join('\n')
  assert.equal(tail({ code: 1, out: '', err }), 'A request to the Cloudflare API (/zones/z1/email/sending/subdomains) failed. Unauthorized [code: 2036]')
  // The lines of a partial success on stdout do not join the error.
  assert.equal(tail({ code: 1, out: 'Deployed clankerinbox triggers (4.63 sec)', err: '✘ [ERROR] Cron schedules failed.\n  - You need a workers.dev subdomain. [code: 10063]' }),
    'Cron schedules failed. You need a workers.dev subdomain. [code: 10063]')
  assert.equal(tail({ code: 2, out: 'a\nb', err: '' }), 'a b')
})
