import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { Activity } from '@/components/console/activity'
import { AdminPage } from '@/components/console/admin'
import { Agents } from '@/components/console/agents'
import { AskPage } from '@/components/console/ask'
import { Header } from '@/components/console/header'
import { SetupFinished, SetupView, useSetupFinished } from '@/components/console/local-setup'
import { Members, progressByMember } from '@/components/console/members'
import { RequestSheet } from '@/components/console/request-sheet'
import { ResizableRow } from '@/components/console/resizable-row'
import { AcceptBanner, useViewerSetup, ViewTabs } from '@/components/console/setup'
import { Expired, Loading, MissingKey, NotOnTeam, SessionExpired, UnreachableBanner } from '@/components/console/states'
import { mapMembers, TeamMap } from '@/components/console/team-map'
import { CreateTeamDialog, NoTeamPage, TeamSettings } from '@/components/console/teams'
import { consoleKey, isHosted } from '@/api/key'
import { teamsKey, useActivity, useBoundaries, useConnection, useDirectory, useMe, useMembersStatus, useRoster, useTeams } from '@/hooks/queries'
import { NavContext, TeamContext, useNav, type ConsoleFocus, type ConsoleView, type Nav } from '@/hooks/team'
import { useNow } from '@/hooks/use-now'
import { sortedRequests } from '@/lib/activity'
import { isOwner } from '@/lib/roster'
import { SETUP_STEPS } from '@/lib/setup'
import { effectiveRequest } from '@/lib/steps'
import { pickTeam, rememberTeam } from '@/lib/teams'

export function Console() {
  const me = useMe()
  const directory = useDirectory()
  const activity = useActivity()
  const conn = useConnection()
  const roster = useRoster()
  const statuses = useMembersStatus()
  const bounds = useBoundaries()
  const nav = useNav()
  const qc = useQueryClient()
  const localNow = useNow()
  const [openId, setOpenId] = useState<string | null>(null)

  const now = localNow + (activity.data?.serverOffsetMs ?? 0)
  const sorted = useMemo(() => (activity.data ? sortedRequests(activity.data) : []), [activity.data])
  // Every view draws the effective status, by the server's clock (M2 §7.2): what the
  // relay's sweep would record at this moment, not what the feed last stored.
  const requests = useMemo(() => sorted.map((r) => effectiveRequest(r, now)), [sorted, now])
  const member = me.data?.member ?? null
  const teammates = directory.data?.members.filter((m) => m.member !== member) ?? []
  const members = member ? mapMembers(member, me.data?.teammates ?? [], directory.data?.members, now) : []
  const held = openId ? (activity.data?.byId[openId] ?? null) : null
  const selected = held ? effectiveRequest(held, now) : null
  // The roster when it has loaded (it is read again after every change), else /me's role.
  const owner = roster.data ? isOwner(roster.data, member) : me.data?.role === 'owner'
  // An older relay without a roster (404): no Members panel at all.
  const rosterMissing = roster.error?.kind === 'not_found'
  // M9 §7.7, M10 §1: the settings of a team the viewer holds: its boundaries for everyone (owners
  // edit them), and Delete team for owners (the relay refuses a file team).
  const entry = nav.teams?.teams.find((t) => t.team === nav.team) ?? null
  // M11 §6: the viewer's own progress for the Setup tab, and everyone's for the Members panel.
  const viewerSetup = useViewerSetup()
  const progress = useMemo(() => progressByMember(statuses.data, bounds.data), [statuses.data, bounds.data])
  const setupDone = statuses.data ? viewerSetup.done : null

  // M6 §4 (hosted): a signed-in account the relay does not know sees this, and no data. With
  // several teams (M9 §5) it means this team is no longer theirs: their teams are read again.
  const stranger = [me.error, directory.error, activity.error, roster.error].find((e) => e?.kind === 'not_on_team')
  useEffect(() => {
    if (stranger && nav.teams) void qc.invalidateQueries({ queryKey: teamsKey })
  }, [stranger, nav.teams, qc])
  // A console server that serves one team names no team, so it has no settings page: /settings
  // shows the team, and the address says so (in place, so Back does not return to it).
  const noSettings = nav.view === 'settings' && entry === null
  const { replaceView } = nav
  useEffect(() => {
    if (noSettings) replaceView('team')
  }, [noSettings, replaceView])
  if (stranger) return nav.teams ? <NoTeamPage teams={nav.teams} lost={nav.team} /> : <NotOnTeam email={stranger.email} />
  if (conn.state === 'session_expired' || me.error?.kind === 'session_expired') return <SessionExpired />
  if (conn.state === 'unauthorized' || me.error?.kind === 'unauthorized') return <Expired />

  return (
    <div className="min-h-dvh">
      <Header />
      <main className="mx-auto flex max-w-[1440px] flex-col gap-4 px-3 py-4 sm:px-6 sm:py-5">
        {conn.state === 'unreachable' ? <UnreachableBanner conn={conn} /> : null}
        <ViewTabs setup={setupDone !== null ? { done: setupDone } : null} settings={entry !== null} />
        {nav.view === 'ask' ? <AskPage /> : nav.view === 'join' ? <SetupView /> : nav.view === 'settings' && entry ? settingsView(entry) : teamView()}
      </main>
      <RequestSheet req={selected} me={member} now={now} onClose={() => setOpenId(null)} />
    </div>
  )

  // The team's page: a plain function of this render (not a component, so nothing remounts).
  function teamView() {
    return (
      <>
        <AcceptBanner />
        <ResizableRow className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
          {(sized) => (
            <>
              <TeamMap
                members={members}
                requests={requests}
                stale={conn.state === 'unreachable'}
                fill={sized}
                className={sized ? 'lg:min-h-0' : undefined} />
              <Agents
                agents={teammates}
                loading={directory.isPending}
                now={now}
                statsComplete={directory.data?.stats_complete !== false}
                className={sized ? 'lg:min-h-0' : 'lg:max-h-[27rem]'} />
            </>
          )}
        </ResizableRow>
        {rosterMissing ? null : (
          <Members roster={roster.data} loading={roster.isPending} failed={roster.isError} me={member} owner={owner} progress={progress} />
        )}
        <Activity requests={requests} me={member} now={now} loading={activity.isPending} onOpen={setOpenId} />
      </>
    )
  }

  // Team settings (its own page, /settings): everyone reads them, owners change them.
  function settingsView(team: NonNullable<typeof entry>) {
    return (
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4" data-settings-team={team.team}>
        <TeamSettings
          entry={team}
          owner={team.role === 'owner' && owner}
          roleKnown={roster.data !== undefined || me.data !== undefined || roster.isError}
        />
      </div>
    )
  }
}

/**
 * The view from the address: /admin is the admin page (M9 §4), /join the Join checklist and /ask
 * the Ask page (M11), /settings the team's settings, /team and anything else the team (the local
 * console opens at /). On the
 * hosted address / and /login are the relay's sign-in page and /setup its setup script
 * (docs/SIGNIN-PAGE.md); the page's button leads to /start (see startRequested).
 */
function viewFromLocation(): ConsoleView {
  const m = /\/(admin|join|ask|team|settings)\/?$/.exec(window.location.pathname)
  return m ? (m[1] as ConsoleView) : 'team'
}

/** Whether the address is /start: where the sign-in page leads, until the setup state is known. */
function startRequested(): boolean {
  return /\/start\/?$/.test(window.location.pathname)
}

/** The address of `v`, relative to where the page is served, with the query and no fragment. */
function viewAddress(v: ConsoleView): string {
  const target = new URL(v, window.location.href)
  target.search = window.location.search
  // The local console's key stays out of the address.
  target.hash = ''
  return target.pathname + target.search
}

function useView(): [ConsoleView, (v: ConsoleView) => void, (v: ConsoleView) => void] {
  const [view, setViewState] = useState<ConsoleView>(viewFromLocation)
  useEffect(() => {
    const onPop = () => setViewState(viewFromLocation())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  const setView = useCallback((v: ConsoleView) => {
    setViewState(v)
    if (viewFromLocation() === v && !startRequested()) return
    try {
      window.history.pushState(window.history.state, '', viewAddress(v))
    } catch {
      // A sandboxed document may refuse; the view still changes.
    }
  }, [])
  // The same, in place of the current entry (/start leaves no entry to come back to).
  const replaceView = useCallback((v: ConsoleView) => {
    setViewState(v)
    try {
      window.history.replaceState(window.history.state, '', viewAddress(v))
    } catch {
      // A sandboxed document may refuse; the view still changes.
    }
  }, [])
  return [view, setView, replaceView]
}

/**
 * /start (docs/SIGNIN-PAGE.md): the loading state until the viewer's own setup is known (the data
 * the Setup tab shows), then `/join` while it is not done, else `/ask`. A setup that cannot be read
 * goes to /join, which says why.
 */
function StartRedirect({ onKnown }: { onKnown: (v: ConsoleView) => void }) {
  const setup = useViewerSetup()
  const failed = setup.me.isError || setup.statuses.isError || setup.bounds.isError
  const next: ConsoleView | null = failed ? 'join' : setup.known ? (setup.done === SETUP_STEPS ? 'ask' : 'join') : null
  useEffect(() => {
    if (next) onKnown(next)
  }, [next, onKnown])
  return <Loading />
}

/**
 * The console with the viewer's teams (M9 §5): which team is shown (the one chosen, else the
 * last one chosen in this browser, else the console's default, else the first), the admin
 * page for relay admins, and the page for a viewer on no team. A console server without
 * /api/teams serves one team: the console then names none, as before.
 */
function Teams() {
  const teams = useTeams()
  const [chosen, setChosen] = useState<string | null>(null)
  const [view, setView, replaceView] = useView()
  const [starting, setStarting] = useState(startRequested)
  const [creating, setCreating] = useState(false)
  // What to bring into view on which team's page, until that page has done so.
  const [focusOn, setFocusOn] = useState<{ team: string; part: ConsoleFocus } | null>(null)

  const data = teams.data
  const team = data ? pickTeam(data, chosen) : null
  const selectTeam = useCallback(
    (t: string, focus?: ConsoleFocus, next: ConsoleView = 'team') => {
      setChosen(t)
      rememberTeam(t)
      setView(next)
      setFocusOn(focus ? { team: t, part: focus } : null)
    },
    [setView],
  )
  const clearFocus = useCallback(() => setFocusOn(null), [])
  const finishStart = useCallback(
    (v: ConsoleView) => {
      setStarting(false)
      replaceView(v)
    },
    [replaceView],
  )
  // /start for a viewer on no team: what the team view shows them (the page for no team).
  const noTeam = !!data && team === null
  useEffect(() => {
    if (starting && noTeam) finishStart('team')
  }, [starting, noTeam, finishStart])
  // Only once that team is the one shown (a new team appears after the teams are read again).
  const focus = focusOn !== null && focusOn.team === team ? focusOn.part : null
  const nav = useMemo<Nav>(
    () => ({ teams: data ?? null, team, selectTeam, view, setView, replaceView, openCreate: () => setCreating(true), focus, clearFocus }),
    [data, team, selectTeam, view, setView, replaceView, focus, clearFocus],
  )

  if (teams.isPending) return <Loading />
  if (!data) {
    if (teams.error?.kind === 'session_expired') return <SessionExpired />
    if (teams.error?.kind === 'unauthorized') return <Expired />
  }

  let body
  if (data && view === 'admin' && data.admin) {
    body = (
      <div className="min-h-dvh">
        <Header />
        <AdminPage />
      </div>
    )
  } else if (data && team === null) {
    body = <NoTeamPage teams={data} />
  } else {
    // A team's view starts fresh: nothing of another team's stays on screen.
    body = (
      <TeamContext.Provider value={team}>
        {starting ? <StartRedirect onKnown={finishStart} /> : <Console key={team ?? ''} />}
      </TeamContext.Provider>
    )
  }
  return (
    <NavContext.Provider value={nav}>
      {body}
      {data?.can_manage_teams ? <CreateTeamDialog open={creating} onOpenChange={setCreating} /> : null}
    </NavContext.Provider>
  )
}

export function App() {
  // /team-relay:setup's page after Done: its server has stopped, so nothing else is shown or read.
  const finished = useSetupFinished()
  if (finished) return <SetupFinished />
  // Hosted behind IAP (M3 §4) no key is needed; locally the link's key is.
  if (consoleKey() === null && !isHosted()) return <MissingKey />
  return <Teams />
}
