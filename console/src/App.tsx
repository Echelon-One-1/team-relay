import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { Activity } from '@/components/console/activity'
import { AdminPage } from '@/components/console/admin'
import { Agents } from '@/components/console/agents'
import { Header } from '@/components/console/header'
import { JoinPanel } from '@/components/console/join'
import { Members } from '@/components/console/members'
import { RequestSheet } from '@/components/console/request-sheet'
import { ResizableRow } from '@/components/console/resizable-row'
import { Expired, Loading, MissingKey, NotOnTeam, SessionExpired, UnreachableBanner } from '@/components/console/states'
import { mapMembers, TeamMap } from '@/components/console/team-map'
import { CreateTeamDialog, NoTeamPage, TeamSettings } from '@/components/console/teams'
import { consoleKey, isHosted } from '@/api/key'
import { teamsKey, useActivity, useConnection, useDirectory, useMe, useRoster, useTeams } from '@/hooks/queries'
import { NavContext, TeamContext, useNav, type ConsoleFocus, type ConsoleView, type Nav } from '@/hooks/team'
import { useNow } from '@/hooks/use-now'
import { sortedRequests } from '@/lib/activity'
import { isOwner } from '@/lib/roster'
import { effectiveRequest } from '@/lib/steps'
import { pickTeam, rememberTeam } from '@/lib/teams'

export function Console() {
  const me = useMe()
  const directory = useDirectory()
  const activity = useActivity()
  const conn = useConnection()
  const roster = useRoster()
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

  // M6 §4 (hosted): a signed-in account the relay does not know sees this, and no data. With
  // several teams (M9 §5) it means this team is no longer theirs: their teams are read again.
  const stranger = [me.error, directory.error, activity.error, roster.error].find((e) => e?.kind === 'not_on_team')
  useEffect(() => {
    if (stranger && nav.teams) void qc.invalidateQueries({ queryKey: teamsKey })
  }, [stranger, nav.teams, qc])
  if (stranger) return nav.teams ? <NoTeamPage teams={nav.teams} lost={nav.team} /> : <NotOnTeam email={stranger.email} />
  if (conn.state === 'session_expired' || me.error?.kind === 'session_expired') return <SessionExpired />
  if (conn.state === 'unauthorized' || me.error?.kind === 'unauthorized') return <Expired />

  return (
    <div className="min-h-dvh">
      <Header />
      <main className="mx-auto flex max-w-[1440px] flex-col gap-4 px-3 py-4 sm:px-6 sm:py-5">
        {conn.state === 'unreachable' ? <UnreachableBanner conn={conn} /> : null}
        <JoinPanel owner={owner} />
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
          <Members roster={roster.data} loading={roster.isPending} failed={roster.isError} me={member} owner={owner} />
        )}
        <Activity requests={requests} me={member} now={now} loading={activity.isPending} onOpen={setOpenId} />
        {entry ? (
          <TeamSettings
            entry={entry}
            owner={entry.role === 'owner' && owner}
            roleKnown={roster.data !== undefined || me.data !== undefined || roster.isError}
          />
        ) : null}
      </main>
      <RequestSheet req={selected} me={member} now={now} onClose={() => setOpenId(null)} />
    </div>
  )
}

/** The view from the address: /admin is the admin page (M9 §4), anything else the team. */
function viewFromLocation(): ConsoleView {
  return /\/admin\/?$/.test(window.location.pathname) ? 'admin' : 'team'
}

function useView(): [ConsoleView, (v: ConsoleView) => void] {
  const [view, setViewState] = useState<ConsoleView>(viewFromLocation)
  useEffect(() => {
    const onPop = () => setViewState(viewFromLocation())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  const setView = useCallback((v: ConsoleView) => {
    setViewState(v)
    if (viewFromLocation() === v) return
    try {
      const target = new URL(v === 'admin' ? 'admin' : './', window.location.href)
      target.search = window.location.search
      target.hash = ''
      window.history.pushState(window.history.state, '', target.pathname + target.search)
    } catch {
      // A sandboxed document may refuse; the view still changes.
    }
  }, [])
  return [view, setView]
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
  const [view, setView] = useView()
  const [creating, setCreating] = useState(false)
  // What to bring into view on which team's page, until that page has done so.
  const [focusOn, setFocusOn] = useState<{ team: string; part: ConsoleFocus } | null>(null)

  const data = teams.data
  const team = data ? pickTeam(data, chosen) : null
  const selectTeam = useCallback(
    (t: string, focus?: ConsoleFocus) => {
      setChosen(t)
      rememberTeam(t)
      setView('team')
      setFocusOn(focus ? { team: t, part: focus } : null)
    },
    [setView],
  )
  const clearFocus = useCallback(() => setFocusOn(null), [])
  // Only once that team is the one shown (a new team appears after the teams are read again).
  const focus = focusOn !== null && focusOn.team === team ? focusOn.part : null
  const nav = useMemo<Nav>(
    () => ({ teams: data ?? null, team, selectTeam, view, setView, openCreate: () => setCreating(true), focus, clearFocus }),
    [data, team, selectTeam, view, setView, focus, clearFocus],
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
        <Console key={team ?? ''} />
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
  // Hosted behind IAP (M3 §4) no key is needed; locally the link's key is.
  if (consoleKey() === null && !isHosted()) return <MissingKey />
  return <Teams />
}
