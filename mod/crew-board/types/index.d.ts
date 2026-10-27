export type Lead = {
  /** starting: started from the board (tasks start-lead) a moment ago, not seated yet; unconfirmed: Orca never
   * answered that start, so a lead may be running unseen (only Start anyway replaces it) */
  state: 'working' | 'idle' | 'offline' | 'starting' | 'unconfirmed'
  terminal: string | null
  since: number | null
  registered: boolean
  /** the store knows the last lead's conversation: Resume can bring it back */
  resumable?: boolean
}

export type Repo = {
  repo: string
  prefix: string
  enabled: boolean
  display_name: string
  badge_color: string | null
  lead: Lead
}

export type Card = {
  id: string
  repo: string
  title: string
  status: string
  stage: string | null
  steps_done: number
  steps_total: number
  step_label: string
  summary: string
  next: string
  needs_you: boolean
  open_decisions: number
  updated: number
  created: number
  has_result: boolean
  closed: boolean
  /** finished (closed) but a board hasn't shown it to the user yet, or only just did: it stays among the open (TAS-21) */
  just_done?: boolean
  /** linked agents and PRs (`tasks link ID agent|pr ...`); absent from an older store */
  agents?: { ref: string; label: string }[]
  prs?: { ref: string; label: string }[]
}

export type Decision = {
  id: string
  task_id: string
  question: string
  options: string[]
  descs: string[]
  /** The user may pick several options (AskUserQuestion multiSelect) */
  multi: boolean
  recommended: number | null
  state: string
  answer: string | null
  raised: number
  created: number
}

export type Message = {
  id: number
  task_id: string
  kind: 'message' | 'new_task' | 'answer'
  author: 'user' | 'lead' | 'system'
  text: string
  ts: number
  /** when the lead's pane claimed it for sending (null before) */
  sent_at: number | null
  state: string
  state_note: string
  envelope: string | null
}

export type TaskLink = { task_id: string; kind: string; ref: string; label: string }

export type Detail = Card & {
  why: string
  done: string
  verified: string
  origin: string
  aliases: string
  decisions: Decision[]
  links: TaskLink[]
  report: string | null
  /** the latest ones only (the board asks for a window); the totals say how many there are in all */
  events: { id?: number; ts: number; kind: string; text: string }[]
  messages: Message[]
  events_total?: number
  messages_total?: number
  lead: Lead
}

export type Board = { repos: Repo[]; tasks: Card[]; decisions: Decision[]; updated: number }

export type Tick = {
  /** token: stamped by the mod: the conversation this answer was for (a /clear makes it someone else's) */
  /** reopen: this conversation just took over as lead and the former lead's board was open: its view (JSON), sent once */
  me: { repo: string; enabled: boolean; is_lead: boolean; token?: string; reopen?: string }
  claimed: Message[]
  board: Board
  task?: Detail | null
}

export type Tab = 'result' | 'conversation' | 'activity' | 'files'

export type View = {
  task: string | null
  tab: Tab
  newRepo: string | null
  composer: number
  /** the Theme section at the bottom of the Overview is open */
  showTheme: boolean
  /** repos whose proposed tasks are unfolded in the Overview (folded into "+ 6 proposed" otherwise) */
  openProposed: string[]
  /** repos whose Completed fold is open in the Overview (TAS-25; folded by default) */
  openDone: string[]
  /** how much of a task's history is shown, for that task only (any other task shows the first page); m / e: reach
   * back at least to this message / event (a search hit's evidence) */
  more?: { task: string; n: number; m?: number; e?: number } | null
  /** a search hit opened on the Result tab: the stored text that matched, where, and its report file if it was one */
  evidence?: { task: string; label: string; text: string; path: string | null } | null
  /** the repo whose new-task field is open in the Overview (its ＋, or picked from the list) */
  adding?: string | null
  /** the repo list is open over the Overview, with its filter text and the highlighted row */
  picking?: { q: string; at: number } | null
  /** a task just sent from the Overview: the line saying so, where its field was (TAS-20) */
  added?: { repo: string; id: string } | null
  /** Mark done / Close pressed once on this task: pressing again does it */
  confirm?: { task: string; what: 'done' | 'dropped' } | null
}

/** Where a search hit's evidence lives, so opening it lands there: ref is the message or event id, the report's path,
 * or the field's name. pos: 1 = the task's newest message (or event) when searched. */
export type Where = { kind: 'field' | 'message' | 'event' | 'report'; ref: string | number | null; pos: number | null; ts: number | null }
/** One task found by the Overview's search; `exact`: the query named its ID or an alias. The excerpt is stored text. */
export type Hit = { id: string; exact: boolean; excerpt: string; where: Where }
/** The Overview's search: the query (empty: the ordinary overview), its word hits, and the tasks a model matched by meaning. */
export type Search = { q: string; box: number; words: Hit[]; meaning: Hit[]; state: 'thinking' | 'done' | 'unavailable' }

/** Every colour the board draws with, by role. Meanings stay put across themes: green ready, lavender review, blue running, amber needs you. */
export type Palette = Record<
  | 'green' | 'greenBg' | 'lavender' | 'lavenderBg' | 'blue' | 'blueBg' | 'amber' | 'amberBg' | 'grey' | 'greyBg'
  | 'text' | 'muted' | 'faint' | 'accent' | 'rule' | 'bg' | 'raised' | 'soft' | 'bright',
  string
>

export type ThemeChoice = 'default' | 'redditflow'
/** neon: redditflow's look (outlined uppercase chips, `>` section labels). */
export type Theme = { choice: ThemeChoice; palette: Palette; neon: boolean }

export type AgentState = 'working' | 'idle' | 'done' | 'unknown'
/** Agent terminals' live state, by Orca terminal handle, and when it was read. */
export type Live = { at: number; agents: Record<string, { kind: string; state: AgentState }> }

export type PrState = 'open' | 'draft' | 'merged' | 'closed'
export type Checks = 'passing' | 'failing' | 'pending' | 'none'
/** A linked PR as gh last reported it. */
export type Pr = { ref: string; at: number; number?: number; url?: string; state?: PrState; checks?: Checks; review?: string }

declare module 'claude-code' {
  interface PluginState {
    'crew-board': {
      tick: Tick | null
      view: View
      report: { path: string; text: string } | null
      working: boolean
      frame: number
      /** bumped once per motion frame while a transition runs, so the pane redraws */
      anim: number
      /** agent terminals' live state, read from Orca while the pane is open (null until the first read) */
      live: Live | null
      /** each linked PR's state from gh, by its link ref */
      prs: Record<string, Pr>
      boardTask: string | null
      turns: string[]
      seen: string[] | null
      notice: string
      error: string
      /** what is typed in each text field, by the field's key, with the caret after the last edit: drawn wrapped under the one-row field */
      typed: Record<string, { text: string; caret: number }>
      /** a multi-select decision's options ticked so far, by decision id (sent with Submit) */
      chosen: Record<string, number[]>
      /** this conversation in this process (kept by reload and /compact, reset by /clear): one of the lead's identities */
      token: string
      /** ids of the board messages this conversation submitted, so their turn is acknowledged even after a takeover */
      sent: number[]
      /** the Overview's task search */
      search: Search
      /** Start a lead pressed for this repo (resume: bring back the last one): waiting for the user's y/n */
      confirming: { repo: string; resume: boolean; anyway?: boolean } | null
      /** the board's colours: the choice (kept in $.store across sessions) */
      theme: Theme
    }
  }
}
