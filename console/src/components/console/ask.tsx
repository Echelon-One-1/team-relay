import { ChevronRight, Send, Users } from 'lucide-react'
import { useId, useState, type FormEvent } from 'react'

import type { ChangeError } from '@/api/client'
import type { MyRequest, RequestRecipient } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useAsk, useAskDetail, useDirectory, useMe, useMembersStatus, useMyRequests } from '@/hooks/queries'
import { useNow } from '@/hooks/use-now'
import { answerText, askProblem, askRefusal, QUESTION_MAX, questionLength, recipientsOf, STATUS_LABEL, STATUS_TONE, summaryLine, toLabel } from '@/lib/ask'
import { formatAgo, ms } from '@/lib/time'
import { cn } from '@/lib/utils'
import { Avatar, Panel, StatusPill } from './primitives'

// M11 §4: asking from the browser. The viewer picks teammates or everyone, types a question and
// sends it; their last 20 questions are listed, each showing who acknowledged and answered
// (read every 3 s while open, every 30 s while closed). Answers are teammates' text: shown as
// plain text only, never as markup.

function Chip({ pressed, onClick, children, answering }: { pressed: boolean; onClick: () => void; children: string; answering?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      data-recipient={children}
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[12.5px] outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/40',
        pressed && 'border-signal/50 bg-signal-soft text-signal hover:bg-signal-soft',
      )}
    >
      {answering !== undefined ? (
        <span
          aria-hidden
          className={cn('size-1.5 rounded-full', answering ? 'bg-ok' : 'border border-faint')}
          title={answering ? 'Answering now' : 'Not answering now'}
        />
      ) : null}
      {children}
      {answering ? <span className="sr-only">, answering now</span> : null}
    </button>
  )
}

function AskForm({ onAsked }: { onAsked: (id: string) => void }) {
  const me = useMe()
  const directory = useDirectory()
  const statuses = useMembersStatus()
  const ask = useAsk()
  const [everyone, setEveryone] = useState(false)
  const [chosen, setChosen] = useState<string[]>([])
  const [question, setQuestion] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState<string | null>(null)
  const questionId = useId()
  const counterId = useId()
  const errorId = useId()

  const viewer = me.data?.member ?? null
  const fromDirectory = directory.data?.members.map((m) => m.member) ?? []
  const teammates = [...new Set([...(me.data?.teammates ?? []), ...fromDirectory])].filter((m) => m !== viewer).sort()
  const answering = new Map(statuses.data?.members.map((m) => [m.member, m.answering]) ?? [])
  const to: '*' | string[] = everyone ? '*' : chosen
  const length = questionLength(question)
  const over = length > QUESTION_MAX
  const problem = askProblem(to, question)

  const toggle = (m: string) => {
    setEveryone(false)
    setSent(null)
    setChosen((c) => (c.includes(m) ? c.filter((x) => x !== m) : [...c, m]))
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (problem) {
      setError(problem)
      return
    }
    setError(null)
    setSent(null)
    ask.mutate(
      { to, question },
      {
        onSuccess: (out) => {
          setQuestion('')
          setSent(to === '*' ? 'Sent to everyone.' : `Sent to ${toLabel(to)}.`)
          if (out && typeof out.request_id === 'string') onAsked(out.request_id)
        },
        onError: (err: ChangeError) => setError(askRefusal(err)),
      },
    )
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3 p-4" aria-label="Ask a question" data-ask-form>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1.5 text-[12px] font-medium text-subtle">Ask</legend>
        {me.isPending ? (
          <Skeleton className="h-7 w-2/3" />
        ) : (
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Who to ask">
            <button
              type="button"
              aria-pressed={everyone}
              onClick={() => {
                setEveryone((v) => !v)
                setChosen([])
                setSent(null)
              }}
              data-recipient="*"
              className={cn(
                'inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[12.5px] font-medium outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/40',
                everyone && 'border-signal/50 bg-signal-soft text-signal hover:bg-signal-soft',
              )}
            >
              <Users aria-hidden className="size-3.5" />
              Everyone
            </button>
            {teammates.map((m) => (
              <Chip key={m} pressed={!everyone && chosen.includes(m)} onClick={() => toggle(m)} answering={answering.get(m)}>
                {m}
              </Chip>
            ))}
            {teammates.length === 0 ? <span className="self-center text-[12px] text-subtle">No teammates yet.</span> : null}
          </div>
        )}
      </fieldset>
      <div className="flex flex-col gap-1">
        <label htmlFor={questionId} className="text-[12px] font-medium text-subtle">
          Question
        </label>
        <textarea
          id={questionId}
          value={question}
          rows={5}
          onChange={(e) => {
            setQuestion(e.target.value)
            setError(null)
            setSent(null)
          }}
          aria-invalid={over || undefined}
          aria-describedby={`${counterId}${error ? ` ${errorId}` : ''}`}
          placeholder="What do you want to know?"
          className="min-h-28 w-full resize-y rounded-md border border-input bg-background px-2.5 py-2 text-[13px] leading-relaxed text-foreground outline-none placeholder:text-faint focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40 aria-invalid:border-bad"
        />
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11.5px] text-subtle">Teammates answer from what the team&apos;s boundaries allow.</span>
          <span id={counterId} className={cn('tnum shrink-0 text-[11.5px] text-subtle', over && 'font-medium text-bad')} data-counter>
            {length} / {QUESTION_MAX}
          </span>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={ask.isPending || problem !== null}>
          <Send aria-hidden />
          {ask.isPending ? 'Sending…' : 'Send'}
        </Button>
        {sent ? (
          <span role="status" className="text-[12px] text-ok" data-sent>
            {sent}
          </span>
        ) : null}
      </div>
      {error ? (
        <p id={errorId} role="alert" className="text-[12px] leading-snug text-bad" data-error>
          {error}
        </p>
      ) : null}
    </form>
  )
}

/** One recipient of an open question: their state, and their answer as plain text. */
function RecipientRow({ member, r }: { member: string; r: RequestRecipient }) {
  const text = answerText(r)
  return (
    <li className="flex flex-col gap-1.5 py-2" data-ask-recipient={member} data-status={r.status}>
      <div className="flex flex-wrap items-center gap-2">
        <Avatar member={member} size="sm" />
        <span className="text-[12.5px] font-medium">{member}</span>
        <StatusPill tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</StatusPill>
      </div>
      {text !== null ? (
        // A teammate's text: a text node only (React escapes it), white space kept.
        <div className="ml-[26px] rounded-md border bg-canvas px-3 py-2 text-[12.5px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]" data-answer>
          {text}
        </div>
      ) : null}
    </li>
  )
}

function AskItem({ req, open, onToggle, now }: { req: MyRequest; open: boolean; onToggle: () => void; now: number }) {
  const detail = useAskDetail(req.id, open)
  const bodyId = useId()
  const at = ms(req.created_at)
  const summary = summaryLine(detail.data)
  const gone = detail.error?.kind === 'not_found'
  return (
    <li className="flex flex-col" data-ask-item={req.id} data-open={open ? 'true' : 'false'}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={onToggle}
        className="flex w-full items-start gap-2 px-4 py-2.5 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/40"
      >
        <ChevronRight
          aria-hidden
          className={cn('mt-0.5 size-4 shrink-0 text-subtle transition-transform motion-reduce:transition-none', open && 'rotate-90')}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="line-clamp-2 text-[13px] leading-snug [overflow-wrap:anywhere]">{req.question_preview}</span>
          <span className="flex flex-wrap items-center gap-x-2 text-[11.5px] text-subtle">
            <span>To {toLabel(req.to)}</span>
            {at !== null ? <span className="tnum">{formatAgo(Math.max(0, now - at))}</span> : null}
            {gone ? <span>Expired</span> : summary ? <span data-ask-summary>{summary}</span> : null}
          </span>
        </span>
      </button>
      <div id={bodyId} hidden={!open} className="px-4 pb-3 pl-10">
        {open ? (
          detail.isPending ? (
            <div className="flex flex-col gap-2" aria-label="Loading the answers">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : gone ? (
            <p className="text-[12.5px] text-subtle">This question has expired; its answers are gone.</p>
          ) : !detail.data ? (
            <p className="text-[12.5px] text-subtle">The answers did not load. They are read again in a moment.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {typeof detail.data.question === 'string' && detail.data.question ? (
                <p className="text-[12.5px] leading-relaxed whitespace-pre-wrap text-subtle [overflow-wrap:anywhere]" data-question>
                  {detail.data.question}
                </p>
              ) : null}
              <ul className="divide-y divide-hairline" aria-label="Answers">
                {recipientsOf(detail.data)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([m, r]) => (
                    <RecipientRow key={m} member={m} r={r} />
                  ))}
              </ul>
            </div>
          )
        ) : null}
      </div>
    </li>
  )
}

function MyQuestions({ openId, setOpenId }: { openId: string | null; setOpenId: (id: string | null) => void }) {
  const mine = useMyRequests()
  const now = useNow()
  if (mine.isPending) {
    return (
      <div className="flex flex-col gap-2 p-4" aria-label="Loading your questions">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    )
  }
  if (mine.error?.kind === 'not_found' && !mine.data) {
    return <p className="px-4 py-5 text-[12.5px] text-subtle">This relay cannot list your questions yet.</p>
  }
  if (!mine.data) {
    return <p className="px-4 py-5 text-[12.5px] text-subtle">Your questions did not load. They are read again in a moment.</p>
  }
  if (mine.data.requests.length === 0) {
    return (
      <p className="px-4 py-5 text-[12.5px] text-subtle" data-ask-empty>
        You have not asked anything yet. Questions you ask here or in Claude Code show up here with their answers.
      </p>
    )
  }
  return (
    <ul className="divide-y divide-hairline" aria-label="Your questions">
      {mine.data.requests.map((r) => (
        <AskItem key={r.id} req={r} open={openId === r.id} onToggle={() => setOpenId(openId === r.id ? null : r.id)} now={now} />
      ))}
    </ul>
  )
}

export function AskPage() {
  const [openId, setOpenId] = useState<string | null>(null)
  return (
    <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
      <Panel id="ask" title="Ask the team">
        <AskForm onAsked={setOpenId} />
      </Panel>
      <Panel id="my-questions" title="Your questions" aside={<span className="text-[12px] text-subtle">The last 20</span>}>
        <MyQuestions openId={openId} setOpenId={setOpenId} />
      </Panel>
    </div>
  )
}
