#!/usr/bin/env node
// Deploys clankerinbox.com on the `apps` server when `main` moves.
// Production never runs from a checkout: each deploy unpacks one commit into
// <root>/releases/<sha> and points the <root>/current symlink at it. Caddy
// serves <root>/current/site, which is the `site/` folder of the repo.
//
//   node deploy.mjs                    deploy origin/main
//   node deploy.mjs --ref=<sha>        deploy or roll back to one commit
//   node deploy.mjs --auto             deploy main only if it moved (the timer runs this)
//
// Runs as the `clankerinbox` user (no sudo). Setup: deploy/apps-server/README.md.

import {
  existsSync, mkdirSync, writeFileSync, readdirSync, readlinkSync,
  renameSync, rmSync, statSync, symlinkSync, utimesSync,
} from 'node:fs'
import { join, basename } from 'node:path'
import { execFileSync } from 'node:child_process'

const REPO_URL = 'https://github.com/ClankerInbox/clankerinbox.git'
const KEEP_RELEASES = 5

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/)
    return m ? [m[1], m[2] ?? true] : [a, true]
  }),
)
const ROOT = args.root || '/srv/clankerinbox'
const RELEASES = join(ROOT, 'releases')
const CURRENT = join(ROOT, 'current')
const MIRROR = join(ROOT, 'repo.git')
// Commits that failed under --auto, so the timer doesn't retry them every
// minute. A manual deploy still tries them and clears the mark on success.
const HELD = join(ROOT, 'held')

function log (msg) { console.log(`› ${msg}`) }
function fail (msg) { console.error(`\n✖ ${msg}\n`); process.exit(1) }

function run (cmd, cmdArgs, opts = {}) {
  return execFileSync(cmd, cmdArgs, { stdio: 'inherit', ...opts })
}
function out (cmd, cmdArgs) {
  return execFileSync(cmd, cmdArgs, { stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim()
}

function currentRelease () {
  try { return basename(readlinkSync(CURRENT)) } catch { return null }
}

// rename() over an existing symlink is atomic, so Caddy never sees a missing `current`.
function pointCurrentAt (sha) {
  const next = `${CURRENT}.next`
  rmSync(next, { force: true })
  symlinkSync(join(RELEASES, sha), next)
  renameSync(next, CURRENT)
}

function fetchSha (ref) {
  if (!existsSync(MIRROR)) {
    log(`Cloning ${REPO_URL}`)
    run('git', ['clone', '--quiet', '--mirror', REPO_URL, MIRROR])
  } else {
    run('git', ['--git-dir', MIRROR, 'remote', 'update', '--prune'], { stdio: ['ignore', 'ignore', 'inherit'] })
  }
  return out('git', ['--git-dir', MIRROR, 'rev-parse', `${ref}^{commit}`])
}

function build (sha) {
  const dir = join(RELEASES, sha)
  if (existsSync(join(dir, 'REVISION'))) {
    log(`Release ${sha.slice(0, 7)} is already built, reusing it`)
    return
  }
  const tmp = `${dir}.partial`
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  log(`Building ${sha.slice(0, 7)}`)
  execFileSync('sh', ['-c', `git --git-dir "${MIRROR}" archive "${sha}" site deploy | tar -x -C "${tmp}"`], { stdio: 'inherit' })

  const site = join(tmp, 'site')
  writeFileSync(join(site, 'health.json'), `${JSON.stringify({ ok: true, sha })}\n`)
  if (!existsSync(join(site, 'index.html'))) fail('The commit has no site/index.html')

  writeFileSync(join(tmp, 'REVISION'), `${sha}\n`)
  renameSync(tmp, dir)
}

function prune (keep) {
  const releases = readdirSync(RELEASES)
    .filter((name) => !name.endsWith('.partial'))
    .map((name) => ({ name, mtime: statSync(join(RELEASES, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  for (const { name } of releases.slice(KEEP_RELEASES)) {
    if (keep.includes(name)) continue
    log(`Removing old release ${name.slice(0, 7)}`)
    rmSync(join(RELEASES, name), { recursive: true, force: true })
  }
}

function deploy () {
  mkdirSync(RELEASES, { recursive: true })
  const sha = fetchSha(args.ref || 'main')
  const previous = currentRelease()
  if (args.auto) {
    if (sha === previous || existsSync(join(HELD, sha))) return
    // Held until it's live, so a failed build stays held.
    mkdirSync(HELD, { recursive: true })
    writeFileSync(join(HELD, sha), `${new Date().toISOString()}\n`)
  }
  build(sha)
  // Marks this release as the newest, so pruning keeps it even when reused.
  const now = new Date()
  utimesSync(join(RELEASES, sha), now, now)

  log(`Switching current → ${sha.slice(0, 7)}${previous ? ` (was ${previous.slice(0, 7)})` : ''}`)
  pointCurrentAt(sha)
  rmSync(join(HELD, sha), { force: true })
  prune([sha, previous].filter(Boolean))
  log(`Deployed ${sha.slice(0, 7)}`)
}

deploy()
