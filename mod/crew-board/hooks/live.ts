// Live state for what tasks link: agent terminals (read from Orca) and PRs (read from gh). Read only while the pane
// is open and a visible task links one, at most every 10 s (agents) or 60 s per PR, never awaited by the poll.
// A failed or unreadable answer keeps the last known state and waits out the same interval before trying again.
import { atom, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Pr, Tick } from '../types'
import type { OrcaTerminal, OrcaWorker } from './logic'
import { liveAgents, prArgs, prOf } from './logic'
import { isPaneOpen } from './motion'

type $ = EngineInterface

const live = atom({ plugin: 'crew-board', key: 'live' } as const, null)
const prs = atom({ plugin: 'crew-board', key: 'prs' } as const, {} as Record<string, Pr>)

const AGENTS_EVERY = 10_000
const PR_EVERY = 60_000

let agentsTried = 0
let agentsBusy = false
const prTried = new Map<string, number>()

/** The tasks the pane can show: every open one, plus the one being read. */
function visible(t: Tick) {
  return [...t.board.tasks.filter(x => !x.closed), ...(t.task ? [t.task] : [])]
}

export function refreshLive($: $, t: Tick): void {
  if (!isPaneOpen()) return
  const shown = visible(t)
  const now = Date.now()
  if (shown.some(x => x.agents?.length) && !agentsBusy && now - agentsTried >= AGENTS_EVERY) void readAgents($, now)
  for (const ref of new Set(shown.flatMap(x => (x.prs ?? []).map(p => p.ref)))) {
    const args = prArgs(ref)
    if (args && now - (prTried.get(ref) ?? 0) >= PR_EVERY) void readPr($, ref, args, now)
  }
}

async function json($: $, argv: string[]): Promise<unknown> {
  const r = await $.process.run(argv, { timeoutMs: 15_000 })
  if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `${argv[0]} exit ${r.exitCode}`)
  return JSON.parse(r.stdout)
}

async function readAgents($: $, now: number): Promise<void> {
  agentsTried = now
  agentsBusy = true
  try {
    const [terms, workers] = await Promise.all([
      json($, ['orca', 'terminal', 'list', '--json']) as Promise<{ result?: { terminals?: OrcaTerminal[] } }>,
      json($, ['orca', 'orchestration', 'worker-list', '--json', '--limit', '100']) as Promise<{
        result?: { workers?: OrcaWorker[] }
      }>,
    ])
    const list = terms.result?.terminals
    if (!Array.isArray(list)) return // not an answer we can read: keep what we had (either read failing does the same)
    await update($, live, () => ({ at: Date.now(), agents: liveAgents(list, workers.result?.workers ?? [], Date.now()) }))
  } catch (err) {
    $.ui.log(`live agents: ${(err as Error).message ?? err}`, { to: 'debug' })
  } finally {
    agentsBusy = false
  }
}

async function readPr($: $, ref: string, args: string[], now: number): Promise<void> {
  prTried.set(ref, now)
  try {
    const j = (await json($, ['gh', ...args])) as Parameters<typeof prOf>[2]
    if (!j || typeof j !== 'object') return
    await update($, prs, all => ({ ...all, [ref]: prOf(ref, Date.now(), j) }))
  } catch (err) {
    $.ui.log(`pr ${ref}: ${(err as Error).message ?? err}`, { to: 'debug' })
  }
}
