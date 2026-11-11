// Machines set up when the tool was called agentmail keep working after the rename.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const ROOT = join(import.meta.dirname, '..')

function paths(home: string, env: Record<string, string> = {}): { config: string; state: string } {
  const code = `import { configPath, stateDir } from ${JSON.stringify(join(ROOT, 'src', 'config.ts'))};
console.log(JSON.stringify({ config: configPath(), state: stateDir() }))`
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLANKERINBOX|AGENTMAIL)_/.test(k)))
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...clean, HOME: home, ...env }, encoding: 'utf8' })
  return JSON.parse(out)
}

test('a fresh machine uses the clankerinbox paths', () => {
  const home = mkdtempSync(join(tmpdir(), 'ci-home-'))
  assert.deepEqual(paths(home), {
    config: join(home, '.config', 'clankerinbox', 'config.json'),
    state: join(home, '.local', 'state', 'clankerinbox'),
  })
})

test('a machine set up as agentmail keeps its old config and state', () => {
  const home = mkdtempSync(join(tmpdir(), 'ci-home-'))
  mkdirSync(join(home, '.config', 'agentmail'), { recursive: true })
  writeFileSync(join(home, '.config', 'agentmail', 'config.json'), '{}')
  mkdirSync(join(home, '.local', 'state', 'agentmail'), { recursive: true })
  assert.deepEqual(paths(home), {
    config: join(home, '.config', 'agentmail', 'config.json'),
    state: join(home, '.local', 'state', 'agentmail'),
  })
})

test('the new paths win once they exist', () => {
  const home = mkdtempSync(join(tmpdir(), 'ci-home-'))
  for (const name of ['agentmail', 'clankerinbox']) {
    mkdirSync(join(home, '.config', name), { recursive: true })
    writeFileSync(join(home, '.config', name, 'config.json'), '{}')
    mkdirSync(join(home, '.local', 'state', name), { recursive: true })
  }
  assert.equal(paths(home).config, join(home, '.config', 'clankerinbox', 'config.json'))
  assert.equal(paths(home).state, join(home, '.local', 'state', 'clankerinbox'))
})

test('the old env vars still override', () => {
  const home = mkdtempSync(join(tmpdir(), 'ci-home-'))
  assert.deepEqual(paths(home, { AGENTMAIL_CONFIG: '/x/config.json', AGENTMAIL_STATE: '/x/state' }), { config: '/x/config.json', state: '/x/state' })
  assert.equal(paths(home, { AGENTMAIL_CONFIG: '/old', CLANKERINBOX_CONFIG: '/new' }).config, '/new')
})

test('the old class name is still exported', async () => {
  const mod = await import(join(ROOT, 'index.ts'))
  assert.equal(mod.AgentMail, mod.ClankerInbox)
})
