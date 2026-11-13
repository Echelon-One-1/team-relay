import { KeyRound, LogIn, PlugZap, ServerOff, UserX } from 'lucide-react'
import type { ReactNode } from 'react'

import { isHosted } from '@/api/key'
import { Button } from '@/components/ui/button'
import type { Connection } from '@/hooks/queries'
import { formatClock } from '@/lib/time'
import { RelayMark } from './primitives'

export function FullPage({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <div className="flex w-full max-w-md flex-col gap-4 rounded-xl border bg-card p-6">
        <div className="flex items-center gap-2 text-[13px] font-semibold">
          <RelayMark />
          Team relay
        </div>
        <div className="flex items-start gap-3">
          <span className="mt-0.5 text-subtle">{icon}</span>
          <div className="flex flex-col gap-1.5">
            <h1 className="text-[15px] font-semibold">{title}</h1>
            <div className="text-[13px] leading-relaxed text-subtle">{children}</div>
          </div>
        </div>
      </div>
    </main>
  )
}

/** While the viewer's teams are read, the first moment after the page opens. */
export function Loading() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4" aria-busy="true">
      <div className="flex items-center gap-2 text-[13px] text-subtle" role="status">
        <RelayMark className="size-4" />
        Loading your teams
      </div>
    </main>
  )
}

export function MissingKey() {
  return (
    <FullPage icon={<KeyRound className="size-4" />} title="Open the console from its link">
      <p>
        This page reads the relay through the console server on your machine, which needs the key in the link it
        prints. Run <code className="rounded bg-muted px-1 py-0.5 font-mono text-[12px] text-foreground">bin/console --open</code>{' '}
        from the plugin, or open the link it printed.
      </p>
    </FullPage>
  )
}

export function Expired() {
  return (
    <FullPage icon={<KeyRound className="size-4" />} title="This console link is no longer valid">
      <p>
        Each launch of the console makes a new key, so a link from an earlier launch stops working. Open the link the
        running console printed, or start it again with{' '}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-[12px] text-foreground">bin/console --open</code>.
      </p>
    </FullPage>
  )
}

/** Hosted (M3 §4): the Google sign-in in front of the console lapsed. */
export function SessionExpired() {
  return (
    <FullPage icon={<LogIn className="size-4" />} title="Your session has expired">
      <p>Reload to sign in again.</p>
      <Button size="sm" className="mt-3" onClick={() => window.location.reload()}>
        Reload
      </Button>
    </FullPage>
  )
}

/**
 * Hosted (M6 §4): the Google account IAP signed in is not on this team. Nothing else is
 * shown: the relay gave the console no data for it.
 */
export function NotOnTeam({ email }: { email: string | null }) {
  return (
    <FullPage icon={<UserX className="size-4" />} title="You're not on this team yet">
      <p data-not-on-team>
        Ask the team owner to add{' '}
        {email ? <span className="font-medium text-foreground">{email}</span> : 'the Google account you signed in with'}. Once
        they have, reload this page.
      </p>
      <p className="mt-2">Signed in with the wrong account? Sign out of Google in this browser, then reload.</p>
    </FullPage>
  )
}

/** The relay (or the console server itself) stopped answering; what is on screen is kept. */
export function UnreachableBanner({ conn }: { conn: Extract<Connection, { state: 'unreachable' }> }) {
  const relay = conn.reason === 'relay'
  const Icon = relay ? PlugZap : ServerOff
  return (
    <div role="alert" className="flex items-start gap-3 rounded-xl border border-bad/30 bg-bad-soft px-4 py-3 text-[12.5px]">
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-bad" />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="font-semibold text-foreground">
          {conn.signInRefused
            ? isHosted()
              ? 'The console could not sign in to the relay'
              : 'The relay refused your sign-in'
            : relay
              ? 'The relay is not answering'
              : 'The console server is not answering'}
        </span>
        <span className="text-subtle">
          {conn.signInRefused
            ? isHosted()
              ? 'The relay refused the console service itself: a setup problem, not your account. Tell the team owner.'
              : 'You were signed out, your sign-in expired, or you are no longer on the team. Run /team-relay:login in Claude Code, then start the console again.'
            : relay
            ? isHosted()
              ? 'The console is running, but its calls to the relay fail.'
              : 'The console server is running, but its calls to the relay fail. Check your network and your sign-in (/team-relay:login).'
            : isHosted()
              ? 'The console service did not answer.'
              : 'It may have been stopped. Start it again with bin/console and open the new link.'}{' '}
          <span className="tnum">
            {conn.updatedAt !== null ? `Showing what arrived by ${formatClock(conn.updatedAt)}. ` : ''}
            Failing since {formatClock(conn.since)}; retrying every 3 s.
          </span>
        </span>
      </div>
    </div>
  )
}
