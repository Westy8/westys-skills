// The pane's motion: one-shot tweens and the one looping glyph. A frame clock runs only while a tween is
// live (it stops itself after the last one ends) and the glyph only while the lead works with the pane open,
// so a resting board runs no timer but the 3 s store poll. CREW_BOARD_MOTION=off draws every end state at once.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Timer } from 'claude-code'

import type { Decision } from '../types'
import type { Tween } from './logic'
import { DUR, progress } from './logic'

type $ = EngineInterface

const anim = atom({ plugin: 'crew-board', key: 'anim' } as const, 0)
const working = atom({ plugin: 'crew-board', key: 'working' } as const, false)
const frame = atom({ plugin: 'crew-board', key: 'frame' } as const, 0)
const tick = atom({ plugin: 'crew-board', key: 'tick' } as const, null)

// Module state: a hot reload starts it over, which just ends whatever was moving.
const tweens = new Map<string, Tween>()
let ticker: Timer | null = null
let spinner: Timer | null = null
let enabled = true
let paneOpen = false
let syncs = 0 // spinner syncs started; only the latest one acts

/** An answered decision still drawn while its buttons settle into the answer (the store has already dropped it). */
export type Ghost = { d: Decision; ns: number[]; text: string } // every chosen option (none: answered elsewhere)
export const ghosts = new Map<string, Ghost>()

/** session.start: reads the setting, finds a pane that outlived a reload, and resumes the glyph if the lead is mid-turn. */
export async function initMotion($: $): Promise<void> {
  enabled = ((await $.env.get('CREW_BOARD_MOTION')) ?? '').toLowerCase() !== 'off'
  paneOpen = (await $.ui.panes()).some(p => p.id === 'tasks')
  await syncSpinner($)
}

/** Whether the board is open (live reads of agents and PRs run only then). */
export function isPaneOpen(): boolean {
  return paneOpen
}

/** Starts (or restarts) the tween `key`; `from` is what it moves away from. */
export function start($: $, key: string, dur: number, from?: unknown): void {
  if (!enabled || !paneOpen) return // nothing to animate on a closed pane
  tweens.set(key, { start: Date.now(), dur, from })
  if (ticker) return
  ticker = $.clock.every(33, () => {
    const now = Date.now()
    for (const [k, t] of tweens) {
      if (now - t.start < t.dur) continue
      tweens.delete(k)
      if (k.startsWith('ans:')) ghosts.delete(k.slice(4))
    }
    if (!tweens.size) {
      ticker?.cancel()
      ticker = null
    }
    void update($, anim, n => n + 1).catch(() => undefined) // one last redraw draws the end state
  })
}

/** Eased progress of `key` now (over its first `over` ms), 1 when it isn't moving. */
export function at(key: string, now: number, over?: number): number {
  return progress(tweens.get(key), now, over)
}

/** True while `key` is moving. */
export function moving(key: string): boolean {
  return tweens.has(key)
}

export function fromOf<T>(key: string): T | undefined {
  return tweens.get(key)?.from as T | undefined
}

/** A pressed answer: drawn as the settled choice for a moment, then gone. */
export function settle($: $, d: Decision, ns: number[], text = ''): void {
  if (!enabled || !paneOpen) return
  ghosts.set(d.id, { d, ns, text })
  start($, `ans:${d.id}`, DUR.hold)
}

export function unsettle(id: string): void {
  ghosts.delete(id)
  tweens.delete(`ans:${id}`)
}

export async function paneOpened($: $): Promise<void> {
  const opening = !paneOpen
  paneOpen = true
  if (opening) start($, 'pane', DUR.open)
  await syncSpinner($)
}

/** The pane is gone: nothing left to move. */
export function paneClosed(): void {
  paneOpen = false
  tweens.clear()
  ghosts.clear()
  ticker?.cancel()
  ticker = null
  spinner?.cancel()
  spinner = null
}

/** The one looping glyph: turns only while this session is the lead, works, and the pane is open. */
export async function syncSpinner($: $): Promise<void> {
  const mine = ++syncs
  const [w, t] = await Promise.all([read($, working), read($, tick)])
  if (mine !== syncs) return // a newer sync started meanwhile: its answer is the current one
  const on = enabled && paneOpen && w && !!t?.me.is_lead // decided after the reads, so a close meanwhile counts
  if (on && !spinner) spinner = $.clock.every(400, () => void update($, frame, f => (f + 1) % 4).catch(() => undefined))
  if (!on && spinner) {
    spinner.cancel()
    spinner = null
  }
}
