import { createServer } from 'node:http'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// The Cloudflare API, as the wrangler login token sees it: the zones, the call that starts
// Email Routing on a subdomain, Email Sending (refused on the free plan), the destination
// addresses (verified at the third read, as if the user clicked the link), the Workers and
// their custom domains, DNS records, and the routing rules. With `dir` (the fake wrangler's
// folder), Workers and rules are the ones the fake wrangler made.
export interface CfCall { method: string; url: string; body: any }

export interface FakeApiOptions {
  free?: boolean
  noZoneSettings?: boolean
  dir?: string
  // Zones of acc1 (default: example.com and example.net, both active).
  zones?: { id: string; name: string; status?: string }[]
  // The answer to the Email Sending API, when it is neither ok nor the free plan.
  sendingError?: { status: number; code: number; message: string }
  // Names that have a DNS record already.
  dns?: string[]
  // Addresses never verified (the link is not clicked).
  neverVerified?: string[]
}

export async function fakeCloudflareApi(calls: CfCall[], o: FakeApiOptions = {}) {
  const addresses = new Map<string, number>()
  let subaddress = false
  const memory: Record<string, any> = {}
  const load = (f: string) => (o.dir ? (existsSync(join(o.dir, f)) ? JSON.parse(readFileSync(join(o.dir, f), 'utf8')) : []) : memory[f] || [])
  const save = (f: string, v: unknown) => (o.dir ? writeFileSync(join(o.dir, f), JSON.stringify(v)) : (memory[f] = v))
  const zones = o.zones || [{ id: 'z2', name: 'example.net', status: 'active' }, { id: 'z1', name: 'example.com', status: 'active' }]
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      calls.push({ method: req.method!, url: req.url!, body: raw ? JSON.parse(raw) : null })
      const authed = req.headers.authorization === 'Bearer fake-oauth-token'
      const url = new URL(req.url!, 'http://x')
      const reply = (status: number, data: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(data))
      }
      const ok = (result: unknown) => reply(200, { success: true, result, result_info: { total_pages: 1 } })
      if (!authed) return reply(403, { success: false, errors: [{ message: 'forbidden' }] })
      if (req.method === 'GET' && url.pathname === '/zones') {
        return ok(url.searchParams.get('account.id') === 'acc1' ? zones.map((z) => ({ status: 'active', ...z })) : [])
      }
      if (req.method === 'POST' && /^\/zones\/z\d\/email\/routing\/dns$/.test(url.pathname)) {
        const name = JSON.parse(raw).name
        save('subdomains.json', [...load('subdomains.json').filter((d: any) => d.name !== name), { name, enabled: true, status: 'ready' }])
        return ok({})
      }
      if (/^\/zones\/z\d\/email\/routing$/.test(url.pathname)) {
        if (req.method === 'PATCH') {
          if (o.noZoneSettings) return reply(403, { success: false, errors: [{ code: 10000, message: 'Authentication error' }] })
          subaddress = JSON.parse(raw).support_subaddress
        }
        return ok({ enabled: false, support_subaddress: subaddress, subdomains: load('subdomains.json') })
      }
      if (req.method === 'GET' && /^\/zones\/z\d\/email\/routing\/rules$/.test(url.pathname)) return ok(load('rules.json'))
      const rule = /^\/zones\/z\d\/email\/routing\/rules\/([^/]+)$/.exec(url.pathname)
      if (req.method === 'PUT' && rule) {
        const rules = load('rules.json').map((r: any) => (r.id === rule[1] ? { ...JSON.parse(raw), id: r.id } : r))
        save('rules.json', rules)
        return ok({})
      }
      if (req.method === 'GET' && /^\/zones\/z\d\/email\/sending\/subdomains$/.test(url.pathname)) {
        if (o.sendingError) return reply(o.sendingError.status, { success: false, errors: [{ code: o.sendingError.code, message: o.sendingError.message }] })
        return o.free ? reply(401, { success: false, errors: [{ code: 2036, message: 'Unauthorized' }] }) : ok([])
      }
      if (req.method === 'GET' && /^\/zones\/z\d\/dns_records$/.test(url.pathname)) {
        const name = url.searchParams.get('name')
        return ok((o.dns || []).filter((n) => n === name).map((n) => ({ name: n, type: 'A', content: '192.0.2.1' })))
      }
      if (req.method === 'GET' && url.pathname === '/accounts/acc1/workers/scripts') return ok(load('workers.json').map((id: string) => ({ id })))
      if (req.method === 'GET' && url.pathname === '/accounts/acc1/workers/domains') {
        const host = url.searchParams.get('hostname')
        return ok(load('domains.json').filter((d: any) => !host || d.hostname === host))
      }
      if (url.pathname === '/accounts/acc1/email/routing/addresses') {
        if (req.method === 'POST') {
          addresses.set(JSON.parse(raw).email, 0)
          return ok({})
        }
        const result = [...addresses].map(([email, reads]) => {
          addresses.set(email, reads + 1)
          return { email, verified: reads >= 2 && !o.neverVerified?.includes(email) ? '2026-11-10T12:00:00Z' : null }
        })
        return ok(result)
      }
      reply(404, { success: false, errors: [{ message: 'not found' }] })
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { server, url: `http://127.0.0.1:${(server.address() as any).port}` }
}
