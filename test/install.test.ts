// The tool installed by npm lives under node_modules, where Node does not strip types by itself:
// the launcher on PATH must run it there. The package ships only what the tool needs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, statSync, symlinkSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'

const ROOT = join(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

test('the launcher runs the tool from node_modules, as npm installs it, and through a link on PATH', () => {
  const prefix = mkdtempSync(join(tmpdir(), 'clankerinbox-install-'))
  const dest = join(prefix, 'lib', 'node_modules', 'clankerinbox')
  for (const f of [...pkg.files, 'package.json']) cpSync(join(ROOT, f), join(dest, f), { recursive: true })
  mkdirSync(join(prefix, 'bin'))
  symlinkSync(join(dest, pkg.bin.clankerinbox), join(prefix, 'bin', 'clankerinbox'))
  const env = { PATH: `${join(prefix, 'bin')}:${process.env.PATH}`, HOME: prefix }
  assert.equal(execFileSync('clankerinbox', ['--version'], { env, encoding: 'utf8' }).trim(), pkg.version)
  // A command that loads every module, with no warning on stderr.
  const r = spawnSync('clankerinbox', ['inboxes'], { env, encoding: 'utf8' })
  assert.equal(r.status, 1)
  assert.equal(r.stderr, 'clankerinbox: Not set up yet.\nRun: clankerinbox setup\n')
  // Node itself refuses the TypeScript entry there; that is why the launcher exists.
  const direct = spawnSync(process.execPath, [join(dest, 'bin', 'clankerinbox.ts'), '--version'], { env, encoding: 'utf8' })
  assert.notEqual(direct.status, 0)
})

test('hints name a command that works: npx when started by npx, the full path when not on PATH', () => {
  const prefix = mkdtempSync(join(tmpdir(), 'clankerinbox-npx-'))
  // The layout npx makes in its cache: <cache>/_npx/<hash>/node_modules/{clankerinbox,.bin}.
  const modules = join(prefix, '_npx', 'a1b2c3', 'node_modules')
  const dest = join(modules, pkg.name)
  for (const f of [...pkg.files, 'package.json']) cpSync(join(ROOT, f), join(dest, f), { recursive: true })
  mkdirSync(join(modules, '.bin'))
  const link = join(modules, '.bin', pkg.name)
  symlinkSync(join(dest, pkg.bin.clankerinbox), link)
  // Neither is on PATH, as for a user who ran npx.
  const env = { PATH: process.env.PATH!, HOME: prefix }
  const npx = spawnSync(link, ['inboxes'], { env, encoding: 'utf8' })
  assert.equal(npx.stderr, `clankerinbox: Not set up yet.\nRun: npx ${pkg.name} setup\n`)

  // The same command somewhere else, not on PATH: its absolute path.
  mkdirSync(join(prefix, 'tools'))
  const other = join(prefix, 'tools', 'clankerinbox')
  symlinkSync(join(dest, pkg.bin.clankerinbox), other)
  const direct = spawnSync(other, ['inboxes'], { env: { ...env, PATH: dirname(process.execPath) }, encoding: 'utf8' })
  assert.equal(direct.stderr, `clankerinbox: Not set up yet.\nRun: ${other} setup\n`)
})

test('the package lists only the files the tool needs, and the entries can run', () => {
  assert.deepEqual(pkg.files, ['bin/', 'src/', 'cloudflare/', 'index.ts', 'README.md'])
  for (const f of ['bin/clankerinbox.js', 'bin/clankerinbox.ts']) {
    assert.ok(statSync(join(ROOT, f)).mode & 0o100, `${f} is executable`)
    assert.match(readFileSync(join(ROOT, f), 'utf8'), /^#!\/usr\/bin\/env node\n/)
  }
})
