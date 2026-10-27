// The board's colour themes: Default (the M2 look) and redditflow (The user's dashboard), picked in the Overview's folded
// Theme section and kept in $.store across sessions. (Follow Orca was tried in M4 and taken out at the user's request.)
import { atom, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Palette, Theme, ThemeChoice } from '../types'
import { DEFAULT } from './logic'

type $ = EngineInterface

// redditflow-va-ui/dashboard/va_static/index.html :root: phosphor greys on near-black, neon green/cyan/amber/magenta.
export const REDDITFLOW: Palette = {
  green: '#00ff41',
  greenBg: '#06160a',
  lavender: '#ff5ec8', // review: the dashboard's magenta, its nearest distinct hue
  lavenderBg: '#1d0a17',
  blue: '#00e5ff',
  blueBg: '#03171b',
  amber: '#ffb000',
  amberBg: '#1b1404',
  grey: '#9bb09b',
  greyBg: '#111111',
  text: '#9bb09b',
  muted: '#6f816f',
  faint: '#56664f',
  accent: '#00e5ff',
  rule: '#1a1a1a',
  bg: '#050505',
  raised: '#111111',
  soft: '#262626',
  bright: '#eaf3ea',
}

export const THEMES: { choice: ThemeChoice; label: string; note: string }[] = [
  { choice: 'default', label: 'Default', note: 'the board as first designed' },
  { choice: 'redditflow', label: 'redditflow', note: 'near-black, neon chips' },
]

export const FIRST: Theme = { choice: 'default', palette: DEFAULT, neon: false }

const theme = atom({ plugin: 'crew-board', key: 'theme' } as const, FIRST)

function of(choice: ThemeChoice): Theme {
  return choice === 'redditflow' ? { choice, palette: REDDITFLOW, neon: true } : FIRST
}

/** session.start: the choice the user made last time (Default otherwise, including a retired 'orca'). */
export async function loadTheme($: $): Promise<void> {
  const saved = await $.store.get('theme')
  const choice = THEMES.some(x => x.choice === saved) ? (saved as ThemeChoice) : 'default'
  await update($, theme, () => of(choice))
}

/** A pick in the Theme section: drawn at once, kept across sessions. */
export async function pickTheme($: $, choice: ThemeChoice): Promise<void> {
  await update($, theme, () => of(choice))
  await $.store.set('theme', choice)
}
