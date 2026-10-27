// The Tasks pane and the strip above the prompt. Drawing only reads $.state and the motion tweens; every write
// is a press handler. Colours pass through `k()`, which fades them toward the background while the pane or a
// view is coming in; everything else that moves reads its own tween (motion.ts) and rests when it ends.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Elements, RenderElement, RenderInput } from 'claude-code'

import type { Card, Decision, Detail, Hit, Repo, Search, Tab, Tick, View } from '../types'
import { act, backTo, find, launchLead, newTask, openFile, openHit, openPane, PANE, setView, showEarlier, startLead } from './board'
import {
  ago,
  BADGE,
  barCells,
  C,
  caretAfter,
  cellsOf,
  CHECK_LOOK,
  canResend,
  clip,
  clock,
  DUR,
  GLYPH,
  inShort,
  layTables,
  MESSAGE_STATE,
  mix,
  needsYou,
  orderedOptions,
  parseAgent,
  pathOf,
  pill,
  ready,
  prColor,
  progressLabel,
  results,
  stageOf,
  SEARCH,
  stateOf,
  uniquePrs,
  VIEW,
  wrapTail,
} from './logic'
import type { Agent, Pill } from './logic'
import type { AgentState, Live, Pr, Theme } from '../types'
import { at, fromOf, ghosts, moving, settle, unsettle } from './motion'
import type { Ghost } from './motion'
import { FIRST, pickTheme, THEMES } from './theme'

type $ = EngineInterface

// State refs are declared in each file that reads them (the validator follows only literal refs); the contract is types/index.d.ts.
const tick = atom({ plugin: 'crew-board', key: 'tick' } as const, null)
const view = atom({ plugin: 'crew-board', key: 'view' } as const, VIEW)
const report = atom({ plugin: 'crew-board', key: 'report' } as const, null)
const working = atom({ plugin: 'crew-board', key: 'working' } as const, false)
const frame = atom({ plugin: 'crew-board', key: 'frame' } as const, 0)
const anim = atom({ plugin: 'crew-board', key: 'anim' } as const, 0)
const live = atom({ plugin: 'crew-board', key: 'live' } as const, null)
const prs = atom({ plugin: 'crew-board', key: 'prs' } as const, {} as Record<string, Pr>)
const notice = atom({ plugin: 'crew-board', key: 'notice' } as const, '')
const error = atom({ plugin: 'crew-board', key: 'error' } as const, '')
const chosen = atom({ plugin: 'crew-board', key: 'chosen' } as const, {} as Record<string, number[]>)
const theme = atom({ plugin: 'crew-board', key: 'theme' } as const, FIRST)
const search = atom({ plugin: 'crew-board', key: 'search' } as const, SEARCH)
const typed = atom({ plugin: 'crew-board', key: 'typed' } as const, {} as Record<string, { text: string; caret: number }>)
const confirming = atom({ plugin: 'crew-board', key: 'confirming' } as const, null)
let ticked: Record<string, number[]> = {} // this draw's `chosen`, read once in pane() for the decision boxes
let typedNow: Record<string, { text: string; caret: number }> = {} // this draw's `typed`, read once in pane()
let confirmNow: { repo: string; resume: boolean; anyway?: boolean } | null = null // this draw's armed lead start, read once in pane()
const drafts: Record<string, string> = {} // text typed into a multi-select decision's field, sent with Submit
type El = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button' | 'Input' | 'Markdown'>

const TABS: { tab: Tab; label: string; hotkey: string }[] = [
  { tab: 'result', label: 'Result', hotkey: 'r' },
  { tab: 'conversation', label: 'Conversation', hotkey: 'c' },
  { tab: 'activity', label: 'Activity', hotkey: 'a' },
  { tab: 'files', label: 'Files', hotkey: 'f' },
]

// The live reads for this build (set with the ink at the top of each drawing).
let liveNow: Live | null = null
let prsNow: Record<string, Pr> = {}
let viewNow: View | null = null // this draw's view (the list's field key)
let wasFocused = false // the pane had the keyboard last draw: Esc hands it back, and that closes an open field or list
let widthNow = 80 // the pane's reading width for this build (what the typed-text preview wraps to)
let idW = 6 // the Overview's ID column for this build: the longest task ID

// The theme for this build: its palette is copied into C, `neon` is redditflow's look (set with the ink).
let themeNow: Theme = FIRST
/** Puts the chosen theme's colours in place for a drawing. */
function useTheme(th: Theme | null): void {
  themeNow = th ?? FIRST
  Object.assign(C, themeNow.palette)
}
/** A label in the theme's case: redditflow's are uppercase. */
const caps = (s: string) => (themeNow.neon ? s.toUpperCase() : s)

let drawn = '' // the task the pane last drew, '' for the overview

// How far the drawing has faded in (1 = full colour). Set at the top of each synchronous build, read by k().
let ink = 1
const k = (c: string) => (ink >= 1 ? c : mix(C.bg, c, ink))
/** Builds `fn` with the ink scaled by `f` (a section fading in on its own). */
function faded<T>(f: number, fn: () => T): T {
  const saved = ink
  ink = saved * f
  try {
    return fn()
  } finally {
    ink = saved
  }
}

/** A button that brightens under the pointer (a scope of its own: no keyed Box needed). */
const lit = (scope: string) => ({ color: C.bright, scope })

function elements($: $, e: RenderInput<'Pane'> | RenderInput<'AbovePrompt'>): El | null {
  return e.surface === 'terminal' || e.surface === 'desktop' ? $.ui.resolve(e) : null
}

export async function pane($: $, e: RenderInput<'Pane'>): Promise<RenderElement | null> {
  const el = elements($, e)
  if (!el) return null
  const [t, v, rep, w, f, note, err, , lv, pr, th, s] = await Promise.all([
    read($, tick),
    read($, view).then(x => ({ ...VIEW, ...x })), // fields added by a newer mod get their defaults
    read($, report),
    read($, working),
    read($, frame),
    read($, notice),
    read($, error),
    read($, anim), // a tween's frame: redraw
    read($, live),
    read($, prs),
    read($, theme),
    read($, search),
  ])
  ticked = await read($, chosen)
  typedNow = await read($, typed)
  confirmNow = await read($, confirming)
  useTheme(th)
  liveNow = lv
  prsNow = pr
  const { Box, Text } = el
  const width = Math.min(e.props.bodyColumns, 120) // ponytail: fixed reading width; wider screens just get margin
  widthNow = width
  viewNow = v
  // Esc in a field gives the keyboard back to the prompt (the field never hears it): that closes the list or the field
  if (wasFocused && !e.props.isFocused && (v.picking || v.adding)) void update($, view, x => ({ ...x, picking: null, adding: null }))
  wasFocused = e.props.isFocused
  const now = Date.now()
  if (!t) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color={C.text}>Tasks</Text>
        <Text color={err ? C.amber : C.faint}>{err ? `The task store isn't answering: ${err}` : 'Loading the board…'}</Text>
      </Box>
    )
  }
  // Opening fades the pane in, closing fades it out: colour only, so nothing moves or changes size. Overview ↔ task
  // switches at once (The user, M4), and the frame keeps its full height, so neither view resizes the pane.
  const open = at('pane', now)
  const shut = moving('close') ? 1 - at('close', now) : 1
  ink = open * shut
  const glyph = w && t.me.is_lead ? GLYPH[f % 4]! : null
  // A task view waits for its own detail and report; once drawn, a report arriving later never sends it back.
  const shows = v.task && t.task?.id === v.task && (drawn === v.task || ready(t.task, rep)) ? t.task : null
  drawn = shows?.id ?? ''
  const body = shows ? taskView($, el, t, shows, v, rep, glyph, width, now) : overview($, el, t, v, s, glyph, width, now)
  const tree = (
    <Box
      flexDirection="column"
      paddingX={1}
      width={width}
      minHeight={e.props.scroll.bodyRows}
      backgroundColor={themeNow.neon ? C.bg : undefined} // redditflow is its near-black whatever the terminal's
    >
      {body}
      <Box marginTop={1} justifyContent="space-between">
        <Box flexShrink={1}>
          <Text color={k(err || note.startsWith("Couldn't") ? C.amber : C.faint)} wrap="truncate-end">
            {err ? `Store error: ${err}` : note || ' '}
          </Text>
        </Box>
        <Box flexShrink={0} marginLeft={2}>
          <Text color={k(C.faint)}>{t.me.is_lead ? `lead session · ${t.me.repo}` : `read-only · ${t.me.repo}`}</Text>
        </Box>
      </Box>
    </Box>
  )
  ink = 1
  return tree
}

// ---- shared pieces ------------------------------------------------------------------

/** Closes the board (x), at the top right of both views. /board opens it again. */
function closeButton($: $, el: El) {
  const { Button, Text } = el
  return (
    <Button key="close" plain hotkey="x" onPress={() => void $.ui.close({ id: PANE }).catch(() => undefined)} hover={lit('close')}>
      <Text color={k(C.muted)}>✕ Close</Text>
    </Button>
  )
}

/**
 * A text field (`input`, keyed `key`) that grows. The engine's field is one row: past it, the text is cut with "…" and
 * the caret goes out of sight (TAS-11). So once the typing outgrows the row the whole text is drawn wrapped, up to 4
 * lines scrolled to the caret, painted over the field's own row and the room kept under it (TAS-17): one box, never a cut
 * copy above a whole one. The field keeps the keyboard underneath; the caret drawn is where the last edit was.
 */
function field(el: El, key: string, input: unknown) {
  const { Box, Text } = el
  const cols = widthNow - 6 // the pane's padding, then the box's border and padding: what every text box here holds
  const d = typedNow[key]
  const over = d && cellsOf(d.text) > cols - 12 // past the row, beside the field's "⏎ send"
  const w = over ? wrapTail(d.text, d.caret, cols - 3, 4) : null
  const rows = !w ? [] : [
    ...(w.hidden ? [<Text key={`typed-${key}-up`} color={k(C.faint)}>{`  ↑ ${w.hidden} more ${w.hidden === 1 ? 'line' : 'lines'}`.padEnd(cols)}</Text>] : []),
    ...w.lines.map((l, i) => {
      const pad = ' '.repeat(Math.max(0, cols - 2 - cellsOf(l) - (i === w.caret.row && w.caret.col >= l.length ? 1 : 0))) // paints out the field's row
      return (
        <Text key={`typed-${key}-${i}`} color={k(C.text)}>
          <Text color={k(C.soft)}>{'▏ '}</Text>
          {i === w.caret.row ? (
            <Text>
              {l.slice(0, w.caret.col)}
              <Text inverse>{[...l.slice(w.caret.col)][0] ?? ' '}</Text>
              {[...l.slice(w.caret.col)].slice(1).join('')}
            </Text>
          ) : (
            l
          )}
          {pad}
        </Text>
      )
    }),
  ]
  return (
    <Box key={`field-${key}`} flexDirection="column">
      {input as RenderElement}
      {rows.slice(1).map((_, i) => (
        <Text key={`typed-${key}-room-${i}`}> </Text> // the room the painted lines take below the field's row
      ))}
      {rows.length ? ( // last, so it paints over the field and that room
        <Box key={`typed-${key}`} position="absolute" top={0} left={0} width={cols} flexDirection="column" backgroundColor={themeNow.neon ? C.bg : undefined}>
          {rows}
        </Box>
      ) : null}
    </Box>
  )
}

/** Keeps what a field holds (and where the caret is) for typedText; `null` forgets it once sent. */
function typing($: $, key: string, text: string | null): void {
  void update($, typed, ({ [key]: was, ...rest }) => (text === null ? rest : { ...rest, [key]: { text, caret: caretAfter(was?.text ?? '', text, was?.caret) } }))
}

/** A status chip; when the status just changed its colours slide from the old ones. */
function chip(el: El, id: string, p: Pill, now: number) {
  const { Text } = el
  const was = fromOf<Pill>(`pill:${id}`)
  const q = at(`pill:${id}`, now)
  const fg = was ? mix(was.fg, p.fg, q) : p.fg
  const bg = was ? mix(was.bg, p.bg, q) : p.bg
  return tag(el, p.label, fg, bg)
}

/** A filled pill, or in redditflow's look an outlined uppercase chip with its dot: `▕● RESULT READY▏`. */
function tag(el: El, label: string, fg: string, bg: string) {
  const { Text } = el
  if (!themeNow.neon) return <Text color={k(fg)} backgroundColor={k(bg)}> {label} </Text>
  const edge = mix(C.bg, fg, 0.45)
  return (
    <Text>
      <Text color={k(edge)}>▕</Text>
      <Text color={k(fg)} backgroundColor={k(bg)}>● {label.toUpperCase()}</Text>
      <Text color={k(edge)}>▏</Text>
    </Text>
  )
}

/** A section's label: as it is, or redditflow's `> NEEDS YOU`. */
function heading(el: El, label: string, color: string) {
  const { Text } = el
  return (
    <Text bold color={k(color)}>
      {themeNow.neon ? <Text color={k(C.faint)}>{'> '}</Text> : ''}
      {label}
    </Text>
  )
}

/** The left edge of something that just arrived: a bar of light that fades out. */
function gutter(el: El, key: string, now: number) {
  const { Text } = el
  const q = at(key, now)
  return <Text color={k(mix(C.accent, C.bg, q))}>{moving(key) ? '▍' : ' '}</Text>
}

function dot(el: El, r: Repo | undefined) {
  const { Text } = el
  return <Text color={k(r?.badge_color ?? C.muted)}>●</Text>
}

function agentsOf(t: Card): Agent[] {
  return (t.agents ?? []).map(a => parseAgent(a.ref, a.label))
}

const STATE_WORD: Record<AgentState, string> = { working: 'working', idle: 'idle', done: 'finished', unknown: 'checking…' }

/** A static brand mark (never animated): full colour while working, dimmed when idle, faded and struck once finished. */
function badge(el: El, kind: string, state: AgentState, key: string) {
  const { Text } = el
  const b = BADGE[kind] ?? BADGE.agent!
  const tone = state === 'working' ? b.color : mix(C.bg, b.color, state === 'done' ? 0.3 : 0.55)
  return (
    <Text key={key} color={k(tone)} bold={state === 'working'} strikethrough={state === 'done'}>
      {b.mark}
    </Text>
  )
}

/** A PR as a button that opens it: `PR #781 merged ✓`, in Orca's state colour (a tinted pill, or redditflow's outline). */
function prChip($: $, el: El, task: string, ref: string, key: string) {
  const { Button, Text } = el
  const p = prsNow[ref]
  const label = `PR #${p?.number ?? ref.split(/[#/]/).pop()}${p?.state ? ` ${p.state}` : ''}`
  const color = prColor(p) ?? C.muted
  const check = p?.checks && p.checks !== 'none' ? CHECK_LOOK[p.checks] : null
  const bg = themeNow.neon ? C.bg : mix(C.bg, color, 0.18)
  const edge = mix(C.bg, color, 0.45)
  return (
    <Button key={key} plain hover={lit(key)} onPress={() => (p?.url ? void openLink($, task, p.url) : undefined)}>
      {themeNow.neon ? <Text color={k(edge)}>▕</Text> : ''}
      <Text color={k(color)} backgroundColor={k(bg)}>
        {themeNow.neon ? caps(label) : ` ${label}`}
      </Text>
      {check ? <Text color={k(check.color)} backgroundColor={k(bg)}> {check.mark}</Text> : ''}
      {themeNow.neon ? <Text color={k(edge)}>▏</Text> : <Text backgroundColor={k(bg)}> </Text>}
    </Button>
  )
}

/** A row's agents and PRs, ahead of its bar. */
function linked($: $, el: El, t: Card) {
  const { Box, Text } = el
  const ags = agentsOf(t)
  const ps = uniquePrs(t.prs ?? []).slice(0, 2)
  if (!ags.length && !ps.length) return null
  return (
    <Box flexShrink={0} marginRight={2}>
      {ags.slice(0, 4).map((a, i) => (
        <Box key={`ag-${t.id}-${i}`} marginRight={1}>
          {badge(el, a.kind, stateOf(a.ref, liveNow), `agm-${t.id}-${i}`)}
        </Box>
      ))}
      {ags.length > 4 ? <Text color={k(C.faint)}>+{ags.length - 4} </Text> : null}
      {ps.map((p, i) => (
        <Box key={`prb-${t.id}-${i}`} marginRight={1}>
          {prChip($, el, t.id, p.ref, `pr-${t.id}-${i}`)}
        </Box>
      ))}
    </Box>
  )
}

/** "2 agents working · 1 idle" over a repo's open tasks (each agent once). */
function crewWords(tasks: Card[]): string {
  const seen = new Map<string, AgentState>()
  for (const t of tasks) for (const a of agentsOf(t)) seen.set(a.ref, stateOf(a.ref, liveNow))
  const n = (s: AgentState) => [...seen.values()].filter(x => x === s).length
  const w = n('working')
  return [w ? `${w} ${w === 1 ? 'agent' : 'agents'} working` : '', n('idle') ? `${n('idle')} idle` : ''].filter(Boolean).join(' · ')
}

function leadBadge(el: El, r: Repo) {
  const kind = liveNow?.agents[r.lead.terminal ?? '']?.kind ?? 'claude'
  return badge(el, kind, r.lead.state === 'working' ? 'working' : r.lead.state === 'idle' ? 'idle' : 'done', `lead-${r.repo}`)
}

/** The Task view's crew: the lead and each linked agent with model, effort and state; then the PRs. */
function crewBlock($: $, el: El, d: Detail, r: Repo | undefined) {
  const { Box, Text } = el
  const ags = agentsOf(d)
  const ps = uniquePrs(d.prs ?? [])
  if (!ags.length && !ps.length) return null
  const word = (s: AgentState) => (
    <Text color={k(s === 'working' ? C.blue : C.faint)} strikethrough={s === 'done'}>
      {STATE_WORD[s]}
    </Text>
  )
  return (
    <Box flexDirection="column" marginTop={1}>
      {r && r.enabled ? (
        <Text>
          <Text color={k(C.faint)}>{'Crew   '}</Text>
          {leadBadge(el, r)} <Text color={k(C.text)}>lead</Text>
          <Text color={k(C.faint)}>{'  '}{BADGE[liveNow?.agents[r.lead.terminal ?? '']?.kind ?? 'claude']?.name ?? 'Claude'} · </Text>
          {word(r.lead.state === 'working' ? 'working' : r.lead.state === 'idle' ? 'idle' : 'done')}
        </Text>
      ) : null}
      {ags.map((a, i) => {
        const s = stateOf(a.ref, liveNow)
        return (
          <Text key={`crew-${i}`}>
            <Text color={k(C.faint)}>{i || (r && r.enabled) ? '       ' : 'Crew   '}</Text>
            {badge(el, a.kind, s, `crewm-${i}`)} <Text color={k(C.text)}>{a.role || BADGE[a.kind]?.name || a.kind}</Text>
            <Text color={k(C.faint)}>
              {'  '}
              {[a.model, a.effort].filter(Boolean).join(' · ') || BADGE[a.kind]?.name || a.kind} ·{' '}
            </Text>
            {word(s)}
          </Text>
        )
      })}
      {ps.map((p, i) => {
        const pr = prsNow[p.ref]
        return (
          <Box key={`prrow-${i}`}>
            <Text color={k(C.faint)}>{i ? '       ' : 'PRs    '}</Text>
            {prChip($, el, d.id, p.ref, `prv-${i}`)}
            <Text color={k(C.faint)}>
              {'  '}
              {[
                pr?.state ? '' : p.ref.startsWith('#') ? '(link it as owner/repo#n for live state)' : 'checking…',
                pr?.checks && pr.checks !== 'none' ? `checks ${pr.checks}` : '',
                pr?.review ?? '',
                p.label,
              ]
                .filter(Boolean)
                .join(' · ')}
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}

/** A thin gradient bar with half-cell steps; when the steps advance it fills from where it was. */
function bar(el: El, t: Card, now: number, width = 14) {
  const { Text } = el
  const p = pill(t)
  const tone = t.status === 'done' ? C.green : t.needs_you || t.status === 'blocked' ? C.amber : p.fg
  const to = t.steps_total ? t.steps_done / t.steps_total : 0
  const from = fromOf<number>(`bar:${t.id}`)
  const q = at(`bar:${t.id}`, now)
  const cells = barCells(from === undefined ? to : from + (to - from) * q, width)
  const lit = Array.from({ length: cells.full }, (_, i) => mix(mix(C.bg, tone, 0.45), tone, cells.full > 1 ? i / (cells.full - 1) : 1))
  const tip = moving(`bar:${t.id}`) ? mix(C.bright, tone, q) : tone
  const stage = stageOf(t)
  const label = t.steps_total ? progressLabel(t) : stage.word
  const blocked = t.status === 'blocked' && !t.needs_you && p.label !== 'Blocked' // the chip shows something else (Result ready)
  return (
    <Text>
      {t.steps_total > 0 ? (
        <Text>
          {lit.map((c, i) => (
            <Text key={`b${i}`} color={k(c)}>━</Text>
          ))}
          {cells.half ? <Text color={k(tip)}>╸</Text> : ''}
          <Text color={k(C.soft)}>{'━'.repeat(cells.rest)}</Text>{' '}
        </Text>
      ) : (
        // no steps from the lead: where it is by stage, as 5 segments (never the step bar's ━, so not read as steps)
        <Text>
          <Text color={k(tone)}>{'▰'.repeat(stage.level)}</Text>
          <Text color={k(C.soft)}>{'▱'.repeat(5 - stage.level)}</Text>{' '}
        </Text>
      )}
      <Text color={k(t.steps_total ? C.muted : C.faint)}>{label}</Text>
      {blocked ? <Text color={k(C.amber)}>{label ? ' · ' : ''}Blocked</Text> : ''}
    </Text>
  )
}

/** A section opening or closing: drawn at its full height at once and faded in (or out), so rows never grow one by one. */
function reveal<T>(key: string, open: boolean, now: number, build: () => T[]): T[] {
  if (!moving(key)) return open ? build() : []
  const q = at(key, now)
  return faded(open ? q : 1 - q, build)
}

function leadWords(r: Repo): { text: string; color: string } {
  if (!r.enabled) return { text: 'crew-board off', color: C.faint }
  if (r.lead.state === 'working') return { text: 'lead working', color: C.blue }
  if (r.lead.state === 'idle') return { text: 'lead available', color: C.green }
  if (r.lead.state === 'starting') return { text: 'lead starting…', color: C.blue }
  if (r.lead.state === 'unconfirmed') return { text: 'lead start not confirmed', color: C.amber }
  return { text: 'no lead running', color: C.faint }
}

/**
 * A repo with no lead up (TAS-1): Start a lead here, or Resume and Start fresh when the store knows the last lead's
 * conversation. Pressing one asks the one confirm in the same place (a lead costs money; y and n are its keys, so the
 * Overview's n waits); a starting lead shows its
 * state instead (leadWords), so it is never started twice.
 */
export function leadStarter($: $, el: El, r: Repo | undefined, at = 'start') { // at: its keys' prefix, one per place it is drawn
  const { Box, Text, Button } = el
  const anyway = r?.lead.state === 'unconfirmed' // Orca never answered a start: a lead may be running in a terminal
  if (!r?.enabled || (r.lead.state !== 'offline' && !anyway)) return null
  const key = `${at}-${r.repo}`
  const ask = confirmNow?.repo === r.repo ? confirmNow : null
  const button = (k2: string, label: string, onPress: () => void, color: string, hotkey?: string) => (
    <Button key={k2} plain hotkey={hotkey} hover={lit(k2)} onPress={onPress}>
      <Text color={k(color)}>{label}</Text>
    </Button>
  )
  return (
    <Box key={key} flexShrink={0}>
      <Text color={k(C.soft)}>  </Text>
      {ask ? (
        <Text color={k(C.amber)}>
          {ask.anyway ? `No new lead terminal for ${r.display_name}? Start one` : ask.resume ? `Resume the ${r.display_name} lead` : `Start a Claude lead in ${r.display_name}`}?{' '}
        </Text>
      ) : null}
      {ask ? button(`${key}-yes`, 'y', () => void launchLead($, true), C.accent, 'y') : null}
      {ask ? <Text color={k(C.faint)}>/</Text> : null}
      {ask ? button(`${key}-no`, 'n', () => void launchLead($, false), C.muted, 'n') : null}
      {!ask && anyway ? button(`${key}-anyway`, 'Start anyway', () => void startLead($, r.repo, false, true), C.accent) : null}
      {!ask && !anyway && r.lead.resumable ? button(`${key}-resume`, '↻ Resume', () => void startLead($, r.repo, true), C.accent) : null}
      {!ask && !anyway && r.lead.resumable ? <Text color={k(C.soft)}> · </Text> : null}
      {!ask && !anyway ? button(`${key}-fresh`, r.lead.resumable ? 'Start fresh' : '▸ Start a lead here', () => void startLead($, r.repo), C.accent) : null}
    </Box>
  )
}

// ---- overview -------------------------------------------------------------------

function overview($: $, el: El, t: Tick, v: View, s: Search, glyph: string | null, width: number, now: number) {
  const { Box, Text, Button, Input } = el
  const repos = [...t.board.repos].sort((a, b) => (a.repo === t.me.repo ? -1 : b.repo === t.me.repo ? 1 : 0))
  const open = t.board.tasks.filter(x => !x.closed || x.just_done) // just finished: in place until the user has seen it (TAS-21)
  const done = t.board.tasks.filter(x => x.closed && !x.just_done)
  const { count: need, chores } = needsYou(t)
  const running = open.filter(x => x.status === 'running' && !x.needs_you).length
  const ready = open.filter(x => x.has_result && !x.needs_you).length
  const settling = [...ghosts.values()].filter(g => !t.board.decisions.some(d => d.id === g.d.id))
  const shown = repos.filter(r => t.board.tasks.some(x => x.repo === r.repo) || [t.me.repo, v.adding, v.added?.repo].includes(r.repo))
  const openDone = v.openDone ?? [] // repos whose Completed fold is open (TAS-25)
  const withDone = shown.filter(r => done.some(x => x.repo === r.repo)).map(r => r.repo)
  // what NEEDS YOU lists is not listed again in its repo below
  const waiting = new Set([...t.board.decisions.map(d => d.task_id), ...chores.map(x => x.id)])
  idW = Math.max(6, ...t.board.tasks.map(x => x.id.length))
  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text bold color={k(C.bright)}>
          {heading(el, caps('Tasks'), C.bright)}
          {glyph ? <Text color={k(C.blue)}> {glyph}</Text> : ''}
        </Text>
        <Box>
          <Text>
            {need ? tag(el, `${need} need you`, C.amber, C.amberBg) : ''}
            {running ? <Text>{need ? ' ' : ''}{tag(el, `${running} running`, C.blue, C.blueBg)}</Text> : ''}
            {ready ? <Text>{need || running ? ' ' : ''}{tag(el, `${ready} ready`, C.green, C.greenBg)}</Text> : ''}
            {!need && !running && !ready ? <Text color={k(C.faint)}>all quiet</Text> : ''}
            {'   '}
          </Text>
          {closeButton($, el)}
        </Box>
      </Box>
      <Box>
        <Text color={k(C.faint)}>{open.length} open · </Text>
        <Button
          key="done"
          plain
          hotkey="d"
          hover={lit('done')}
          onPress={() => setView($, x => ({ ...x, openDone: withDone.every(r => (x.openDone ?? []).includes(r)) ? [] : withDone }))}
        >
          <Text color={k(C.faint)}>{done.length} done</Text>
        </Button>
        <Text color={k(C.faint)}>
          {' '}· {repos.filter(r => r.lead.state === 'working' || r.lead.state === 'idle').length} of {repos.filter(r => r.lead.registered).length} leads up
        </Text>
      </Box>
      <Text color={k(C.soft)}>{'─'.repeat(Math.max(10, width - 2))}</Text>
      {searchBox($, el, s)}
      {s.q ? null : newRow($, el, v)}
      {s.q ? found($, el, t, s, width, now) : overviewBody()}
      {v.picking && !s.q ? picker($, el, t, v.picking, width) : null /* last: it paints over the rows drawn before it */}
    </Box>
  )
  function overviewBody() {
    return (
    <Box flexDirection="column">
      {(need > 0 || settling.length > 0) && (
        <Box flexDirection="column" marginTop={1}>
          {heading(el, 'NEEDS YOU', C.amber)}
          {settling.map(g => settledBox(el, g, t.board.repos.find(r => r.repo === repoOfTask(t, g.d.task_id)), now))}
          {t.board.decisions.map((d, i) =>
            i === 0 ? (
              decisionBox($, el, d, true, t.board.repos.find(r => r.repo === repoOfTask(t, d.task_id)), now, v)
            ) : (
              line(
                el,
                {
                  key: `dec-row-${d.id}`,
                  press: () => openPane($, d.task_id),
                  tone: C.amber,
                  id: d.task_id,
                  title: d.question,
                  ...repoTag(el, repoOf(t, d.task_id), repoOfTask(t, d.task_id) ?? ''),
                  sub: <Text color={k(C.faint)} wrap="truncate-end">{d.id} · {d.options.length} options ›</Text>,
                  fresh: `new:${d.id}`,
                  over: w2 => rowEnd($, el, d.task_id, v, w2),
                },
                width - 2,
                now,
              )
            ),
          )}
          {chores.map(x =>
            line(
              el,
              {
                key: `chore-${x.id}`,
                press: () => openPane($, x.id),
                tone: C.amber,
                id: x.id,
                title: x.title,
                ...repoTag(el, repoOf(t, x.id), x.repo),
                age: ago(x.updated, now),
                sub: (
                  <Text wrap="truncate-end">
                    {bar(el, x, now, 10)}
                    <Text color={k(C.faint)}>  — {x.next || x.step_label || 'waiting on you'} ›</Text>
                  </Text>
                ),
                fresh: `new:${x.id}`,
                over: w2 => rowEnd($, el, x.id, v, w2),
              },
              width - 2,
              now,
            ),
          )}
        </Box>
      )}
      {shown.map(r => {
        const all = open.filter(x => x.repo === r.repo)
        const mine = all.filter(x => !waiting.has(x.id))
        const active = mine.filter(x => x.status !== 'proposed')
        const proposed = mine.filter(x => x.status === 'proposed')
        const unfolded = (v.openProposed ?? []).includes(r.repo)
        const finished = done.filter(x => x.repo === r.repo)
        const doneHere = openDone.includes(r.repo)
        return (
          <Box flexDirection="column" marginTop={1} key={`repo-${r.repo}`}>
            {repoHeader($, el, r, all.length, 'open', width, crewWords(all), r.enabled ? plus($, el, r) : null)}
            {v.adding === r.repo ? adder($, el, r, v) : v.added?.repo === r.repo ? sentLine($, el, r, v.added.id) : null}
            {active.map(x => taskRow($, el, x, width - 2, now, v))}
            {proposed.length > 0 && (
              <Box key={`proposed-box-${r.repo}`} hover={{ backgroundColor: C.raised }}>
                <Button
                  key={`proposed-${r.repo}`}
                  plain
                  hover={{ color: C.bright }}
                  onPress={() =>
                    setView($, x => {
                      const was = x.openProposed ?? []
                      return { ...x, openProposed: unfolded ? was.filter(y => y !== r.repo) : [...was, r.repo] }
                    })
                  }
                >
                  <Text color={k(C.faint)}>
                    {'  '}
                    {unfolded ? '▾' : '▸'} {proposed.length} proposed
                  </Text>
                </Button>
              </Box>
            )}
            {unfolded && proposed.map(x => taskRow($, el, x, width - 2, now, v))}
            {!all.length && v.adding !== r.repo && v.added?.repo !== r.repo ? (
              <Text color={k(C.faint)}>
                {'   '}
                <Text color={k(C.green)}>✓</Text> Nothing open here.{r.enabled ? ' ＋ starts one.' : ''}
              </Text>
            ) : !mine.length ? (
              <Text color={k(C.faint)}>{'   '}Everything open here is waiting on you, above.</Text>
            ) : null}
            {finished.length > 0 && (
              <Box key={`done-box-${r.repo}`} hover={{ backgroundColor: C.raised }}>
                <Button
                  key={`done-${r.repo}`}
                  plain
                  hover={{ color: C.bright }}
                  onPress={() =>
                    setView($, x => {
                      const was = x.openDone ?? []
                      return { ...x, openDone: doneHere ? was.filter(y => y !== r.repo) : [...was, r.repo] }
                    })
                  }
                >
                  <Text color={k(C.faint)}>
                    {'  '}
                    {doneHere ? '▾' : '▸'} {finished.length} completed
                  </Text>
                </Button>
              </Box>
            )}
            {reveal(`done:${r.repo}`, doneHere, now, () => finished.map(x => taskRow($, el, x, width - 2, now)))}
          </Box>
        )
      })}
      {themeSection($, el, v)}
    </Box>
    )
  }
}

// ---- new tasks: ＋ on a repo, or the list of every repo (TAS-16, TAS-19, TAS-20) ----------------------------

const PICK_ROWS = 8 // the list's height, whatever the filter leaves: opening or filtering it never resizes anything

/** Moves the keyboard to a field this press just asked for: it can take it once the redraw has drawn it. */
async function focusSoon($: $, key: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const r = await $.ui.focus({ requestId: PANE, key }).catch(() => ({ deny: 'failed' }))
    if (!r?.deny) return
    if (!(await $.clock.sleep(50).then(() => true, () => false))) return // unloaded meanwhile
  }
}

/** Opens `repo`'s new-task field under its header, with the keyboard in it. */
async function startAdding($: $, repo: string): Promise<void> {
  const v = await update($, view, x => ({ ...x, adding: repo, added: null, picking: null }))
  await focusSoon($, `add-${repo}-${v.composer}`)
}

/** The ＋ at the end of a repo's header row. */
function plus($: $, el: El, r: Repo) {
  const { Button, Text } = el
  return (
    <Button key={`add-${r.repo}`} plain hover={lit(`add-${r.repo}`)} onPress={() => void startAdding($, r.repo)}>
      <Text color={k(C.accent)} bold>{'  ＋'}</Text>
    </Button>
  )
}

/** A repo's new-task field, right under its header. Enter sends it and closes it; an empty Enter, or Esc, just closes it. */
function adder($: $, el: El, r: Repo, v: View) {
  const { Box, Input } = el
  const key = `add-${r.repo}-${v.composer}`
  const close = () => void (typing($, key, null), update($, view, x => ({ ...x, adding: null })))
  return (
    <Box key={`adder-${r.repo}`} borderStyle="round" borderColor={k(C.accent)} paddingX={1} flexDirection="column">
        {field(
          el,
          key,
          <Input
            key={key}
            placeholder={`New task for ${r.display_name}: describe it, then Enter`}
            submitLabel="send to lead"
            onInput={text => typing($, key, text)}
            onSubmit={text => {
              if (!text.trim()) return close()
              typing($, key, null)
              void update($, view, x => ({ ...x, adding: null, composer: x.composer + 1 })).then(() => newTask($, r.repo, text))
            }}
          />,
        )}
    </Box>
  )
}

/** Where the field was: the task went, and its ID opens it (TAS-20). */
function sentLine($: $, el: El, r: Repo, id: string) {
  const { Box, Text, Button } = el
  return (
    <Box key={`sent-${r.repo}`} paddingLeft={3}>
      <Text color={k(C.green)}>✓ </Text>
      <Text color={k(C.faint)}>Sent to the {r.display_name} lead as </Text>
      <Button key={`sent-open-${id}`} plain hover={lit(`sent-open-${id}`)} onPress={() => openPane($, id)}>
        <Text color={k(C.accent)}>{id} ›</Text>
      </Button>
    </Box>
  )
}

/** "＋ New task" under the search box (n): opens the list of every repo. */
function newRow($: $, el: El, v: View) {
  const { Box, Text, Button } = el
  return (
    <Box key="new-row" paddingLeft={1}>
      <Button key="new-task" plain hotkey={confirmNow ? undefined : 'n'} hover={lit('new-task')} onPress={() => void openPicker($, !v.picking)}>
        <Text color={k(C.accent)} bold>＋ New task</Text>
        <Text color={k(C.faint)}>  pick the repo it's for</Text>
      </Button>
    </Box>
  )
}

async function openPicker($: $, open = true): Promise<void> {
  await update($, view, x => ({ ...x, picking: open ? { q: '', at: 0 } : null, composer: x.composer + (open ? 1 : 0) }))
  if (!open) return
  void $.ui.scroll({ in: PANE, to: 'start' }).catch(() => undefined) // the list opens at the top of the board
  await focusSoon($, `pick-q-${(await read($, view)).composer}`)
}

/** The repos the filter leaves, the current repo first: by name or folder, any part. */
function pickable(t: Tick, q: string): Repo[] {
  const want = q.trim().toLowerCase()
  return [...t.board.repos]
    .sort((a, b) => (a.repo === t.me.repo ? -1 : b.repo === t.me.repo ? 1 : a.display_name.localeCompare(b.display_name)))
    .filter(r => !want || r.display_name.toLowerCase().includes(want) || r.repo.toLowerCase().includes(want))
}

async function pickRepo($: $, r: Repo | undefined): Promise<void> {
  if (!r) return
  if (!r.enabled) return void (await update($, notice, () => `crew-board is off in ${r.display_name}: switch it on there first (tasks enable ${r.repo})`))
  await startAdding($, r.repo)
}

/** The arrows, while the list is open: they move its highlight instead of scrolling the board. */
export async function pickerScroll($: $, by: number): Promise<boolean> {
  const [v, t] = await Promise.all([read($, view), read($, tick)])
  if (!v.picking || !t) return false
  const n = pickable(t, v.picking.q).length
  const at = Math.max(0, Math.min(n - 1, v.picking.at + Math.sign(by)))
  await update($, view, x => (x.picking ? { ...x, picking: { ...x.picking, at } } : x))
  return true
}

/**
 * The list of every repo, opened over the board (it paints over the rows below without moving them): a filter to
 * type in, each repo with its colour and whether its lead is up. Enter takes the highlighted one, a click any one.
 */
function picker($: $, el: El, t: Tick, p: { q: string; at: number }, width: number) {
  const { Box, Text, Button, Input } = el
  const all = pickable(t, p.q)
  const at = Math.min(p.at, Math.max(0, all.length - 1))
  const from = Math.max(0, Math.min(at - PICK_ROWS + 1, all.length - PICK_ROWS)) // the window keeps the highlight in view
  const rows = all.slice(from, from + PICK_ROWS)
  const inner = width - 6
  const key = `pick-q-${(viewNow?.composer ?? 0)}`
  return (
    <Box
      key="picker"
      position="absolute"
      top={7} // under "＋ New task": the title, counts and rule rows, the search box's three, then that row
      left={0}
      width={width - 2}
      flexDirection="column"
      borderStyle="round"
      borderColor={k(C.accent)}
      paddingX={1}
      backgroundColor={C.bg}
    >
      <Input
        key={key}
        label="Repo"
        placeholder="type to filter; Enter picks the top one, Tab walks the list"
        submitLabel="pick"
        onInput={q => void update($, view, x => ({ ...x, picking: { q, at: 0 } }))}
        onSubmit={q => void pickRepo($, pickable(t, q)[q === p.q ? at : 0])}
      />
      {Array.from({ length: PICK_ROWS }, (_, i) => {
        const r = rows[i]
        if (!r) return <Text key={`pick-empty-${i}`}>{' '.repeat(inner)}</Text>
        const on = from + i === at
        // a repo with no lead: "no lead", and its Start a lead here (TAS-1), which only asks y / n where it stands
        const lead = !r.enabled ? 'crew-board off' : r.lead.state === 'offline' ? 'no lead' : leadWords(r).text
        const name = clip(r.display_name, Math.max(8, inner - 48))
        return (
          <Box key={`pick-row-${r.repo}`} width={inner}>
            <Text>{' '.repeat(inner)}</Text>
            <Box position="absolute" top={0} left={0} width={inner} justifyContent="space-between">
              <Button key={`pick-${r.repo}`} plain hover={lit(`pick-${r.repo}`)} onPress={() => void pickRepo($, r)}>
                <Text color={k(on ? C.accent : C.faint)}>{on ? '› ' : '  '}</Text>
                {dot(el, r)}
                <Text color={k(!r.enabled ? C.faint : on ? C.bright : C.text)} bold={on}> {name}</Text>
              </Button>
              <Box flexShrink={0}>
                <Text color={k(r.enabled && r.lead.state !== 'offline' ? leadWords(r).color : C.faint)}>{lead}</Text>
                {leadStarter($, el, r, 'pick-start')}
              </Box>
            </Box>
          </Box>
        )
      })}
      <Box justifyContent="space-between">
        <Text color={k(C.faint)}>{all.length > PICK_ROWS ? `${all.length} repos, ${PICK_ROWS} shown · ` : ''}Esc closes</Text>
        <Button key="pick-close" plain hover={lit('pick-close')} onPress={() => void openPicker($, false)}>
          <Text color={k(C.faint)}>✕ Close</Text>
        </Button>
      </Box>
    </Box>
  )
}

/** The search box at the top of the Overview (f): Enter searches every task, emptying it goes back to the overview. */
function searchBox($: $, el: El, s: Search) {
  const { Box, Text, Button, Input } = el
  return (
    <Box borderStyle="round" borderColor={k(C.soft)} paddingX={1}>
      <Button key="find" plain hotkey="f" onPress={() => void $.ui.focus({ requestId: PANE, key: `search-${s.box}` }).catch(() => undefined)}>
        <Text color={k(C.accent)}>⌕ </Text>
      </Button>
      <Box flexGrow={1}>
        <Input
          key={`search-${s.box}`}
          placeholder="Find a task: its ID, or what you remember about it, then Enter"
          submitLabel="search"
          onInput={text => (!text.trim() ? void find($, '') : undefined)} // also cancels a search still on its way
          onSubmit={text => void find($, text)}
        />
      </Box>
    </Box>
  )
}

/** Search results in place of the overview: each task with its repo, status and the stored text that matched. */
function found($: $, el: El, t: Tick, s: Search, width: number, now: number) {
  const { Box, Text, Button } = el
  const cards = new Map(t.board.tasks.map(x => [x.id, x]))
  const hits = results(s).filter(x => cards.has(x.id))
  const status =
    s.state === 'thinking' ? 'Searching by meaning too…' : s.state === 'unavailable' ? 'Meaning search unavailable: these are word matches.' : ' '
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box justifyContent="space-between" width={width - 2}>
        <Text>
          {heading(el, caps('Found'), C.accent)}
          <Text color={k(C.faint)}> {hits.length ? `${hits.length} for “${s.q}”` : `nothing${s.state === 'thinking' ? ' yet' : ''} for “${s.q}”`}</Text>
        </Text>
        <Button key="search-clear" plain onPress={() => void find($, '', true)} hover={lit('search-clear')}>
          <Text color={k(C.muted)}>Clear search</Text>
        </Button>
      </Box>
      <Text color={k(s.state === 'unavailable' ? C.amber : C.faint)}>{status}</Text>
      {hits.map(x => hitRow($, el, t, cards.get(x.id)!, x, width, now))}
      {!hits.length && s.state !== 'thinking' ? (
        <Text color={k(C.faint)}>   No task matches that. Try other words, or Clear search to see every task.</Text>
      ) : null}
    </Box>
  )
}

const WHERE: Record<string, string> = { message: 'message', event: 'activity', report: 'report' }

function hitRow($: $, el: El, t: Tick, c: Card, hit: Hit, width: number, now: number) {
  const { Box, Text, Button } = el
  const r = t.board.repos.find(x => x.repo === c.repo)
  const w = hit.where
  const label = (WHERE[w.kind] ?? String(w.ref ?? '')) + (w.ts ? ` · ${ago(w.ts, now)}` : '')
  return (
    <Box flexDirection="column" key={`hit-box-${hit.id}`} hover={{ backgroundColor: C.raised }}>
      <Box justifyContent="space-between" width={width - 2}>
        <Box flexShrink={1}>
          <Button key={`hit-${hit.id}`} plain onPress={() => void openHit($, hit)} hover={{ color: C.bright }}>
            <Text color={k(C.faint)}> {hit.id.padEnd(8)}</Text>
            <Text bold color={k(C.text)}>
              {clip(c.title, width - 2 - 9 - 1 - cellsOf(r?.display_name ?? c.repo) - 3 - chipWidth(pill(c).label))}
            </Text>
          </Button>
        </Box>
        <Box flexShrink={0}>
          <Text>
            {dot(el, r)} <Text color={k(C.muted)}>{r?.display_name ?? c.repo}</Text> {chip(el, c.id, pill(c), now)}
          </Text>
        </Box>
      </Box>
      <Box paddingLeft={10}>
        <Text wrap="truncate-end" color={k(C.faint)}>
          {label ? `${label}: ` : ''}<Text color={k(C.muted)}>{hit.excerpt}</Text>
        </Text>
      </Box>
    </Box>
  )
}

/** The Theme picker, folded away at the very bottom like Completed. */
function themeSection($: $, el: El, v: View) {
  const { Box, Text, Button } = el
  const what = (THEMES.find(x => x.choice === themeNow.choice) ?? THEMES[0]!).label
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box key="theme-toggle-box" hover={{ backgroundColor: C.raised }}>
        <Button key="theme" plain hotkey="t" onPress={() => setView($, x => ({ ...x, showTheme: !x.showTheme }))} hover={{ color: C.bright }}>
          <Text color={k(C.muted)}>
            {v.showTheme ? '▾' : '▸'} {caps('Theme')} <Text color={k(C.faint)}>{v.showTheme ? '' : what}</Text>
          </Text>
        </Button>
      </Box>
      {v.showTheme &&
        THEMES.map(x => {
          const on = x.choice === themeNow.choice
          return (
            <Box key={`theme-row-${x.choice}`} paddingLeft={2} hover={{ backgroundColor: C.raised }}>
              <Button key={`theme-${x.choice}`} plain hover={lit(`theme-${x.choice}`)} onPress={() => void pickTheme($, x.choice)}>
                <Text color={k(on ? C.accent : C.text)} bold={on}>
                  {on ? '◉' : '○'} {x.label}
                </Text>
                <Text color={k(C.faint)}>  {x.note}</Text>
              </Button>
            </Box>
          )
        })}
    </Box>
  )
}

function repoOfTask(t: Tick, id: string): string | undefined {
  return t.board.tasks.find(x => x.id === id)?.repo
}

function repoOf(t: Tick, id: string): Repo | undefined {
  return t.board.repos.find(r => r.repo === repoOfTask(t, id))
}

function repoHeader($: $, el: El, r: Repo, n: number, word: string, width: number, crew = '', extra: unknown = null) {
  const { Box, Text } = el
  const lead = leadWords(r)
  return (
    <Box justifyContent="space-between" width={width - 2}>
      <Box flexShrink={1}>
      <Text wrap="truncate-end">
        {dot(el, r)} <Text bold color={k(C.text)}>{caps(r.display_name)}</Text>
        <Text color={k(C.soft)}>  │ </Text>
        {r.enabled ? <Text>{leadBadge(el, r)} </Text> : ''}
        <Text color={k(lead.color)}>{lead.text}</Text>
        {crew ? <Text color={k(C.faint)}> · {crew}</Text> : ''}
      </Text>
      {leadStarter($, el, r)}
      </Box>
      <Box flexShrink={0} marginLeft={1}>
        <Text color={k(C.faint)}>
          {n} {word}
        </Text>
        {extra as RenderElement}
      </Box>
    </Box>
  )
}

type Line = {
  key: string // the button's key (what tests press); the row's box is `${key}-box`
  press: () => void
  tone: string // the status colour: the bar and the ID carry it
  dim?: boolean // proposed, dropped, done: the row steps back
  id: string
  title: string
  bold?: boolean
  right: unknown // the chip column: a status chip, or a repo
  rightW: number // its width: the title runs up to it
  age?: string
  sub?: unknown // the dim second line under the title, or nothing
  fresh?: string // the tween of a row that just arrived: its bar flashes
  over?: (w: number) => unknown // drawn over the chip and age (w wide), out of the flow: the row's ✓ done / ✕ close (TAS-26)
}

/** Width a status chip takes: the pill's padding, or redditflow's `▕● LABEL▏`. */
const chipWidth = (label: string) => label.length + (themeNow.neon ? 4 : 2)

/**
 * One row, the same everywhere in the Overview: a bar and the ID in the task's status colour, the title clipped to
 * one line, the chip right-aligned against a fixed edge, the age last; then, under the title (never at column 0), an
 * optional dim line. `w` is the row's width.
 */
function line(el: El, o: Line, w: number, now: number) {
  const { Box, Text, Button } = el
  const flash = o.fresh && moving(o.fresh) ? mix(C.accent, o.tone, at(o.fresh, now)) : o.tone
  const titleW = w - 2 - idW - 2 - 1 - o.rightW - 9
  return (
    <Box flexDirection="column" key={`${o.key}-box`} marginBottom={1} hover={{ backgroundColor: C.raised }}>
      <Box width={w}>
        <Text color={k(o.dim ? mix(C.bg, flash, 0.5) : flash)}>{'▌ '}</Text>
        <Box flexGrow={1}>
          <Button key={o.key} plain onPress={o.press} hover={{ color: C.bright }}>
            <Text color={k(o.dim ? mix(C.bg, o.tone, 0.6) : o.tone)} bold={!o.dim}>
              {o.id.padEnd(idW + 2)}
            </Text>
            <Text color={k(o.dim ? C.muted : o.bold ? C.bright : C.text)} bold={o.bold} wrap="truncate-end">
              {clip(o.title, titleW)}
            </Text>
          </Button>
        </Box>
        <Box width={o.rightW + 1} flexShrink={0} justifyContent="flex-end">
          {o.right as RenderElement}
        </Box>
        <Box width={9} flexShrink={0} justifyContent="flex-end">
          <Text color={k(C.faint)}>{o.age ?? ''}</Text>
        </Box>
        {o.over?.(o.rightW + 1 + 9) as RenderElement}
      </Box>
      {o.sub ? (
        <Box width={w} paddingLeft={2 + idW + 2}>
          {o.sub as RenderElement}
        </Box>
      ) : null}
    </Box>
  )
}

function taskRow($: $, el: El, t: Card, w: number, now: number, v?: View) { // v: an open row with its end controls
  const { Box, Text } = el
  const p = pill(t)
  const fin = t.closed && t.just_done // just finished, still in its place: green and whole, its PRs still beside it
  const dim = !fin && (t.closed || t.status === 'proposed' || t.status === 'dropped')
  const progress = bar(el, t, now, 10)
  const ahead = t.closed && !fin ? null : linked($, el, t)
  const sub =
    ahead || progress || t.summary ? (
      <Box>
        {ahead}
        <Box flexShrink={1}>
          <Text wrap="truncate-end">
            {progress}
            {t.summary ? <Text color={k(C.faint)}>{progress ? '  — ' : ''}{t.summary}</Text> : ''}
          </Text>
        </Box>
      </Box>
    ) : null
  return line(
    el,
    {
      key: `task-${t.id}`,
      press: () => openPane($, t.id),
      tone: t.closed ? C.green : p.fg,
      dim,
      id: t.id,
      title: t.title,
      bold: !t.closed && (t.needs_you || t.has_result),
      right: chip(el, t.id, p, now),
      rightW: chipWidth(p.label),
      age: ago(t.updated, now),
      sub,
      fresh: `new:${t.id}`,
      over: v && !t.closed ? w2 => rowEnd($, el, t.id, v, w2) : undefined,
    },
    w,
    now,
  )
}

/**
 * ✓ done and ✕ close on an open Overview row (TAS-26): shown while the pointer is on the row, painted over its chip and
 * age so nothing moves; each asks the same "Sure? Yes / No" as the task view, which stays up until answered.
 */
function rowEnd($: $, el: El, id: string, v: View, w: number) { // w: the chip and age columns it covers
  const { Box, Text, Button } = el
  const ask = v.confirm?.task === id ? v.confirm.what : null
  const button = (key: string, label: string, color: string, onPress: () => void, hotkey?: string) => (
    <Button key={key} plain hotkey={hotkey} hover={lit(key)} onPress={onPress}>
      <Text color={k(color)} bold={!!hotkey}>{label}</Text>
    </Button>
  )
  return (
    <Box
      position="absolute"
      top={0}
      right={0}
      minWidth={w}
      justifyContent="flex-end"
      paddingX={1}
      backgroundColor={C.raised}
      display={ask ? 'flex' : 'none'}
      hover={ask ? undefined : { display: 'flex' }}
    >
      {ask ? (
        <Text color={k(C.amber)}>{ENDS[ask].ask} </Text>
      ) : null}
      {ask ? button(`row-yes-${id}`, 'Yes', C.accent, () => endTask($, id, ask, false), confirmNow ? undefined : 'y') : null}
      {ask ? <Text color={k(C.faint)}> / </Text> : null}
      {ask ? button(`row-no-${id}`, 'No', C.muted, () => void update($, view, x => ({ ...x, confirm: null })), confirmNow ? undefined : 'n') : null}
      {ask ? null : button(`row-done-${id}`, '✓ done', C.green, () => void update($, view, x => ({ ...x, confirm: { task: id, what: 'done' as const } })))}
      {ask ? null : <Text>  </Text>}
      {ask ? null : button(`row-close-${id}`, '✕ close', C.muted, () => void update($, view, x => ({ ...x, confirm: { task: id, what: 'dropped' as const } })))}
    </Box>
  )
}

/** A repo in the chip column (Needs-you rows, where a "Needs you" chip would say nothing new), and its width. */
function repoTag(el: El, r: Repo | undefined, repo: string): { right: RenderElement; rightW: number } {
  const { Text } = el
  const name = clip(r?.display_name ?? repo, 18)
  return {
    right: (
      <Text>
        {dot(el, r)} <Text color={k(C.muted)}>{name}</Text>
      </Text>
    ),
    rightW: cellsOf(name) + 2,
  }
}

// ---- decisions: the ask-tool dialog, without the blocking ---------------------------

function decisionBox($: $, el: El, d: Decision, keys: boolean, r: Repo | undefined, now: number, v?: View) { // v: its end controls
  const g = ghosts.get(d.id)
  if (g) return settledBox(el, g, r, now)
  const { Box, Text, Button, Input } = el
  const picked = d.multi ? (ticked[d.id] ?? []) : []
  // One answer, settled (animated) once it is sent: a single option, or every ticked option and any typed text.
  const send = async (ns: number[], typed?: string, done = 'Answer sent') => {
    const text = (typed ?? drafts[d.id] ?? '').trim()
    if (!ns.length && !text) return void update($, notice, () => 'Tick one or more options first')
    settle($, d, ns, text)
    const args = ['pick', d.id, ...ns.flatMap(n => ['--option', String(n)]), ...(text ? ['--text', text] : [])]
    if ((await act($, args, done)) === undefined) return unsettle(d.id)
    delete drafts[d.id]
    typing($, `dec-text-${d.id}`, null)
    if (d.multi) await update($, chosen, ({ [d.id]: _, ...rest }) => rest)
  }
  const fresh = at(`new:${d.id}`, now)
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={k(mix(C.amber, mix(C.bg, C.amber, 0.6), fresh))}
      paddingX={1}
      key={`dec-${d.id}`}
    >
      <Box justifyContent="space-between">
        <Text>
          <Text color={k(C.amber)} bold>{d.id}</Text>
          {r ? <Text color={k(C.faint)}>  {r.display_name}</Text> : ''}
          {d.raised > 1 ? <Text color={k(C.faint)}>  · asked {d.raised}×</Text> : ''}
        </Text>
        <Button key={`dec-open-${d.id}`} plain onPress={() => openPane($, d.task_id)} hover={lit(`dec-open-${d.id}`)}>
          <Text color={k(C.faint)}>open {d.task_id} ›</Text>
        </Button>
        {v ? rowEnd($, el, d.task_id, v, cellsOf(`open ${d.task_id} ›`)) : null}
      </Box>
      <Button key={`dec-task-${d.id}`} plain onPress={() => openPane($, d.task_id)} hover={lit(`dec-task-${d.id}`)}>
        <Text bold color={k(C.bright)}>{d.question}</Text>
      </Button>
      {orderedOptions(d).map((o, i) => (
        <Box flexDirection="column" key={`opt-${d.id}-${o.n}`}>
          <Button
            key={`pick-${d.id}-${o.n}`}
            plain
            hotkey={keys && i < 9 ? String(i + 1) : undefined}
            hover={lit(`pick-${d.id}-${o.n}`)}
            onPress={() =>
              void (d.multi
                ? update($, chosen, c => ({ ...c, [d.id]: toggle(c[d.id] ?? [], o.n) }))
                : send([o.n], '', `Answer sent: ${o.label}`))
            }
          >
            <Text color={k(o.recommended ? C.accent : C.text)} bold={o.recommended}>
              {d.multi ? (picked.includes(o.n) ? '[x] ' : '[ ] ') : ''}
              {keys ? '' : `${i + 1}. `}
              {o.label}
            </Text>
            {o.recommended ? <Text color={k(C.green)}> (Recommended)</Text> : ''}
            {o.desc ? <Text color={k(C.faint)}>  — {o.desc}</Text> : ''}
          </Button>
        </Box>
      ))}
      {d.multi ? (
        <Button key={`submit-${d.id}`} plain hotkey={keys ? 's' : undefined} onPress={() => void send(picked)}>
          <Text color={k(picked.length ? C.accent : C.faint)} bold>
            Submit {picked.length ? `${picked.length} chosen` : '(tick one or more first)'}
          </Text>
        </Button>
      ) : null}
      {field(
        el,
        `dec-text-${d.id}`,
        <Input
          key={`dec-text-${d.id}`}
          placeholder={d.multi ? 'Pick any, then Submit; or type something…' : 'Type something…'}
          submitLabel="answer"
          onInput={text => {
            if (d.multi) drafts[d.id] = text
            typing($, `dec-text-${d.id}`, text)
          }}
          onSubmit={text => {
            if (text.trim()) void send(picked, text)
          }}
        />,
      )}
    </Box>
  )
}

function toggle(list: number[], n: number): number[] {
  return list.includes(n) ? list.filter(x => x !== n) : [...list, n].sort((a, b) => a - b)
}

/** An answered decision, for a moment: the border turns green, the chosen answer lights up, the rest fall away. */
function settledBox(el: El, g: Ghost, r: Repo | undefined, now: number) {
  const { Box, Text } = el
  const q = at(`ans:${g.d.id}`, now, DUR.settle)
  const gone = mix(C.text, C.bg, 0.25 + 0.6 * q)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={k(mix(C.amber, C.green, q))} paddingX={1} key={`dec-${g.d.id}`}>
      <Text>
        <Text color={k(mix(C.amber, C.green, q))} bold>{g.d.id}</Text>
        {r ? <Text color={k(C.faint)}>  {r.display_name}</Text> : ''}
        <Text color={k(C.green)}>  · answered</Text>
      </Text>
      <Text bold color={k(mix(C.bright, C.muted, q))}>{g.d.question}</Text>
      {orderedOptions(g.d).map(o =>
        g.ns.includes(o.n) ? (
          <Text key={`settled-${g.d.id}-${o.n}`} color={k(mix(C.text, C.green, q))} bold>
            ✓ {o.label}
          </Text>
        ) : (
          <Text key={`settled-${g.d.id}-${o.n}`} color={k(gone)}>
            {'  '}
            {o.label}
          </Text>
        ),
      )}
      {g.text ? (
        <Text color={k(mix(C.text, C.green, q))} bold>
          ✓ “{g.text}”
        </Text>
      ) : null}
    </Box>
  )
}

// ---- one task ---------------------------------------------------------------------

function taskView($: $, el: El, t: Tick, d: Detail, v: View, rep: { path: string; text: string } | null, glyph: string | null, width: number, now: number) {
  const { Box, Text, Button, Input } = el
  const r = t.board.repos.find(x => x.repo === d.repo)
  const lead = r ? leadWords(r) : { text: '', color: C.faint }
  const files = d.links.filter(l => l.kind === 'report' || l.kind === 'file')
  const open = d.decisions.filter(x => x.state === 'open')
  const settling = [...ghosts.values()].filter(g => g.d.task_id === d.id && !open.some(x => x.id === g.d.id))
  const tabFade = moving('tab') ? 0.2 + 0.8 * at('tab', now) : 1
  const content = faded(tabFade, () => (
    <Box flexDirection="column">
      {v.tab === 'result' && evidenceBox($, el, d, v)}
      {v.tab === 'result' && resultTab($, el, d, rep, width)}
      {v.tab === 'conversation' && conversationTab($, el, d, now)}
      {v.tab === 'activity' && activityTab($, el, d)}
      {v.tab === 'files' && filesTab($, el, d)}
    </Box>
  ))
  const decisions = [
    ...settling.map(g => settledBox(el, g, r, now)),
    ...open.map((x, i) => decisionBox($, el, x, i === 0, r, now)),
  ]
  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Button key="back" plain hotkey="b" onPress={() => setView($, x => ({ ...x, task: null }))} hover={lit("back")}>
          <Text color={k(C.accent)}>‹ All tasks</Text>
        </Button>
        {closeButton($, el)}
      </Box>
      <Box justifyContent="space-between" marginTop={1}>
        <Text bold color={k(C.bright)}>
          <Text color={k(C.faint)}>{d.id}  </Text>
          {d.title}
        </Text>
        <Box flexShrink={0}>{chip(el, d.id, pill(d), now)}</Box>
      </Box>
      <Box>
        <Text>
          {dot(el, r)} <Text color={k(C.muted)}>{r?.display_name ?? d.repo}</Text>
          <Text color={k(C.soft)}>  │ </Text>
          <Text color={k(lead.color)}>{glyph ? `${glyph} ` : ''}{lead.text}</Text>
          <Text color={k(C.soft)}>  │ </Text>
          <Text color={k(C.faint)}>updated {ago(d.updated, now)}</Text>
        </Text>
        {leadStarter($, el, r)}
      </Box>
      <Box justifyContent="space-between">
        <Box flexShrink={1}>{bar(el, d, now, 20)}</Box>
        <Box flexShrink={0} marginLeft={2}>{closeControls($, el, d, v)}</Box>
      </Box>
      {crewBlock($, el, d, r)}
      {tabBar($, el, v, files.length, open.length, width, now)}
      {content}
      {v.tab !== 'conversation' && decisions.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {decisions}
        </Box>
      )}
      <Box marginTop={1} borderStyle="round" borderColor={k(C.soft)} paddingX={1} flexDirection="column">
        <Button key="compose-focus" plain hotkey="m" onPress={() => void $.ui.focus({ requestId: 'tasks', key: `compose-${d.id}-${v.composer}` })}>
          <Text color={k(C.accent)} bold>Message the lead</Text>
        </Button>
        {field(
          el,
          `compose-${d.id}-${v.composer}`,
          <Input
            key={`compose-${d.id}-${v.composer}`}
            placeholder={`Message the lead about ${d.id}…`}
            submitLabel="send"
            onInput={text => typing($, `compose-${d.id}-${v.composer}`, text)}
            onSubmit={text => {
              if (!text.trim()) return
              typing($, `compose-${d.id}-${v.composer}`, null)
              void setView($, x => ({ ...x, composer: x.composer + 1, tab: 'conversation' })).then(() =>
                act($, ['msg', d.id, text.trim()], `Sent to the ${d.repo} lead`),
              )
            }}
          />,
        )}
        <Text color={k(C.faint)}>
          {r?.lead.state === 'offline' ? `No lead running for ${d.repo}: it waits in the queue.` : `Goes to the ${d.repo} lead.`}
        </Text>
      </Box>
    </Box>
  )
}

const ENDS = {
  done: { label: '✓ Mark done', ask: 'Mark it done?', note: 'Marked done by the user on the board', said: 'marked done' },
  dropped: { label: 'Close task', ask: 'Close it?', note: 'Closed by the user on the board', said: 'closed' },
} as const

/** Ends a task once its "Sure?" got Yes (TAS-15); from the task's own view, back to the Overview after (TAS-27). */
function endTask($: $, id: string, what: 'done' | 'dropped', fromView: boolean): void {
  void update($, view, x => ({ ...x, confirm: null }))
    .then(() => act($, ['set', id, '--status', what, '--done', ENDS[what].note, '--by-user'], `${id} ${ENDS[what].said}`))
    .then(out => (fromView && out !== undefined ? backTo($, id) : undefined))
}

/** The user ends a task themselves (TAS-15): Mark done or Close, each asking "Sure? y / n" in place first; Reopen once ended. */
function closeControls($: $, el: El, d: Detail, v: View) {
  const { Box, Text, Button } = el
  const ask = v.confirm?.task === d.id ? v.confirm.what : null
  const end = (what: 'done' | 'dropped') => endTask($, d.id, what, true)
  if (d.closed) {
    return (
      <Button key="task-reopen" plain hover={lit('task-reopen')} onPress={() => void act($, ['set', d.id, '--status', 'running'], `${d.id} reopened`)}>
        <Text color={k(C.muted)}>Reopen</Text>
      </Button>
    )
  }
  if (ask) {
    return (
      <Box>
        <Text color={k(C.amber)}>{ENDS[ask].ask} </Text>
        <Button key="confirm-yes" plain hotkey={confirmNow ? undefined : 'y'} hover={lit('confirm-yes')} onPress={() => end(ask)}>
          <Text color={k(C.accent)} bold>Yes</Text>
        </Button>
        <Text color={k(C.faint)}> / </Text>
        <Button key="confirm-no" plain hotkey={confirmNow ? undefined : 'n'} hover={lit('confirm-no')} onPress={() => void update($, view, x => ({ ...x, confirm: null }))}>
          <Text color={k(C.muted)}>No</Text>
        </Button>
      </Box>
    )
  }
  return (
    <Box columnGap={3}>
      {(['done', 'dropped'] as const).map((what, i) => (
        <Button
          key={`task-${what === 'done' ? 'done' : 'close'}`}
          plain
          hover={lit(`task-${what}`)}
          onPress={() => void update($, view, x => ({ ...x, confirm: { task: d.id, what } }))}
        >
          <Text color={k(i ? C.muted : C.green)}>{ENDS[what].label}</Text>
        </Button>
      ))}
    </Box>
  )
}

/** The tabs, with a lit stretch of the rule under the active one that glides to a newly picked tab. */
function tabBar($: $, el: El, v: View, files: number, open: number, width: number, now: number) {
  const { Box, Text, Button } = el
  const labels = TABS.map(x => ({
    ...x,
    text: `${x.label}${x.tab === 'files' && files ? ` · ${files}` : ''}${x.tab === 'conversation' && open ? ` · ${open} open` : ''}`,
  }))
  // where each tab sits on the line: "r: Result   c: Conversation   …" (the terminal prints the hotkey before it)
  let x = 0
  const spans = labels.map(l => {
    const s = { x, w: l.hotkey.length + 2 + l.text.length }
    x += s.w + 3
    return s
  })
  const i = Math.max(0, TABS.findIndex(y => y.tab === v.tab))
  const j = TABS.findIndex(y => y.tab === fromOf<Tab>('tab'))
  const q = at('tab', now)
  const a = spans[j >= 0 && moving('tab') ? j : i]!
  const b = spans[i]!
  const sx = Math.round(a.x + (b.x - a.x) * q)
  const sw = Math.max(1, Math.round(a.w + (b.w - a.w) * q))
  const line = Math.max(10, width - 2)
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        {labels.map(l => (
          <Button key={`tab-${l.tab}`} plain hotkey={l.hotkey} onPress={() => setView($, y => ({ ...y, tab: l.tab }))} hover={lit(`tab-${l.tab}`)}>
            <Text color={k(v.tab === l.tab ? C.accent : C.muted)} bold={v.tab === l.tab}>
              {l.text}
            </Text>
            <Text>{'   '}</Text>
          </Button>
        ))}
      </Box>
      <Text>
        <Text color={k(C.soft)}>{'─'.repeat(Math.min(sx, line))}</Text>
        <Text color={k(C.accent)}>{'━'.repeat(Math.max(0, Math.min(sw, line - sx)))}</Text>
        <Text color={k(C.soft)}>{'─'.repeat(Math.max(0, line - sx - sw))}</Text>
      </Text>
    </Box>
  )
}

/** An empty state that reads as intended: a soft mark, what this place is for, and what fills it. */
function empty(el: El, mark: string, title: string, hint: string) {
  const { Box, Text } = el
  return (
    <Box flexDirection="column" paddingY={1} paddingLeft={2}>
      <Text>
        <Text color={k(C.faint)}>{mark}  </Text>
        <Text color={k(C.muted)}>{title}</Text>
      </Text>
      <Text color={k(C.faint)}>{'   '}{hint}</Text>
    </Box>
  )
}

function resultTab($: $, el: El, d: Detail, rep: { path: string; text: string } | null, width: number) {
  const { Box, Text, Button, Markdown } = el
  if (!d.report || rep?.path !== d.report) {
    return (
      <Box flexDirection="column">
        {empty(el, '◌', 'No report yet', 'When the lead links a report it shows here, ready to read.')}
        {d.done ? <Text color={k(C.text)}>Latest: {d.done}</Text> : null}
        {d.next ? <Text color={k(C.muted)}>Next: {d.next}</Text> : null}
        {d.why ? <Text color={k(C.faint)}>Why: {d.why}</Text> : null}
      </Box>
    )
  }
  const press = (link: { href: string }) => void openLink($, d.id, link.href)
  // TAS-13: the short version first, the report's own `In short` or else the lead's done line; the full report below it
  const sec = inShort(rep.text)
  let mds = 0 // the first Markdown keeps the key `report`
  return (
    <Box flexDirection="column">
      {sec?.short || d.done ? (
        <Box key="in-short" flexDirection="column" borderStyle="round" borderColor={k(C.soft)} paddingX={1} marginBottom={1}>
          <Text bold color={k(C.accent)}>{caps('In short')}</Text>
          {sec?.short ? <Markdown key="report-short" text={sec.short} onLinkPress={press} /> : <Text color={k(C.text)}>{d.done}</Text>}
        </Box>
      ) : null}
      <Box>
        <Button key="report-open" plain hotkey="o" onPress={() => void openFile($, d.id, rep.path)} hover={lit("report-open")}>
          <Text color={k(C.accent)}>Open report ↗</Text>
        </Button>
        <Text>{'   '}</Text>
        <Button key="report-reveal" plain onPress={() => void openFile($, d.id, rep.path, true)} hover={lit("report-reveal")}>
          <Text color={k(C.muted)}>Show in Finder</Text>
        </Button>
        <Text color={k(C.faint)}>   {rep.path.split('/').pop()}</Text>
      </Box>
      {layTables(sec ? sec.rest : rep.text, width - 2).map((p, i) =>
        'md' in p ? (
          <Markdown key={mds++ ? `report-${i}` : 'report'} text={p.md} onLinkPress={press} />
        ) : (
          <Box key={`table-${i}`} flexDirection="column" marginY={1}>
            {p.lines.map((l, j) => (
              <Text key={`table-${i}-${j}`}>
                {l.length ? l.map(s => <Text color={k(s.rule ? C.soft : C.text)} bold={s.bold}>{s.text}</Text>) : ' '}
              </Text>
            ))}
          </Box>
        ),
      )}
    </Box>
  )
}

/** A search hit opened here: the stored text that matched and where it is, with its own report to open if it was one. */
function evidenceBox($: $, el: El, d: Detail, v: View) {
  const { Box, Text, Button } = el
  const ev = v.evidence
  if (!ev || ev.task !== d.id) return null
  return (
    <Box key="evidence" flexDirection="column" borderStyle="round" borderColor={k(C.soft)} paddingX={1} marginBottom={1}>
      <Text color={k(C.faint)}>Found by your search · {ev.label}</Text>
      <Text color={k(C.text)}>{ev.text}</Text>
      {ev.path ? (
        <Button key="evidence-open" plain onPress={() => void openFile($, d.id, ev.path!)} hover={lit('evidence-open')}>
          <Text color={k(C.accent)}>Open this report ↗</Text>
        </Button>
      ) : null}
    </Box>
  )
}

async function openLink($: $, task: string, href: string): Promise<void> {
  if (href.startsWith('file://')) return openFile($, task, pathOf(href))
  if (/^https?:\/\//.test(href)) await $.process.run(['open', href])
}

function conversationTab($: $, el: El, d: Detail, now: number) {
  const { Box, Text, Button } = el
  const open = d.decisions.filter(x => x.state === 'open')
  const settling = [...ghosts.values()].filter(g => g.d.task_id === d.id && !open.some(x => x.id === g.d.id))
  if (!d.messages.length && !open.length && !settling.length) {
    return empty(el, '✉', 'No messages yet', 'Write to the lead below; its replies land here.')
  }
  return (
    <Box flexDirection="column">
      {earlier($, el, d, 'messages', d.messages.length, d.messages_total)}
      {d.messages.map(m => {
        const mine = m.author === 'user'
        const fresh = at(`new:m${m.id}`, now)
        return (
          <Box marginBottom={1} key={`m-${m.id}`}>
            {gutter(el, `new:m${m.id}`, now)}
            <Box flexDirection="column" paddingLeft={mine ? 3 : 0}>
              <Text color={k(C.faint)}>
                <Text color={k(mine ? C.accent : C.blue)} bold>{mine ? 'You' : 'Lead'}</Text> · {clock(m.ts)}
                {m.kind === 'new_task' ? ' · new task' : m.kind === 'answer' ? ' · answer' : ''}
              </Text>
              <Text color={k(mix(C.bright, C.text, fresh))}>{m.text}</Text>
              {mine ? (
                <Box>
                  <Text color={k(m.state_note || m.state === 'failed' ? C.amber : m.state === 'replied' ? C.green : C.faint)}>
                    {MESSAGE_STATE[m.state] ?? m.state}
                    {m.state_note ? ` · ${m.state_note}` : ''}
                  </Text>
                  {canResend(m.state, m.sent_at ?? m.ts, now) ? (
                    <Button key={`resend-${m.id}`} plain onPress={() => void act($, ['resend', `m${m.id}`], `m${m.id} is back in the queue`)}>
                      <Text color={k(C.accent)}>   Resend</Text>
                    </Button>
                  ) : null}
                </Box>
              ) : null}
            </Box>
          </Box>
        )
      })}
      {settling.map(g => settledBox(el, g, undefined, now))}
      {open.map((x, i) => decisionBox($, el, x, i === 0, undefined, now))}
    </Box>
  )
}

function activityTab($: $, el: El, d: Detail) {
  const { Box, Text } = el
  if (!d.events.length) return empty(el, '·', 'Nothing has happened yet', 'Steps, answers and results are logged here as they come.')
  return (
    <Box flexDirection="column">
      {d.events.map((x, i) => (
        <Text key={`ev-${x.id ?? i}`} wrap="truncate-end">
          <Text color={k(C.faint)}>{clock(x.ts).padStart(8)}  </Text>
          <Text color={k(x.kind === 'result' ? C.green : x.kind === 'asked' ? C.amber : C.muted)}>{x.kind.padEnd(9)}</Text>
          <Text color={k(C.text)}> {x.text}</Text>
        </Text>
      ))}
      {earlier($, el, d, 'events', d.events.length, d.events_total)}
    </Box>
  )
}

/** "Show earlier": the store sends a page of a long history; this asks for the next one. */
function earlier($: $, el: El, d: Detail, what: string, shown: number, total = shown) {
  const { Button, Text } = el
  if (total <= shown) return null
  return (
    <Button key={`earlier-${what}`} plain onPress={() => void showEarlier($, d.id, shown)} hover={lit(`earlier-${what}`)}>
      <Text color={k(C.accent)}>{what === 'messages' ? '↑ Show earlier messages' : '↓ Show older activity'}</Text>
      <Text color={k(C.faint)}> ({total - shown} more)</Text>
    </Button>
  )
}

function filesTab($: $, el: El, d: Detail) {
  const { Box, Text, Button } = el
  if (!d.links.length) return empty(el, '▢', 'No files or links yet', 'Reports, files and PRs the lead links show up here.')
  return (
    <Box flexDirection="column">
      {d.links.map((l, i) =>
        l.kind === 'report' || l.kind === 'file' ? (
          <Box key={`file-${i}`}>
            <Button key={`file-open-${i}`} plain onPress={() => void openFile($, d.id, l.ref)} hover={lit(`file-open-${i}`)}>
              <Text color={k(l.kind === 'report' ? C.green : C.muted)}>{l.kind === 'report' ? '▤ report ' : '▢ file   '}</Text>
              <Text color={k(C.accent)}>{l.ref.split('/').pop()}</Text>
            </Button>
            <Text>  </Text>
            <Button key={`file-reveal-${i}`} plain onPress={() => void openFile($, d.id, l.ref, true)} hover={lit(`file-reveal-${i}`)}>
              <Text color={k(C.faint)}>Show in Finder</Text>
            </Button>
            <Text color={k(C.faint)} wrap="truncate-middle">  {l.ref}</Text>
          </Box>
        ) : (
          <Text key={`link-${i}`}>
            <Text color={k(C.muted)}>{l.kind.padEnd(9)}</Text>
            <Text color={k(C.text)}>{l.ref}</Text>
            {l.label ? <Text color={k(C.faint)}> {l.label}</Text> : ''}
          </Text>
        ),
      )}
    </Box>
  )
}

// ---- strip above the prompt ---------------------------------------------------------

export async function band($: $, e: RenderInput<'AbovePrompt'>): Promise<RenderElement | null> {
  if (e.props.hasSurvey) return null
  const el = elements($, e)
  const [t, th] = await Promise.all([read($, tick), read($, theme)])
  if (!el || !t) return null
  useTheme(th)
  const need = needsYou(t).count
  const ready = t.board.tasks.filter(x => x.has_result && !x.closed && !x.needs_you)
  if (!need && !ready.length) return null
  const { Box, Text, Button } = el
  return (
    <Box>
      <Text color={C.text} bold>Tasks</Text>
      {need ? <Text color={C.amber}> · {need} need you</Text> : ''}
      {ready.slice(0, 2).map(x => (
        <Text key={`ready-${x.id}`} color={C.green}> · {x.id} result ready</Text>
      ))}
      <Text color={C.faint}> · </Text>
      <Button key="open-tasks" plain onPress={() => openPane($)}>
        <Text color={C.accent}>/board</Text>
      </Button>
    </Box>
  )
}
