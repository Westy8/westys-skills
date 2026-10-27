// Pure helpers: no `$`, so the tests and the drawing share one definition.
import type { AgentState, Card, Checks, Decision, Detail, Hit, Live, Palette, Pr, PrState, Search, Tab, Tick, View } from '../types'

export const VIEW: View = { task: null, tab: 'result', newRepo: null, composer: 0, showTheme: false, openProposed: [], openDone: [] }

// The approved dark design's status colours (output/sidebar-v2): fg and a dark tint for the pill. The "Default" theme.
export const DEFAULT: Palette = {
  green: '#a1e7b6',
  greenBg: '#1e3326',
  lavender: '#c9b5ff',
  lavenderBg: '#2a2442',
  blue: '#9ec5ff',
  blueBg: '#1c2a40',
  amber: '#ffc28c',
  amberBg: '#3b2a18',
  grey: '#b9bcc7',
  greyBg: '#2a2c33',
  text: '#e9edf4',
  muted: '#b9bcc7',
  faint: '#7d8290',
  accent: '#c5d9fc',
  rule: '#3a3d47',
  // depth: the pane's background (what fades start from), a raised row under the pointer, a soft hairline, a bright tone
  bg: '#262626',
  raised: '#32343d',
  soft: '#44474f',
  bright: '#ffffff',
}

/** The colours drawing uses now: the chosen theme's, copied in at the top of each drawing (ui.tsx). */
export const C: Palette = { ...DEFAULT }

export type Pill = { label: string; fg: string; bg: string }

// Each status's colours by role, so a pill takes the theme of the moment.
type Tone = [label: string, fg: keyof Palette, bg: keyof Palette]
const STATUS: Record<string, Tone> = {
  proposed: ['Proposed', 'grey', 'greyBg'],
  running: ['Running', 'blue', 'blueBg'],
  'blocked-on-user': ['Needs you', 'amber', 'amberBg'],
  blocked: ['Blocked', 'amber', 'greyBg'],
  'in-review': ['Needs review', 'lavender', 'lavenderBg'],
  'pr-open': ['PR open', 'lavender', 'lavenderBg'],
  'merged-not-live': ['Merged, not live', 'lavender', 'lavenderBg'],
  live: ['Live', 'green', 'greenBg'],
  proven: ['Proven', 'green', 'greenBg'],
  done: ['Done', 'green', 'greenBg'],
  dropped: ['Dropped', 'faint', 'greyBg'],
}

/** The one pill a task shows: what the user should notice first. */
/**
 * What needs the user, counted in tasks (a task with three open decisions is one): every open decision's task, and every
 * open task blocked on them with no decision (a chore, e.g. "Reconnect account"). The header, the band and the NEEDS
 * YOU section all read this, so they never disagree.
 */
export function needsYou(t: Tick): { count: number; chores: Card[] } {
  const asked = new Set(t.board.decisions.map(d => d.task_id))
  const chores = t.board.tasks.filter(x => x.needs_you && !x.closed && !asked.has(x.id))
  return { count: asked.size + chores.length, chores }
}

/** How many of the open task's latest messages and events the board shows: a page, more after Show earlier. */
export const PAGE = 40

export const SEARCH: Search = { q: '', box: 0, words: [], meaning: [], state: 'done' }

/** Search results in order: a task the query names (ID or alias), then the model's matches by meaning, then word matches; each task once. */
export function results(s: Search): Hit[] {
  const seen = new Set<string>()
  return [...s.words.filter(h => h.exact), ...s.meaning, ...s.words].filter(h => !seen.has(h.id) && !!seen.add(h.id))
}

/** The task IDs a model's reply names that exist, in its order: it can only point at real tasks. */
export function idsIn(text: string, known: Set<string>): string[] {
  return [...new Set(text.toUpperCase().match(/[A-Z][A-Z0-9]*-\d+/g) ?? [])].filter(id => known.has(id))
}

/** The detail holds the row a landing scrolls to (`m-<id>` a message, `ev-<id>` an event). */
export function holds(d: Detail, key: string): boolean {
  return key.startsWith('m-') ? d.messages.some(m => `m-${m.id}` === key) : d.events.some(e => `ev-${e.id}` === key)
}

/**
 * Where opening a hit lands: a message or event by its id (history is loaded back to it, however much came since),
 * scrolled to; anything else on the Result tab, with the matched text shown there as its evidence.
 */
export function landing(h: Hit): Pick<View, 'tab' | 'more' | 'evidence'> & { key: string | null } {
  const { kind, ref } = h.where
  if (kind === 'message' && typeof ref === 'number') return { tab: 'conversation', more: { task: h.id, n: PAGE, m: ref }, key: `m-${ref}`, evidence: null }
  if (kind === 'event' && typeof ref === 'number') return { tab: 'activity', more: { task: h.id, n: PAGE, e: ref }, key: `ev-${ref}`, evidence: null }
  const path = kind === 'report' && typeof ref === 'string' ? ref : null
  const label = path ? `report ${path.split('/').pop()}` : String(ref ?? 'task')
  return { tab: 'result', more: null, key: null, evidence: { task: h.id, label, text: h.excerpt, path } }
}
export function shownOf(v: View): number {
  return v.more && v.more.task === v.task ? v.more.n : PAGE
}

/** A task view can draw this detail: it has no report, or its own report has been read (never another task's). */
export function ready(d: Detail, rep: { path: string } | null): boolean {
  return !d.report || rep?.path === d.report
}

export function pill(t: Card): Pill {
  const [label, fg, bg] =
    t.needs_you && !t.closed ? STATUS['blocked-on-user']! : t.has_result && !t.closed ? (['Result ready', 'green', 'greenBg'] as Tone) : (STATUS[t.status] ?? [t.status, 'grey', 'greyBg'])
  return { label, fg: C[fg], bg: C[bg] }
}

/** A thin bar `━━━━╸━━━`: `fill` (0..1) of `width` cells at half-cell steps, the tip `╸` a half. */
export function barCells(fill: number, width = 14): { full: number; half: boolean; rest: number } {
  const halves = Math.round(Math.max(0, Math.min(1, fill)) * width * 2)
  const full = Math.floor(halves / 2)
  const half = halves % 2 === 1
  return { full, half, rest: width - full - (half ? 1 : 0) }
}

/** `▰▰▰▰▱▱▱▱` cells: done, the current step, the rest. Long plans scale to `max` cells. */
export function segments(done: number, total: number, max = 12): { done: string; current: string; rest: string } {
  if (total <= 0) return { done: '', current: '', rest: '' }
  const n = Math.min(total, max)
  const d = Math.min(n, Math.round((done / total) * n))
  const cur = d < n ? 1 : 0
  return { done: '▰'.repeat(d), current: '▱'.repeat(cur), rest: '▱'.repeat(n - d - cur) }
}

/** "4/8 steps · Review · Codex round 1" with steps; the stage word alone without; nothing when the lead set neither. */
export function progressLabel(t: Card): string {
  if (t.status === 'done' || t.status === 'dropped') return t.status === 'done' ? 'Done' : 'Dropped'
  const stage = t.stage ? t.stage[0]!.toUpperCase() + t.stage.slice(1) : ''
  if (t.steps_total <= 0) return stage
  return [`${t.steps_done}/${t.steps_total} steps`, stage, t.step_label].filter(Boolean).join(' · ')
}

// How far along a task is when the lead set no steps (The user, M5): one of 5 segments, from its stage or its status,
// whichever is further. The word names the stage, so a stage bar is never read as steps.
const STAGE_LEVEL: Record<string, number> = { planning: 1, development: 2, review: 3, testing: 4, done: 5 }
const STATUS_LEVEL: Record<string, number> = {
  proposed: 0, running: 2, 'in-review': 3, 'pr-open': 3, 'merged-not-live': 4, live: 5, proven: 5, done: 5,
}
const LEVEL_WORD = ['Not started', 'Planning', 'Development', 'Review', 'Testing', 'Live']

/** The 5-segment stage bar's fill (0..5) and its word. */
export function stageOf(t: Card): { level: number; word: string } {
  if (t.status === 'dropped') return { level: 0, word: 'Dropped' }
  const level = Math.max(STAGE_LEVEL[t.stage ?? ''] ?? 0, STATUS_LEVEL[t.status] ?? 0)
  const word = t.status === 'done' ? 'Done' : level === 0 && t.status === 'proposed' ? 'Proposed' : LEVEL_WORD[level]!
  return { level, word }
}

/** A PR chip's colour, as Orca draws it: purple merged, red closed or failing, green open and passing, yellow otherwise. */
export function prColor(p: Pick<Pr, 'state' | 'checks'> | undefined): string | null {
  if (!p?.state) return null // not read from gh (yet)
  if (p.state === 'merged') return PR_LOOK.merged.color
  if (p.state === 'closed' || p.checks === 'failing') return PR_LOOK.closed.color
  return p.checks === 'passing' ? PR_LOOK.open.color : CHECK_LOOK.pending.color
}

// Unicode's East Asian Width "W"/"F" ranges (UAX #11, Unicode 15): what a terminal draws two cells wide.
const WIDE: [number, number][] = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3], [0x25fd, 0x25fe],
  [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be],
  [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa],
  [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755],
  [0x2757, 0x2757], [0x2795, 0x2797], [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55],
  [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x16fe0, 0x18cff], [0x1b000, 0x1b2ff],
  [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a], [0x1f200, 0x1f202], [0x1f210, 0x1f23b],
  [0x1f240, 0x1f248], [0x1f250, 0x1f251], [0x1f260, 0x1f265], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f7e0, 0x1f7eb],
  [0x1f90c, 0x1f9ff], [0x1fa70, 0x1faff], [0x20000, 0x3fffd],
]

/** Terminal cells one character takes: 2 for wide ones (WIDE), 0 for combining marks, joiners and variation selectors, else 1. */
function cell(ch: string): number {
  // ponytail: per code point, so an emoji ZWJ sequence counts each part; a grapheme segmenter if those show up in titles
  const c = ch.codePointAt(0)!
  if (c === 0x200d || (c >= 0x300 && c <= 0x36f) || (c >= 0xfe00 && c <= 0xfe0f)) return 0
  return WIDE.some(([lo, hi]) => c >= lo && c <= hi) ? 2 : 1
}

/** Terminal cells a string takes. */
export function cellsOf(s: string): number {
  let w = 0
  for (const ch of s) w += cell(ch)
  return w
}

/** One line of at most `n` terminal cells: newlines folded, cut with "…". */
export function clip(s: string, n: number): string {
  const line = s.replace(/\s+/g, ' ').trim()
  if (n <= 0) return ''
  if (cellsOf(line) <= n) return line
  let out = ''
  let w = 0
  for (const ch of line) {
    if (w + cell(ch) > n - 1) break
    out += ch
    w += cell(ch)
  }
  return out.trimEnd() + '…'
}

/** `owner/repo#7` for a qualified ref or a GitHub PR URL; `#7` for a bare one. */
function prKey(ref: string): string {
  const url = /github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/.exec(ref)
  if (url) return `${url[1]}#${url[2]}`
  const q = /^([^#\s]+\/[^#\s]+)#(\d+)$/.exec(ref.trim())
  return q ? `${q[1]}#${q[2]}` : `#${ref.split(/[#/]/).pop() ?? ref}`
}

/**
 * A task's PR links, each PR once: refs to one repo's PR (`o/r#7`, its URL) are one; a bare `#7` joins the one
 * qualified PR numbered 7 when there is exactly one, and stays apart when two repos have a #7 (it can't be told).
 */
export function uniquePrs<T extends { ref: string }>(prs: T[]): T[] {
  const keys = prs.map(p => prKey(p.ref))
  const out: T[] = []
  const seen = new Set<string>()
  prs.forEach((p, i) => {
    const key = keys[i]!
    if (key.startsWith('#') && new Set(keys.filter(k => !k.startsWith('#') && k.endsWith(key))).size === 1) return // its qualified twin is listed
    if (!seen.has(key)) (seen.add(key), out.push(p))
  })
  return out
}

/**
 * Where the caret sits after an edit turned `prev` into `next`, the caret having been at `was`: just after the
 * changed stretch. In repeated text (typing "l" after "hel", a paste into "word word …") several places fit the
 * same edit; the one nearest the caret before it is taken, as typing and deleting happen at the caret.
 */
export function caretAfter(prev: string, next: string, was = prev.length): number {
  const min = Math.min(prev.length, next.length)
  let a = 0
  while (a < min && prev[a] === next[a]) a++
  let b = 0
  while (b < min && prev[prev.length - 1 - b] === next[next.length - 1 - b]) b++
  const tail = Math.min(b, min - a) // the suffix left beside the longest prefix
  const removed = prev.length - a - tail
  const inserted = next.length - a - tail
  const lo = Math.max(0, prev.length - removed - b) // the edit can slide left through the repeat, as far as the suffix allows
  const at = (x: number) => Math.max(lo, Math.min(a, x))
  const s = Math.abs(at(was) - was) <= Math.abs(at(was - removed) - (was - removed)) ? at(was) : at(was - removed) // typed at, or deleted up to, the caret
  const c = s + inserted
  const low = next.charCodeAt(c)
  return low >= 0xdc00 && low <= 0xdfff ? c + 1 : c // never between the halves of an emoji
}

/**
 * Typed text laid out for the preview under a one-row field: wrapped at word breaks to `cols` terminal cells, showing
 * at most `rows` lines, scrolled so the caret's line is the last one shown (or the end, once it is). `caret` is its
 * row and its string offset in that line; `hidden` how many lines are scrolled away above.
 */
export function wrapTail(text: string, caretAt: number, cols: number, rows: number): { lines: string[]; hidden: number; caret: { row: number; col: number } } {
  const w = Math.max(2, cols)
  const chars = [...text]
  const offs: number[] = [] // each character's offset in the string
  let o = 0
  for (const ch of chars) offs.push(o), (o += ch.length)
  const starts: number[] = [0] // first character of each line
  let k = 0
  while (k < chars.length) {
    let width = 0
    let j = k
    let space = -1
    while (j < chars.length && width + cell(chars[j]!) <= w) {
      if (chars[j] === ' ') space = j
      width += cell(chars[j]!)
      j++
    }
    if (j >= chars.length) break
    k = space >= k ? space + 1 : Math.max(j, k + 1) // break after a space, or mid-word when a word is longer than the line
    starts.push(k)
  }
  const off = (i: number) => (i < chars.length ? offs[i]! : text.length)
  const all = starts.map((st, i) => text.slice(off(st), off(starts[i + 1] ?? chars.length)))
  const c = Math.max(0, Math.min(text.length, caretAt))
  let row = starts.length - 1
  while (row > 0 && off(starts[row]!) > c) row--
  const first = Math.max(0, row - rows + 1)
  return { lines: all.slice(first, first + rows), hidden: first, caret: { row: row - first, col: c - off(starts[row]!) } }
}

/** A run of a laid-out table line: cell text (bold when the cell was), or border (`rule`). */
export type Seg = { text: string; bold?: boolean; rule?: boolean }
/** A report in reading order: Markdown, and each table laid out as lines that fit. */
export type Part = { md: string } | { lines: Seg[][] }

const DELIM = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/
// a line that starts another block, which ends a table (GFM): a list item, heading, quote, code fence, rule or HTML block
// ponytail: HTML by its common block tags (GFM's full list is ~60); a rarer one reads as a row
const BLOCK =
  /^ {0,3}([-*+]\s|\d{1,9}[.)]\s|#{1,6}(\s|$)|>|`{3,}|~{3,}|([-*_])(\s*\3){2,}\s*$|<(!--|\?|![A-Za-z]|!\[CDATA\[|\/?(script|pre|style|textarea|div|p|table|thead|tbody|tr|td|th|ul|ol|li|dl|details|summary|section|article|aside|header|footer|nav|blockquote|figure|hr|h[1-6])(\s|\/?>|$)))/i

/** The code fence open after `line` (null outside one): ``` or ~~~, closed only by the same mark at least as long. */
function fenceAfter(line: string, open: string | null): string | null {
  const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
  if (!open) return m && !(m[1]![0] === '`' && m[2]!.includes('`')) ? m[1]! : null
  return m && m[1]![0] === open[0] && m[1]!.length >= open.length && !m[2]!.trim() ? null : open
}

/** A table row's cells: split at unescaped pipes; links show their label, code marks go (TAS-12). */
function rowCells(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '')
  return inner.split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/`/g, ''))
}

/** Plain lines of at most `w` cells, broken at spaces (mid-word only past `w`). */
function wrapCells(text: string, w: number): string[] {
  return wrapTail(text.replace(/\s+/g, ' ').trim(), text.length, w, Infinity).lines.map(l => l.trimEnd())
}

let laid = { md: '', cols: 0, parts: [] as Part[] } // the last layout: the pane redraws many times a second, the report rarely changes

/**
 * Markdown tables laid out to `cols` terminal cells (TAS-12): the host draws a table at its natural width and the
 * terminal wraps its borders. Each column keeps at least its longest word, so no word is split; the columns whose
 * narrowing costs the fewest extra lines give way first. When even that can't fit, each row becomes a block of
 * `Header: value` lines. Code fences and everything that isn't a table stay Markdown, as written.
 */
export function layTables(md: string, cols: number): Part[] {
  if (laid.md === md && laid.cols === cols) return laid.parts
  const parts: Part[] = []
  let buf: string[] = []
  const flush = () => {
    const text = buf.join('\n')
    if (text.trim()) parts.push({ md: text })
    buf = []
  }
  const lines = md.split('\n')
  let fence: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const was = fence
    fence = fenceAfter(lines[i]!, fence)
    const head = rowCells(lines[i]!)
    // ponytail: only tables at the left edge; an indented one (inside a list item) stays Markdown with its list
    const table = !was && !fence && !/^\s/.test(lines[i]!) && lines[i]!.includes('|') && !!lines[i + 1]?.includes('|') && DELIM.test(lines[i + 1]!)
    if (!table || rowCells(lines[i + 1]!).length !== head.length) {
      buf.push(lines[i]!)
      continue
    }
    const rows: string[][] = []
    let j = i + 2
    for (; j < lines.length && lines[j]!.trim() && !BLOCK.test(lines[j]!); j++) rows.push(rowCells(lines[j]!))
    flush()
    parts.push({ lines: layTable(head, rows.map(r => head.map((_, c) => r[c] ?? '')), cols) })
    i = j - 1
  }
  flush()
  laid = { md, cols, parts }
  return parts
}

function layTable(head: string[], rows: string[][], cols: number): Seg[][] {
  // ponytail: bold only for a whole-cell **x**; bold inside a cell shows as plain text. Links in cells show their label, not pressable.
  const cell = (c: string) => (/^\*\*[^*]+\*\*$/.test(c) ? { text: c.slice(2, -2), bold: true } : { text: c.replace(/\*\*/g, ''), bold: false })
  const H = head.map(h => ({ text: cell(h).text, bold: true }))
  const R = rows.map(r => r.map(cell))
  const all = [H, ...R]
  const word = (t: string) => Math.max(0, ...t.split(/\s+/).map(cellsOf))
  const w = head.map((_, c) => Math.max(1, ...all.map(r => cellsOf(r[c]!.text))))
  const room = cols - 3 * head.length - 1 // "│ " before each column, " " after, and the last "│"
  const sum = (x: number[]) => x.reduce((a, b) => a + b, 0)
  const min = head.map((_, c) => Math.max(1, ...all.map(r => word(r[c]!.text))))
  if (sum(min) > room) return listOf(H, R, cols)
  // ponytail: one cell at a time, re-wrapping the table each step; fine for report tables, slow past a few hundred rows
  const tall = (x: number[]) => sum(all.map(r => Math.max(...r.map((y, c) => wrapCells(y.text, x[c]!).length))))
  while (sum(w) > room) {
    let best = -1 // the column whose narrowing adds the fewest lines; the widest of those
    let cost = Infinity
    w.forEach((x, c) => {
      if (x <= min[c]!) return
      const h = tall(w.map((y, i) => (i === c ? y - 1 : y)))
      if (h < cost || (h === cost && x > w[best]!)) (best = c), (cost = h)
    })
    w[best]!--
  }
  const rule = (l: string, m: string, r: string): Seg[] => [{ text: l + w.map(x => '─'.repeat(x + 2)).join(m) + r, rule: true }]
  const line = (r: { text: string; bold: boolean }[]): Seg[][] => {
    const wrapped = r.map((x, c) => wrapCells(x.text, w[c]!))
    return Array.from({ length: Math.max(...wrapped.map(x => x.length)) }, (_, j) => [
      ...r.flatMap((x, c): Seg[] => {
        const t = wrapped[c]![j] ?? ''
        return [{ text: c ? ' │ ' : '│ ', rule: true }, { text: t + ' '.repeat(w[c]! - cellsOf(t)), bold: x.bold }]
      }),
      { text: ' │', rule: true },
    ])
  }
  const body = R.map(line)
  const sep = body.some(b => b.length > 1) ? [rule('├', '┼', '┤')] : [] // rows apart when one wraps
  return [rule('┌', '┬', '┐'), ...line(H), rule('├', '┼', '┤'), ...body.flatMap((b, i) => (i ? [...sep, ...b] : b)), rule('└', '┴', '┘')]
}

/** A table too wide for the pane: one block per row, `Header: value` lines, a blank line between rows. */
function listOf(H: { text: string }[], R: { text: string; bold: boolean }[][], cols: number): Seg[][] {
  if (!R.length) return wrapCells(H.map(h => h.text).filter(Boolean).join(' · '), cols).map(l => [{ text: l, bold: true }]) // headers only
  return R.flatMap((r, i) => [
    ...(i ? [[]] : []),
    ...r.flatMap((x, c) => {
      if (!x.text) return []
      const label = H[c]!.text ? `${H[c]!.text}: ` : ''
      return wrapCells(label + x.text, cols - 2).map((l, j): Seg[] =>
        j ? [{ text: '  ' + l, bold: x.bold }] : l.startsWith(label) ? [{ text: label, bold: true }, { text: l.slice(label.length), bold: x.bold }] : [{ text: l, bold: true }],
      )
    }),
  ])
}

/**
 * A report's own short version (TAS-13): its `In short` heading's section, up to the next heading of the same
 * or a higher level; `rest` is the report without it. Null when it has none.
 */
export function inShort(md: string): { short: string; rest: string } | null {
  const lines = md.split('\n')
  let fence: string | null = null
  let at = -1
  let level = 0
  let end = lines.length
  for (let i = 0; i < lines.length; i++) {
    const was = fence
    fence = fenceAfter(lines[i]!, fence)
    const h = was || fence ? null : /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(lines[i]!)
    if (!h) continue
    if (at < 0 && /^in short:?$/i.test(h[2]!)) (at = i), (level = h[1]!.length)
    else if (at >= 0 && h[1]!.length <= level) {
      end = i
      break
    }
  }
  if (at < 0) return null
  return { short: lines.slice(at + 1, end).join('\n').trim(), rest: [...lines.slice(0, at), ...lines.slice(end)].join('\n') }
}

/** Options with the recommended one first, keeping each option's 1-based number in the store. */
export function orderedOptions(d: Decision): { n: number; label: string; desc: string; recommended: boolean }[] {
  const all = d.options.map((label, i) => ({ n: i + 1, label, desc: d.descs[i] ?? '', recommended: d.recommended === i + 1 }))
  return [...all.filter(o => o.recommended), ...all.filter(o => !o.recommended)]
}

export type AskQuestion = { question: string; multiSelect?: boolean; options: { label: string; description?: string }[] }

/** `tasks ask` argv for one AskUserQuestion question: "(Recommended)" moves from the label to --recommend; multi-select stays multi-select. */
export function askArgs(task: string, q: AskQuestion): string[] {
  const argv = ['ask', task, q.question]
  let rec = 0
  q.options.forEach((o, i) => {
    const marked = /\s*\(recommended\)\s*$/i
    if (marked.test(o.label) && !rec) rec = i + 1
    argv.push('--option', o.label.replace(marked, ''), '--desc', o.description ?? '')
  })
  if (q.multiSelect) argv.push('--multi')
  return rec ? [...argv, '--recommend', String(rec)] : argv
}

/** What the model reads instead of the user's answer: the question is posted, the answer comes later. */
export function postedNote(ids: string[]): string {
  return (
    `Posted to the user's Tasks panel as ${ids.join(', ')}. They have not answered yet. ` +
    "Don't wait for it: carry on with other work. Their answer will arrive later as a message like " +
    `"[<task> · mN] Answer to ${ids[0]} (...): ...".`
  )
}

/** The message id of the envelope a prompt starts with (`[IGR-4 · m12] …` → 12), or null. */
export function envelopeId(text: string): number | null {
  const m = /^\s*\[[A-Z][A-Z0-9]*-\d+ · m(\d+)\]/.exec(text)
  return m ? Number(m[1]) : null
}

/**
 * Paths in a report become `file://` links, so the pane can open them (the pane's Markdown draws only http(s) and
 * file links as links). Bare absolute and `~/` paths are linked; a Markdown link to a path (`/abs`, `~/x`, `./a.csv`,
 * `a.csv`, `../x`) points at the file, relative ones from the report's folder. Code spans and web links are left alone.
 */
export function linkPaths(md: string, report = '/', home = ''): string {
  // parentheses encoded too, so a destination like `copy (1).csv` can't end the link early
  const url = (p: string) => `file://${encodeURI(resolvePath(p, report, home)).replace(/\(/g, '%28').replace(/\)/g, '%29')}`
  return md
    .split(/(```[\s\S]*?```|`[^`\n]*`|\[[^\]\n]*\]\(\s*(?:<[^>\n]*>|(?:[^\s()\n]|\([^\s()\n]*\))*)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\))/)
    .map((part, i) => {
      if (i % 2 === 0) return part.replace(/(^|[\s(|])((?:\/|~\/)[\w.@%+\-/]*[\w@%+\-/])/g, (_, pre: string, p: string) => `${pre}[${p}](${url(p)})`)
      // [label](dest "title"), dest maybe <in angle brackets>; only dest changes, the title stays
      const link = /^\[([^\]\n]*)\]\(\s*(?:<([^>\n]*)>|((?:[^\s()\n]|\([^\s()\n]*\))*))(\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)$/.exec(part)
      const dest = link?.[2] ?? link?.[3]
      // a scheme (https:, file:, mailto:) or an anchor keeps its own meaning
      if (!link || !dest || /^([a-z][a-z0-9+.-]*:|#)/i.test(dest)) return part
      return `[${link[1]}](${url(safeDecode(dest))}${link[4] ?? ''})`
    })
    .join('')
}

function safeDecode(s: string): string {
  try {
    return decodeURI(s)
  } catch {
    return s
  }
}

/** A path from a report: `~/` from home, relative from the report's folder; `.` and `..` folded. */
export function resolvePath(p: string, report: string, home: string): string {
  const abs = p.startsWith('/') ? p : p.startsWith('~/') ? `${home}${p.slice(1)}` : `${report.slice(0, report.lastIndexOf('/'))}/${p}`
  const out: string[] = []
  for (const seg of abs.split('/')) {
    if (seg === '..') out.pop()
    else if (seg && seg !== '.') out.push(seg)
  }
  return '/' + out.join('/')
}

/** `file:///a%20b` → `/a b`. */
export function pathOf(href: string): string {
  return decodeURI(href.replace(/^file:\/\//, ''))
}

/** A short title for a new task from the user's text: the first line, cut at 60. */
export function titleOf(text: string): string {
  const line = text.trim().split('\n')[0]!.trim()
  return line.length > 60 ? line.slice(0, 57).trimEnd() + '…' : line
}

export function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.round(now / 1000 - ts))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 172800) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export function clock(ts: number): string {
  const d = new Date(ts * 1000)
  const h = d.getHours()
  return `${((h + 11) % 12) + 1}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
}

export const MESSAGE_STATE: Record<string, string> = {
  queued: 'Waiting to send',
  held: 'Waiting to send',
  sending: 'Sending…',
  accepted: 'Delivered',
  received: 'Lead has it',
  replied: 'Answered',
  'replied?': 'Answered (see the task)',
  failed: 'Not sent',
}

/** Resend is offered only for a refused send, or one cut off mid-send (a healthy send leaves 'sending' at once). */
export function canResend(state: string, sentAt: number, now: number): boolean {
  return state === 'failed' || (state === 'sending' && now / 1000 - sentAt > 30)
}

export const GLYPH = ['◐', '◓', '◑', '◒']

// ---- motion: one-shot transitions, eased; nothing here loops -----------------------------

/** How long each transition runs, in ms. */
export const DUR = { open: 260, close: 160, tab: 200, reveal: 300, fresh: 400, pill: 360, bar: 420, settle: 360, hold: 900 }

/** Ease-out cubic: fast start, soft landing. */
export function ease(p: number): number {
  const x = Math.max(0, Math.min(1, p))
  return 1 - (1 - x) ** 3
}

/** `#rrggbb` between `a` (p=0) and `b` (p=1). */
export function mix(a: string, b: string, p: number): string {
  if (p >= 1) return b
  if (p <= 0) return a
  const ch = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16)
  const out = [0, 1, 2].map(i => Math.round(ch(a, i) + (ch(b, i) - ch(a, i)) * p).toString(16).padStart(2, '0'))
  return `#${out.join('')}`
}

export type Tween = { start: number; dur: number; from?: unknown }

/** Eased progress of `tw` at `now` over its first `over` ms (default: all of it); 1 when there is none. */
export function progress(tw: Tween | undefined, now: number, over?: number): number {
  return tw ? ease((now - tw.start) / (over ?? tw.dur)) : 1
}

// ---- agents and PRs: parsed from the store's links, live state read from Orca and gh -------------------

/** An agent linked to a task: `tasks link ID agent <terminal> --label "codex · gpt-6-astra · xhigh · reviewer"`. */
export type Agent = { ref: string; kind: string; model: string; effort: string; role: string }

const KINDS = ['claude', 'codex', 'opencode']

/** Reads the label (`kind · model · effort · role`); an older free-form label still yields its kind, the rest as the role. */
export function parseAgent(ref: string, label: string): Agent {
  const parts = label.split('·').map(x => x.trim()).filter(Boolean)
  if (parts.length >= 2 && KINDS.includes(parts[0]!.toLowerCase())) {
    return { ref, kind: parts[0]!.toLowerCase(), model: parts[1] ?? '', effort: parts[2] ?? '', role: parts.slice(3).join(' · ') }
  }
  const kind = KINDS.find(k => label.toLowerCase().includes(k)) ?? 'agent'
  return { ref, kind, model: '', effort: '', role: label.trim() }
}

export type OrcaTerminal = { handle: string; title?: string; agentIdentity?: string; lastOutputAt?: number | null }
export type OrcaWorker = { agentTerminalHandle?: string; projection?: { outcome?: string; stage?: { activity?: string } } }

/**
 * Each agent terminal's state. A supervised worker's own record wins (a finished one can still own a live
 * terminal); otherwise Claude's title starts with ✳ when idle, and anything else counts as working after
 * output in the last 8 s. A handle in neither list is finished.
 */
export function liveAgents(terms: OrcaTerminal[], workers: OrcaWorker[], now: number): Live['agents'] {
  const out: Live['agents'] = {}
  for (const t of terms) {
    if (!t.agentIdentity) continue
    const working = t.agentIdentity === 'claude' ? !!t.title && !/^[✳\w]/u.test(t.title) : now - (t.lastOutputAt ?? 0) < 8000
    out[t.handle] = { kind: t.agentIdentity, state: working ? 'working' : 'idle' }
  }
  for (const w of workers) {
    const h = w.agentTerminalHandle
    if (!h) continue
    const kind = out[h]?.kind ?? 'agent'
    const outcome = w.projection?.outcome
    if (outcome && outcome !== 'in_progress') out[h] = { kind, state: 'done' }
    else if (out[h] && w.projection?.stage?.activity) out[h] = { kind, state: w.projection.stage.activity === 'working' ? 'working' : 'idle' }
  }
  return out
}

/** The state an agent shows: its live state, finished when Orca answered and doesn't list it, unknown before. */
export function stateOf(handle: string, live: Live | null): AgentState {
  if (!live) return 'unknown'
  return live.agents[handle]?.state ?? 'done'
}

/** Brand marks as glyphs (Orca's terminal draws no images): Claude's ✳ in its orange, Codex's prompt mark. */
export const BADGE: Record<string, { mark: string; color: string; name: string }> = {
  claude: { mark: '✳', color: '#d97757', name: 'Claude' },
  codex: { mark: '>_', color: '#e8e8ea', name: 'Codex' },
  opencode: { mark: '◫', color: '#b9bcc7', name: 'OpenCode' },
  agent: { mark: '●', color: '#b9bcc7', name: 'Agent' },
}


/** `owner/repo#12` or a PR URL → the `gh pr view` argv; a bare `#12` has no repo, so no live state. */
export function prArgs(ref: string): string[] | null {
  const fields = ['--json', 'number,url,state,isDraft,statusCheckRollup,reviewDecision']
  if (/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(ref)) return ['pr', 'view', ref, ...fields]
  const m = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(ref.trim())
  return m ? ['pr', 'view', m[2]!, '--repo', m[1]!, ...fields] : null
}

type Rollup = { status?: string; conclusion?: string; state?: string }[]

/** gh's JSON → the chip: state, checks (CheckRuns and status contexts both count) and the review decision. */
export function prOf(ref: string, at: number, j: { number?: number; url?: string; state?: string; isDraft?: boolean; statusCheckRollup?: Rollup; reviewDecision?: string }): Pr {
  const state: PrState = j.state === 'MERGED' ? 'merged' : j.state === 'CLOSED' ? 'closed' : j.isDraft ? 'draft' : 'open'
  const items = j.statusCheckRollup ?? []
  const bad = ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']
  const failing = items.some(x => bad.includes(x.conclusion ?? '') || bad.includes(x.state ?? ''))
  const pending = items.some(x => (x.status && x.status !== 'COMPLETED') || x.state === 'PENDING' || x.state === 'EXPECTED')
  const checks: Checks = !items.length ? 'none' : failing ? 'failing' : pending ? 'pending' : 'passing'
  const review = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes requested', REVIEW_REQUIRED: 'review needed' }[j.reviewDecision ?? ''] ?? ''
  return { ref, at, number: j.number, url: j.url, state, checks, review }
}

/** Orca's PR look in its dark theme: GitPullRequest/GitMerge/CircleX/CircleDot and its check marks, as glyphs. */
export const PR_LOOK: Record<PrState, { mark: string; color: string }> = {
  open: { mark: '⑂', color: '#6ee7b7' },
  draft: { mark: '◉', color: '#9ca3af' },
  merged: { mark: '⑃', color: '#d8b4fe' },
  closed: { mark: '⊗', color: '#fda4af' },
}
export const CHECK_LOOK: Record<Exclude<Checks, 'none'>, { mark: string; color: string }> = {
  passing: { mark: '✓', color: '#6ee7b7' },
  failing: { mark: '✕', color: '#fda4af' },
  pending: { mark: '◷', color: '#fcd34d' },
}
