#!/usr/bin/env node
// The command that npm puts on PATH. It checks the Node version first, so an old Node gets a
// clear message instead of a syntax error, then runs the TypeScript entry. Node strips types
// by itself, but refuses to for files under node_modules (where npm installs the tool): there,
// this launcher strips the types of the tool's own files with Node's own stripTypeScriptTypes.
// No build step and no dependency.

// Type stripping on by default came in 22.18 and 23.6; registerHooks in 22.15 and 23.5. So 23.0
// to 23.5 fall short even though they are newer than 22.18.
const [major, minor] = process.versions.node.split('.').map(Number)
if (major < 22 || (major === 22 && minor < 18) || (major === 23 && minor < 6)) {
  process.stderr.write(`clankerinbox needs Node.js 22.18 or newer (23.6 or newer on 23); this is Node.js ${process.versions.node}. Install a newer Node.js from https://nodejs.org\n`)
  process.exit(1)
}

const { registerHooks, stripTypeScriptTypes } = await import('node:module')
const { readFileSync } = await import('node:fs')
const { fileURLToPath } = await import('node:url')

const root = new URL('../', import.meta.url).href
if (root.includes('/node_modules/')) {
  // The one warning this causes is about the API, not about anything the user can change.
  const emit = process.emitWarning
  process.emitWarning = function (warning, ...rest) {
    if (/stripTypeScriptTypes/.test(String(typeof warning === 'string' ? warning : warning?.message))) return
    return emit.call(this, warning, ...rest)
  }
  registerHooks({
    load(url, context, nextLoad) {
      if (url.startsWith(root) && url.endsWith('.ts') && !url.slice(root.length).includes('node_modules/')) {
        const source = stripTypeScriptTypes(readFileSync(fileURLToPath(url), 'utf8'), { mode: 'strip' })
        return { format: 'module', source, shortCircuit: true }
      }
      return nextLoad(url, context)
    },
  })
}

await import('./clankerinbox.ts')
