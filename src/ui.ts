// Terminal output for people: colors, ✓/✗ lines, hints and a spinner. Everything here is
// for a person at a terminal; piped output (JSON) never goes through it.

export interface Ui {
  color: boolean
  paint(code: string, s: string): string
  bold(s: string): string
  dim(s: string): string
  ok(s: string): string
  fail(s: string): string
  warn(s: string): string
}

export function makeUi(stream: { isTTY?: boolean }, env: Record<string, string | undefined> = process.env): Ui {
  const color = !!stream.isTTY && !env.NO_COLOR && env.TERM !== 'dumb'
  const paint = (code: string, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s)
  return {
    color,
    paint,
    bold: (s) => paint('1', s),
    dim: (s) => paint('2', s),
    ok: (s) => `${paint('32', '✓')} ${s}`,
    fail: (s) => `${paint('31', '✗')} ${s}`,
    warn: (s) => `${paint('33', '!')} ${s}`,
  }
}

export interface Spinner {
  stop(final?: string): void
}

// Cursor codes only where a terminal understands them: not when piped, not with TERM=dumb.
export function canRedraw(stream: { isTTY?: boolean }, env: Record<string, string | undefined> = process.env): boolean {
  return !!stream.isTTY && env.TERM !== 'dumb'
}

// A spinner with a timer while a command waits. Ctrl+C clears the line before exiting, after
// `onInterrupt` (when given) prints what to run next. The line is cut to the terminal width, so
// it never wraps into a new line on each frame. With TERM=dumb it is one plain line.
export function spinner(
  text: string, stream: NodeJS.WriteStream = process.stderr, ui = makeUi(stream),
  opts: { env?: Record<string, string | undefined>; onInterrupt?: () => string | void } = {},
): Spinner {
  if (!stream.isTTY) return { stop: () => {} }
  const env = opts.env || process.env
  const fancy = canRedraw(stream, env)
  const onInt = () => {
    clearInterval(timer)
    const note = opts.onInterrupt?.()
    stream.write((fancy ? '\r\x1b[2K' : '\n') + (note ? note + '\n' : ''))
    process.exit(130)
  }
  process.on('SIGINT', onInt)
  let timer: NodeJS.Timeout | undefined
  if (!fancy) {
    stream.write(`${text} (Ctrl+C stops)\n`)
    return {
      stop(final?: string) {
        process.off('SIGINT', onInt)
        if (final) stream.write(final + '\n')
      },
    }
  }
  const frames = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
  const started = Date.now()
  let i = 0
  const draw = () => {
    const s = Math.floor((Date.now() - started) / 1000)
    const clock = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
    const room = Math.max(10, (stream.columns || 80) - 1)
    let tail = `${clock} · Ctrl+C stops`
    if (2 + text.length + 1 + tail.length > room) tail = clock
    const space = room - 2 - 1 - tail.length
    const shown = text.length > space ? text.slice(0, Math.max(0, space - 1)) + '…' : text
    stream.write(`\r\x1b[2K${ui.paint('36', frames[i++ % frames.length])} ${shown} ${ui.dim(tail)}`)
  }
  draw()
  timer = setInterval(draw, 80)
  return {
    stop(final?: string) {
      clearInterval(timer)
      process.off('SIGINT', onInt)
      stream.write('\r\x1b[2K' + (final ? final + '\n' : ''))
    },
  }
}

// Edit distance, for "did you mean" on a mistyped command.
export function closest(word: string, options: string[]): string | null {
  let best: string | null = null
  let bestD = Infinity
  for (const o of options) {
    const d = distance(word, o)
    if (d < bestD) { best = o; bestD = d }
  }
  return bestD <= (word.length <= 3 ? 1 : 2) ? best : null
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return row[b.length]
}

// "3 mails" / "1 mail".
export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

export function shortTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
