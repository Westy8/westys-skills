import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Detail, Hit, Message, Tab, Tick, View } from '../types'
import { DUR, holds, idsIn, landing, linkPaths, PAGE, pill, ready, SEARCH, shownOf, titleOf, VIEW } from './logic'
import { refreshLive } from './live'
import { ghosts, paneOpened, settle, start, syncSpinner } from './motion'

export const PANE = 'tasks'

const tick = atom({ plugin: 'crew-board', key: 'tick' } as const, null)
const view = atom({ plugin: 'crew-board', key: 'view' } as const, VIEW)
const report = atom({ plugin: 'crew-board', key: 'report' } as const, null)
const working = atom({ plugin: 'crew-board', key: 'working' } as const, false)
const frame = atom({ plugin: 'crew-board', key: 'frame' } as const, 0)
const boardTask = atom({ plugin: 'crew-board', key: 'boardTask' } as const, null)
const turns = atom({ plugin: 'crew-board', key: 'turns' } as const, [] as string[])
const seen = atom({ plugin: 'crew-board', key: 'seen' } as const, null as string[] | null)
const notice = atom({ plugin: 'crew-board', key: 'notice' } as const, '')
const error = atom({ plugin: 'crew-board', key: 'error' } as const, '')
const token = atom({ plugin: 'crew-board', key: 'token' } as const, '')
const sent = atom({ plugin: 'crew-board', key: 'sent' } as const, [] as number[])
const search = atom({ plugin: 'crew-board', key: 'search' } as const, SEARCH)
const confirming = atom({ plugin: 'crew-board', key: 'confirming' } as const, null)

type $ = EngineInterface

/** Runs the store CLI. TASKS_CLI overrides; by default the tasks.py that ships inside this mod (same version). */
export async function tasks($: $, args: string[], stdin?: string): Promise<string> {
  const cli = (await $.env.get('TASKS_CLI')) || `${$.plugin.root}/tasks.py`
  const r = await $.process.run(['python3', cli, ...args], stdin === undefined ? {} : { stdin })
  if (r.exitCode !== 0) throw new Error((r.stderr || r.stdout).trim().split('\n').pop() || `tasks ${args[0]} failed`)
  return r.stdout.trim()
}

let polling: Promise<void> | null = null

/** A poll that reads the view as it is now: one already running read the old one, so this one follows it. */
export function freshPoll($: $): Promise<void> {
  return (polling ?? Promise.resolve()).then(() => poll($))
}
let retired = '' // the session id of the conversation that last ended in this process: none of its polls may publish or submit

/**
 * /clear or an in-process /resume ended `ended`: retire it at once, then let a running poll finish (what it claimed
 * but didn't submit gets Resend). Only that conversation: its end can arrive after the next one has started polling.
 */
export async function cleared($: $, ended: string): Promise<void> {
  retired = ended
  await forget($) // first: the host gives the end handler 1.5 s, and a poll can wait longer on the store
  await polling
}

/** The next conversation's Bash commands must not inherit this one's identity. */
async function forget($: $): Promise<void> {
  await $.env.set('CREW_BOARD_SESSION', undefined)
  await $.env.set('CREW_BOARD_TOKEN', undefined)
}

/** A token (made for one session, see myToken) whose conversation has ended. */
const stale = (tok: string) => retired !== '' && tok.startsWith(`${retired}/`)
/** This poll's conversation is no longer the one in this process: switched (its end maybe not heard yet), or ended. */
async function gone($: $, tok: string, session: string): Promise<boolean> {
  const now = await $.session.id()
  return now !== session || stale(tok) // read after the await: an end heard meanwhile counts
}

/** The tick, if it says this conversation is the lead (a tick from before a /clear or /resume is not this conversation's). */
export async function leadTick($: $): Promise<Tick | null> {
  const [t, tok, now] = await Promise.all([read($, tick), read($, token), $.session.id()])
  // ...and only for the conversation in this process now: not one that ended, or that a resume switched away from
  return t?.me.is_lead && t.me.token === tok && tok.startsWith(`${now}/`) && !stale(tok) ? t : null
}
let claude: Promise<string> | undefined // the Claude process: what the store checks to tell a closed sender from a busy one

/**
 * This conversation's token in this process, made on first use. It names the session it was made for, so it never
 * travels with another conversation's id (an in-process /resume can switch the id before the mod hears of it).
 */
async function myToken($: $, session: string): Promise<string> {
  const t = await read($, token)
  if (t.startsWith(`${session}/`)) return t
  const made = `${session}/${Math.random().toString(36).slice(2)}${(await $.clock.now()).toString(36)}`
  await update($, token, () => made)
  return made
}

/** One poll: the board for the pane, and in the lead's session, this repo's queued messages submitted as prompts. */
export function poll($: $): Promise<void> {
  if (!polling) polling = pollOnce($).finally(() => (polling = null)) // ponytail: one at a time; a slow store skips a beat
  return polling
}

async function pollOnce($: $): Promise<void> {
  try {
    const v = await read($, view)
    claude ??= $.process.run(['sh', '-c', 'echo $PPID']).then(r => r.stdout.trim()) // measured: $.process.run's parent is Claude
    const session = await $.session.id()
    if (session === retired) return // ended, the next conversation not here yet
    const [cwd, terminal, busy, tok, pid] = await Promise.all([
      $.session.cwd(),
      $.env.get('ORCA_TERMINAL_HANDLE'),
      read($, working),
      myToken($, session),
      claude,
    ])
    if (stale(tok)) return
    // Who this conversation is, for a `tasks lead` it runs (Bash commands inherit Claude's environment).
    await $.env.set('CREW_BOARD_SESSION', session)
    await $.env.set('CREW_BOARD_TOKEN', tok)
    if (stale(tok)) return forget($) // its end came in while these writes were under way
    const args = ['mod-tick', '--cwd', cwd, '--session', session, '--terminal', terminal ?? '', '--token', tok, '--state', busy ? 'working' : 'idle']
    if (/^\d+$/.test(pid)) args.push('--pid', pid)
    // The board's view while it is open, '' closed: a lead's is what its successor reopens after a relay.
    const pane = (await $.ui.panes().catch(() => [])).find(p => p.id === PANE)
    args.push('--board', pane ? JSON.stringify({ task: v.task ?? null, tab: v.tab ?? 'result' }) : '')
    // The user sees a task's result only on a drawn pane (not a tab behind another, nor one opened unasked and undrawn)
    if (pane?.isShown && pane.isPlaced !== false && v.task && (v.tab ?? 'result') === 'result') args.push('--seen', v.task)
    // ...and a just-finished task once the Overview drew it in its place (TAS-21): the tick before this one is what it drew
    if (pane?.isShown && pane.isPlaced !== false && !v.task && !v.picking && !(await read($, search)).q) { // the repo list covers rows
      for (const x of (await read($, tick))?.board.tasks ?? []) if (x.just_done) args.push('--seen-done', x.id)
    }
    const reach = v.task && v.more?.task === v.task ? v.more : null // a search hit's evidence: history back to it
    if (v.task) args.push('--open', v.task, '--more', String(shownOf({ ...VIEW, ...v })))
    if (reach?.m) args.push('--from-message', String(reach.m))
    if (reach?.e) args.push('--from-event', String(reach.e))
    const t = JSON.parse(await tasks($, args)) as Tick
    if (await gone($, tok, session)) return void (await Promise.all(t.claimed.map(m => unsent($, m))))
    const prev = await read($, tick)
    if (stale(tok)) return void (await Promise.all(t.claimed.map(m => unsent($, m)))) // ended during that read
    await update($, tick, () => ({ ...t, me: { ...t.me, token: tok } }))
    await reveal($)
    try {
      arrivals($, prev, t)
      refreshLive($, t) // agents' and PRs' live state: started here, never awaited
      if (prev?.me.is_lead !== t.me.is_lead) void syncSpinner($).catch(() => undefined) // a takeover mid-turn
    } catch {
      // decoration: it never stops delivery
    }
    await update($, error, () => '')
    if (t.me.is_lead && t.me.reopen) await reopen($, t.me.reopen).catch(() => undefined) // never stops delivery
    for (const m of t.claimed) await deliver($, m, tok, session)
    await loadReport($, t.task ?? null)
    await reveal($)
    await announce($, t)
  } catch (err) {
    await update($, error, () => String((err as Error).message ?? err)).catch(() => undefined) // the module may be unloading
  }
}

/**
 * Lead only: The user's message enters this session as their own typed prompt. The submit is queued at once and
 * resolves only when its turn starts (minutes on a busy lead), so it is not awaited here; a refusal marks
 * the message failed with Claude's reason, and the user gets a Resend button. The failed write waits for this
 * attempt's accepted write, so a Resend can never be undone by a late 'accepted'.
 */
async function deliver($: $, m: Message, tok: string, session: string): Promise<void> {
  if (!m.envelope) return
  // Remembered until its turn starts (or it is refused), so this conversation acknowledges it even after a takeover.
  await update($, sent, ids => [...ids, m.id])
  if (await gone($, tok, session)) return unsent($, m) // /clear or /resume came in between: never into the next conversation
  const submitted = $.prompt.submit({ text: m.envelope, asUser: true })
  const accepted = tasks($, ['mark', `m${m.id}`, '--state', 'accepted'])
  const failed = (why: string) =>
    accepted
      .catch(() => undefined)
      .then(() => tasks($, ['mark', `m${m.id}`, '--state', 'failed', '--note', why]))
      .then(() => update($, sent, ids => ids.filter(x => x !== m.id)))
      .catch(() => undefined)
  void submitted.then(
    r => (r.drop !== undefined ? failed(`Claude didn't take it: ${r.drop}`) : undefined),
    err => failed(`Couldn't send it: ${(err as Error).message ?? err}`),
  )
  await accepted
}

/** A relay: this conversation took over as lead, and the former lead had its board open: open it here, at the same view. */
async function reopen($: $, saved: string): Promise<void> {
  let was: { task?: string | null; tab?: Tab } = {}
  try {
    was = JSON.parse(saved) as typeof was
  } catch {
    // an unreadable view: the overview
  }
  await setView($, v => ({ ...v, task: was.task ?? null, tab: was.tab ?? 'result' }))
  const r = await $.ui.open({ id: PANE, title: 'Tasks', rows: 40 }) // no focus: the prompt keeps the keyboard
  await paneOpened($)
  // Opened unasked, a narrow terminal leaves it waiting undrawn (the host's floor): say so, and how to see it now.
  $.ui.toast(r.isPlaced ? 'Tasks board reopened: this session took over as lead'
    : 'This session took over as lead. The Tasks board is open but waiting for a wider window: widen it, or type /board')
}

/** A claimed message the conversation that claimed it never submitted (it was cleared or switched first): The user can Resend it. */
async function unsent($: $, m: Message): Promise<void> {
  await tasks($, ['mark', `m${m.id}`, '--state', 'failed', '--note', "Not sent: the lead's conversation was cleared or switched before it went out. Resend to send it again."]).catch(() => undefined)
}

async function loadReport($: $, t: Detail | null): Promise<void> {
  const path = t?.report ?? null
  if (!path) return void (await update($, report, () => null))
  const raw = await $.fs.read(path).catch(() => `_Can't read ${path}._`)
  const text = linkPaths(raw, path, (await $.env.get('HOME')) ?? '') // its paths and file links, ready to press
  await update($, report, r => (r?.path === path && r.text === text ? r : { path, text }))
}

/** A toast when a new decision or a new result lands (not for what was already there when the pane started). */
async function announce($: $, t: Tick): Promise<void> {
  const keys = [
    ...t.board.decisions.map(d => `d:${d.id}`),
    ...t.board.tasks.filter(x => x.has_result && !x.closed).map(x => `r:${x.id}`),
  ]
  const before = await read($, seen)
  await update($, seen, () => keys)
  if (!before) return // first poll of the session: what's already there is not news
  for (const k of keys.filter(k => !before.includes(k)).slice(0, 3)) {
    const id = k.slice(2)
    if (k.startsWith('d:')) $.ui.toast(`Tasks · ${id} needs you: ${t.board.decisions.find(x => x.id === id)?.question ?? ''}`)
    else $.ui.toast(`Tasks · ${id} result ready: ${t.board.tasks.find(x => x.id === id)?.title ?? ''}`)
  }
}

/** What changed since the last poll, by value: each change starts its one-shot transition. The first poll is not news. */
function arrivals($: $, prev: Tick | null, t: Tick): void {
  if (!prev) return
  const was = new Map(prev.board.tasks.map(x => [x.id, x]))
  for (const x of t.board.tasks) {
    const p = was.get(x.id)
    if (!p || (x.has_result && !p.has_result) || x.closed !== p.closed) start($, `new:${x.id}`, DUR.fresh)
    if (!p) continue
    const [a, b] = [pill(p), pill(x)]
    if (a.label !== b.label) start($, `pill:${x.id}`, DUR.pill, a)
    const f = (c: { steps_done: number; steps_total: number }) => (c.steps_total ? c.steps_done / c.steps_total : 0)
    if (f(p) !== f(x)) start($, `bar:${x.id}`, DUR.bar, f(p))
  }
  const asked = new Set(prev.board.decisions.map(d => d.id))
  for (const d of t.board.decisions) if (!asked.has(d.id)) start($, `new:${d.id}`, DUR.fresh)
  const still = new Set(t.board.decisions.map(d => d.id))
  for (const d of prev.board.decisions) if (!still.has(d.id) && !ghosts.has(d.id)) settle($, d, []) // answered elsewhere: fade it out
  if (prev.task && t.task && prev.task.id === t.task.id) {
    const had = new Set(prev.task.messages.map(m => m.id))
    for (const m of t.task.messages) if (!had.has(m.id)) start($, `new:m${m.id}`, DUR.fresh)
  }
}

/** Shows a page more of the open task's history (Show earlier): the next poll, at once, brings it. */
export async function showEarlier($: $, task: string, now: number): Promise<void> {
  await update($, view, v => ({ ...VIEW, ...v, more: { ...(v.more?.task === task ? v.more : {}), task, n: now + PAGE } }))
  void freshPoll($)
}

/**
 * Every view change goes through here, so each one gets its transition. Overview ↔ task has none (The user: it skipped
 * and resized); the task view shows once its own detail has arrived, with the overview held until then.
 */
export async function setView($: $, fn: (v: View) => View): Promise<void> {
  const a = { ...VIEW, ...(await read($, view)) }
  await update($, view, fn)
  let b = { ...VIEW, ...(await read($, view)) }
  if (b.evidence && b.evidence.task !== b.task) b = { ...VIEW, ...(await update($, view, v => ({ ...v, evidence: null }))) } // another task: not its evidence
  if (a.task !== b.task) {
    opening = b.task ?? ''
    if (b.task) void (reveal($), freshPoll($)) // a cached detail draws at once; the poll brings a fresh one
    else if (back) void toRow($, back) // back from ending a task: at where it went (TAS-27, TAS-28)
    else top($) // back: the overview from its top
  }
  else if (a.tab !== b.tab) start($, 'tab', DUR.tab, a.tab)
  const [ad, bd] = [a.openDone ?? [], b.openDone ?? []]
  for (const r of new Set([...ad, ...bd])) if (ad.includes(r) !== bd.includes(r)) start($, `done:${r}`, DUR.reveal)
}

let back = '' // the Overview row the next return lands on, instead of the top

/**
 * Ends a task's view and goes back to the Overview at its repo's Completed line, where the user's own end put it (TAS-28),
 * or at its search hit while a search is up (TAS-27).
 */
export async function backTo($: $, id: string): Promise<void> {
  const repo = (await read($, tick))?.board.tasks.find(x => x.id === id)?.repo
  back = (await read($, search))?.q ? `hit-${id}` : repo ? `done-${repo}` : `task-${id}`
  await setView($, x => ({ ...x, task: null }))
}

async function toRow($: $, key: string): Promise<void> {
  back = ''
  if (!(await scrollTo($, key, 'center'))) top($)
}

/** The row comes with the redraw that brings it, a moment after: try until it is drawn (about a second at most). */
async function scrollTo($: $, key: string, block: 'start' | 'center'): Promise<boolean> {
  for (let i = 0; i < 20; i++) {
    const r = await $.ui.scroll({ in: PANE, to: { key }, block }).catch(() => ({ deny: 'failed' }))
    if (!('deny' in r && r.deny)) return true
    if (!(await $.clock.sleep(50).then(() => true, () => false))) return true // unloaded meanwhile (a reload): nothing to scroll
  }
  return false
}

let opening = '' // the task view on its way in: scrolled to its top once, when it can first draw
let land: { task: string; key: string } | null = null // ...or to a search hit's evidence, when that task is the one opening

/** Scrolls an opening task view to its top as soon as the pane can draw it (its detail, and its report, are in). */
async function reveal($: $): Promise<void> {
  if (!opening) return
  const [t, rep] = await Promise.all([read($, tick), read($, report)])
  if (!opening || t?.task?.id !== opening || !ready(t.task, rep)) return
  const to = land?.task === t.task.id ? land.key : null
  if (to && !holds(t.task, to)) return // a cached detail from before: the poll bringing the hit's history comes next
  opening = ''
  land = null
  if (!to || !(await scrollTo($, to, 'start'))) top($)
}

/** The pane's window to its top, in the same moment as the view it belongs to. */
function top($: $): void {
  void $.ui.scroll({ in: PANE, to: 'start' }).catch(() => undefined)
}

// ---- search: the Overview's search box --------------------------------------------------

let asked = 0 // the latest search: an older one's answer arrives late and is dropped
const meant = new Map<string, string[]>() // query and the records it was asked over -> the IDs the model matched
type Found = { hits: Hit[]; records: { id: string; text: string; excerpt: string }[] }

const MEANING =
  'You find tasks for the person who wrote the request. Each line below is one task: its ID first, then what is stored ' +
  'about it. Reply with the IDs of the tasks the request is clearly about, best first, one per line, at most 8. Judge by ' +
  'meaning, not shared words: a paraphrase or a synonym counts. If no task clearly fits, reply NONE. Reply with nothing else.'
const CHUNK = 60_000 // characters of task records per model call: a bigger store takes more calls, never fewer tasks

/**
 * Searches every task: the store's word search at once, then (unless the query names a task) a model reads one compact
 * record per task and picks the ones the query means, so a paraphrase with no word in common still finds its task.
 * Read-only: nothing is sent to a lead. An empty query (or `clear`) goes back to the ordinary overview.
 */
export async function find($: $, text: string, clear = false): Promise<void> {
  const q = text.trim()
  const seq = ++asked
  if (!q) return void (await update($, search, s => ({ ...SEARCH, box: s.box + (clear ? 1 : 0) })))
  let r: Found
  try {
    r = JSON.parse(await tasks($, ['search', q, '--json'])) as Found
  } catch (err) {
    return void (await update($, notice, () => `Couldn't search: ${(err as Error).message}`))
  }
  if (seq !== asked) return
  const hits = (ids: string[]): Hit[] =>
    ids.map(id => r.hits.find(h => h.id === id) ?? {
      id, exact: false, excerpt: r.records.find(x => x.id === id)?.excerpt ?? '', where: { kind: 'field', ref: 'summary', pos: null, ts: null },
    })
  const key = `${q}\n${r.records.map(x => x.text).join('\n')}` // a task filed or changed since: asked again
  const cached = meant.get(key)
  const named = r.hits.some(h => h.exact) // it names a task: no model needed
  await update($, search, s => ({ q, box: s.box, words: r.hits, meaning: hits(cached ?? []), state: named || cached ? ('done' as const) : ('thinking' as const) }))
  if (named || cached) return
  const ids = await byMeaning($, q, r.records).catch(() => null)
  if (seq !== asked) return // a newer search, or a clear, came first
  if (ids) meant.set(key, ids)
  await update($, search, s => ({ ...s, meaning: hits(ids ?? []), state: ids ? ('done' as const) : ('unavailable' as const) }))
}

async function byMeaning($: $, q: string, records: Found['records']): Promise<string[]> {
  const chunks: string[] = []
  for (const x of records) {
    const line = x.text.replace(/\s+/g, ' ')
    if (chunks.length && chunks[chunks.length - 1]!.length + line.length < CHUNK) chunks[chunks.length - 1] += `\n${line}`
    else chunks.push(line)
  }
  // ponytail: several chunks answer in chunk order (each ranked within itself); one call holds ~250 tasks
  const replies = await Promise.all(
    chunks.map(c => $.model.complete({ model: 'haiku', system: MEANING, prompt: `Request: ${q}\n\nTasks:\n${c}`, maxTokens: 200, timeoutMs: 20_000 })),
  )
  if (!replies.length || replies.some(x => !x.isAnswered)) throw new Error('meaning search unavailable')
  return idsIn(replies.map(x => (x.isAnswered ? x.text : '')).join('\n'), new Set(records.map(x => x.id)))
}

/** Opens a hit at its evidence: the message (its page of history loaded), the activity line, or the result. */
export async function openHit($: $, h: Hit): Promise<void> {
  const { key, ...l } = landing(h)
  land = key ? { task: h.id, key } : null
  await setView($, v => ({ ...v, task: h.id, ...l }))
}

export async function openPane($: $, task?: string): Promise<void> {
  if (task) await setView($, v => ({ ...v, task: task.toUpperCase(), tab: 'result' as const }))
  await $.ui.open({ id: PANE, title: 'Tasks', focus: true, rows: 40 })
  await paneOpened($)
  void freshPoll($)
}

/** Every write the pane makes goes through here: run it, say what happened, poll at once. */
export async function act($: $, args: string[], done: string): Promise<string | undefined> {
  try {
    const out = await tasks($, args)
    await update($, notice, () => done)
    await poll($)
    return out
  } catch (err) {
    await update($, notice, () => `Couldn't do that: ${(err as Error).message}`)
    return undefined
  }
}

export async function newTask($: $, repo: string, text: string): Promise<void> {
  const id = await act($, ['new', titleOf(text), '--repo', repo, '--status', 'proposed', '--origin', 'user'], 'Task created')
  if (!id) return
  if ((await act($, ['msg', id, text, '--kind', 'new_task'], `Sent to the ${repo} lead as ${id}`)) === undefined) return // its notice says why
  await update($, view, v => ({ ...v, added: { repo, id } })) // the user stays where they were (TAS-20): a line there says it went
}

/**
 * Start a lead for a repo with none up (TAS-1); `resume` brings back its last conversation. It only arms the one
 * confirm, because a lead costs money: the board's leadStarter (ui.tsx) draws it in place, and its yes calls launchLead.
 */
export async function startLead($: $, repo: string, resume = false, anyway = false): Promise<void> {
  await update($, confirming, () => ({ repo, resume, anyway }))
}

/** The user's y or n to the armed start. y: the store opens the lead's Orca terminal (never twice: `tasks start-lead`). */
export async function launchLead($: $, yes: boolean): Promise<void> {
  const c = await read($, confirming)
  await update($, confirming, () => null)
  if (!c || !yes) return
  await act($, ['start-lead', c.repo, ...(c.resume ? ['--resume'] : []), ...(c.anyway ? ['--anyway'] : [])], `${c.resume ? 'Bringing back' : 'Starting'} the ${c.repo} lead: it picks up the waiting messages once it's up`)
}

/** Opens a file with the Mac's default app, or shows it in Finder; logged on the task. */
export async function openFile($: $, task: string | null, path: string, reveal = false): Promise<void> {
  const r = await $.process.run(reveal ? ['open', '-R', path] : ['open', path])
  await update($, notice, () => (r.exitCode === 0 ? `${reveal ? 'Shown in Finder' : 'Opened'}: ${path}` : `Couldn't open ${path}`))
  const how = `${reveal ? 'open -R' : 'open'} ${path} (from the Tasks pane${r.exitCode === 0 ? '' : `, failed: exit ${r.exitCode}`})`
  if (task) await tasks($, ['note', task, how]).catch(() => undefined)
}

