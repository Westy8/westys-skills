import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { cleared, leadTick, openPane, poll, tasks } from './board'
import { askArgs, DUR, envelopeId, postedNote } from './logic'
import { initMotion, moving, paneClosed, start, syncSpinner } from './motion'
import { loadTheme } from './theme'
import { band, pane, pickerScroll } from './ui'

// State refs are declared in each file that reads them (the validator follows only literal refs); the contract is types/index.d.ts.
const working = atom({ plugin: 'crew-board', key: 'working' } as const, false)
const boardTask = atom({ plugin: 'crew-board', key: 'boardTask' } as const, null)
const turns = atom({ plugin: 'crew-board', key: 'turns' } as const, [] as string[])
const sent = atom({ plugin: 'crew-board', key: 'sent' } as const, [] as number[])

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    if (!e.isInteractive) return next(e) // -p / SDK: nobody reads the board, and it must never take the user's messages
    $.clock.every(3000, () => void poll($))
    void poll($)
    await initMotion($).catch(err => $.ui.log(`motion: ${(err as Error).message ?? err}`, { to: 'debug' }))
    await loadTheme($).catch(() => undefined) // Default until it loads
    // `/tasks` is Claude Code's own (background tasks), so the board's command is /board. On a hot reload the
    // engine refuses a re-register ("no session is bound") while /board from the first load still works.
    await $.command.register({ name: 'board', description: 'Open the Tasks board (or one task: /board IGR-4)', argumentHint: '[task id]', immediate: true })
      .catch(err => $.ui.log(`/board not re-registered: ${(err as Error).message ?? err}`, { to: 'debug' }))
    return next(e)
  })

  // /clear, or /resume of another conversation in this process: the next one gets its own identity on its first poll.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') await cleared($, e.sessionId)
    return next(e)
  })

  on('command.run', { command: 'board' }, async ($, e) => {
    await openPane($, e.args.trim() || undefined)
    return { text: 'Tasks board opened.' }
  })

  on('turn.start', async ($, e, next) => {
    $.ui.log(`turn.start ${e.turnId} agent=${e.agentId ?? '-'} text=${e.text.slice(0, 60)}`, { to: 'debug' })
    if (e.agentId) return next(e)
    await $.env.set('CREW_BOARD_TURN', e.turnId) // the turn a `tasks say --reply` answers
    await update($, working, () => true)
    await syncSpinner($)
    await update($, boardTask, () => null) // each turn's own envelope (or none) decides where its questions go
    // Acknowledged by the lead, or by whoever submitted it (still running its queue after a takeover).
    const id = envelopeId(e.text)
    if (id !== null && ((await leadTick($)) || (await read($, sent)).includes(id))) {
      const r = JSON.parse(await tasks($, ['turn-start', '--turn', e.turnId, '--session', await $.session.id(), '--json'], e.text)) as {
        task_ids: string[]
      }
      await update($, sent, ids => ids.filter(x => x !== id)) // its turn started: settled
      if (r.task_ids.length) {
        await update($, turns, list => [...list, e.turnId].slice(-50))
        await update($, boardTask, () => r.task_ids[0] ?? null)
      }
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    $.ui.log(`turn.complete ${e.turnId} agent=${e.agentId ?? '-'} reason=${e.reason} answer=${e.answer.length}`, { to: 'debug' })
    if (e.agentId) return next(e)
    await update($, working, () => false)
    await syncSpinner($)
    if ((await read($, turns)).includes(e.turnId) && e.answer.trim() && !e.isAborted) {
      await tasks($, ['turn-complete', '--turn', e.turnId], e.answer)
      await update($, turns, list => list.filter(x => x !== e.turnId))
      void poll($)
    }
    return next(e)
  })

  // Lead only: the ask tool becomes buttons in the pane and returns at once, so the lead never blocks on the user.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const t = await leadTick($)
    if (!t || e.agentId) return next(e) // a worker's question has no route back from the board
    const task = (await read($, boardTask)) ?? (await tasks($, ['general', '--repo', t.me.repo]))
    const ids: string[] = []
    for (const q of e.questions) ids.push(await tasks($, askArgs(task, q)))
    void poll($)
    const note = postedNote(ids)
    return {
      result: { questions: e.questions, answers: Object.fromEntries(e.questions.map(q => [q.question, `(not answered yet) ${note}`])) },
      context: [note],
    }
  }).catch(($, e, next) => next(e)) // the store failed: fall back to the normal question dialog

  // Closing by hand fades the pane out first; any other close (a reload's unload) goes at once.
  on('ui.close', { id: 'tasks' }, async ($, e, next) => {
    if (e.origin.kind === 'person') {
      start($, 'close', DUR.close)
      if (moving('close')) await $.clock.sleep(DUR.close).catch(() => undefined) // motion off: close at once
    }
    paneClosed()
    return next(e)
  })

  // While the repo list is open the arrows move its highlight (TAS-19), not the board.
  on('ui.scroll', { requestId: 'tasks' }, async ($, e, next) =>
    e.origin.kind === 'person' && Math.abs(e.by) === 1 && (await pickerScroll($, e.by)) ? {} : next(e))

  on('ui.render', { component: 'Pane', requestId: 'tasks' }, async ($, e, next) => (await pane($, e)) ?? next(e))
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => (await band($, e)) ?? next(e))
}
