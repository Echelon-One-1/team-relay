import { createContext, useContext } from 'react'

// The team the console is showing (M9 §5), or null for a console server that serves one team
// only (no /api/teams): then no X-Relay-Team is sent and the server's own team is read.
export const TeamContext = createContext<string | null>(null)

export function useTeam(): string | null {
  return useContext(TeamContext)
}

/**
 * The page shown: the team's, the admin page (M9 §4), the Join checklist (M11 §6, at /join; the
 * relay serves /setup on the same host), Ask (M11 §4, at /ask) or the team's settings (at /settings).
 */
export type ConsoleView = 'team' | 'admin' | 'join' | 'ask' | 'settings'

/** A part of the team's page to bring into view once it is shown (M10 §1: after creating a team). */
export type ConsoleFocus = 'boundaries'

/** What the header and the pages need to move between teams and views (M9 §5). */
export interface Nav {
  /** The viewer's teams, or null for a console server that serves one team only. */
  teams: import('@/api/types').Teams | null
  team: string | null
  /**
   * Show `team` (its team page, or `view`); with `focus`, bring that part of its page into view
   * once it is there.
   */
  selectTeam: (team: string, focus?: ConsoleFocus, view?: ConsoleView) => void
  view: ConsoleView
  setView: (view: ConsoleView) => void
  openCreate: () => void
  /** What to bring into view, until the page has done so (clearFocus). */
  focus: ConsoleFocus | null
  clearFocus: () => void
}

export const NavContext = createContext<Nav>({
  teams: null,
  team: null,
  selectTeam: () => {},
  view: 'team',
  setView: () => {},
  openCreate: () => {},
  focus: null,
  clearFocus: () => {},
})

export function useNav(): Nav {
  return useContext(NavContext)
}
