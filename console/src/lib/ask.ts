// M11 §4: asking from the console. What may be sent (the relay's limits), how each recipient's
// state reads, how often a question is read again, and the refusals in plain words.

import type { ChangeError } from '@/api/client'
import type { MyRequest, MyRequests, RecipientStatus, RequestDetail, RequestRecipient } from '@/api/types'

export const QUESTION_MAX = 8000
export const RECIPIENTS_MAX = 64
/** While a question is open on the page, and while it is closed (M11 §4). */
export const ASK_OPEN_MS = 3_000
export const ASK_CLOSED_MS = 30_000

/** Characters as the relay counts them (code points, not UTF-16 units). */
export function questionLength(q: string): number {
  let n = 0
  for (const _ of q) n++
  return n
}

/** Why the question cannot be sent yet, or null. */
export function askProblem(to: '*' | string[], question: string): string | null {
  if (to !== '*' && to.length === 0) return 'Choose who to ask.'
  if (to !== '*' && to.length > RECIPIENTS_MAX) return `Ask at most ${RECIPIENTS_MAX} teammates at once, or everyone.`
  if (question.trim() === '') return 'Type a question.'
  if (questionLength(question) > QUESTION_MAX) return `A question has at most ${QUESTION_MAX} characters.`
  return null
}

/** Everyone, or the names, for a list line. */
export function toLabel(to: '*' | string[]): string {
  if (to === '*') return 'Everyone'
  return to.join(', ')
}

export const STATUS_LABEL: Record<RecipientStatus, string> = {
  pending: 'Not acknowledged yet',
  acked: 'Acknowledged',
  answered: 'Answered',
  no_response: 'No response',
  timed_out: 'Acknowledged, no answer in time',
}

export type StatusTone = 'ok' | 'live' | 'warn' | 'muted'

export const STATUS_TONE: Record<RecipientStatus, StatusTone> = {
  pending: 'muted',
  acked: 'live',
  answered: 'ok',
  no_response: 'warn',
  timed_out: 'warn',
}

const STATUSES = new Set<RecipientStatus>(['pending', 'acked', 'answered', 'no_response', 'timed_out'])
const MEMBER_RE = /^[a-z][a-z0-9_]{1,31}$/

/** GET /api/my-requests, kept to well-formed entries; null when it is not that answer at all. */
export function readMyRequests(raw: unknown): MyRequests | null {
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { requests?: unknown }).requests)) return null
  const out: MyRequest[] = []
  for (const r of (raw as { requests: unknown[] }).requests.slice(0, 50)) {
    if (typeof r !== 'object' || r === null) continue
    const x = r as Record<string, unknown>
    if (typeof x.id !== 'string' || !/^rq_[0-9a-f]{32}$/.test(x.id) || typeof x.created_at !== 'string') continue
    const to = x.to === '*' ? '*' : Array.isArray(x.to) ? x.to.filter((m): m is string => typeof m === 'string' && MEMBER_RE.test(m)) : null
    if (to === null) continue
    out.push({ id: x.id, to, created_at: x.created_at, question_preview: typeof x.question_preview === 'string' ? x.question_preview : '' })
  }
  return { requests: out }
}

/** A request's recipients, kept to those with a known status. */
export function recipientsOf(detail: RequestDetail | undefined): Array<[string, RequestRecipient]> {
  const r = detail?.recipients
  if (typeof r !== 'object' || r === null) return []
  return Object.entries(r).filter(([, v]) => typeof v === 'object' && v !== null && STATUSES.has(v.status))
}

/** The full answer when the relay gives it (M11 §4), else the preview; null before an answer. */
export function answerText(r: RequestRecipient): string | null {
  if (typeof r.answer === 'string' && r.answer !== '') return r.answer
  if (typeof r.answer_preview === 'string' && r.answer_preview !== '') return r.answer_preview
  return null
}

/** One line for a closed question: how many answered, and how many may still. */
export function summaryLine(detail: RequestDetail | undefined): string | null {
  if (!detail) return null
  const all = recipientsOf(detail).map(([, r]) => r)
  if (all.length === 0) return null
  const answered = all.filter((r) => r.status === 'answered').length
  const waiting = all.filter((r) => r.status === 'pending' || r.status === 'acked').length
  if (all.length === 1) {
    const only = all[0]!
    return STATUS_LABEL[only.status]
  }
  const parts = [`${answered} of ${all.length} answered`]
  if (waiting > 0) parts.push(`${waiting} still working`)
  return parts.join(', ')
}

/**
 * How often a question is read again: every 3 s while open, until everyone has answered (a
 * late answer can still come after "no response" or "no answer in time"); every 30 s while
 * closed, only while someone has yet to acknowledge or answer before the deadlines.
 */
export function askPollMs(detail: RequestDetail | undefined, open: boolean): number | false {
  const all = recipientsOf(detail).map(([, r]) => r)
  if (open) return detail && all.length > 0 && all.every((r) => r.status === 'answered') ? false : ASK_OPEN_MS
  if (!detail) return ASK_CLOSED_MS
  return all.some((r) => r.status === 'pending' || r.status === 'acked') ? ASK_CLOSED_MS : false
}

/** A refused question, in words for the form. */
export function askRefusal(err: ChangeError): string {
  if (err.notOnTeam || err.signedOut) return err.message
  if (err.relayStatus === 400 && err.relayError === 'bad_recipients') {
    return err.detail ?? 'Someone you chose is not on the team any more. Choose again.'
  }
  if (err.relayStatus === 429) return 'You have asked a lot just now. Wait a minute, then send it again.'
  if (err.relayStatus === 403) return 'The relay does not let this console ask for you yet. Ask from Claude Code instead.'
  if (err.relayStatus === 404) return 'This relay cannot take questions from the console yet. Ask from Claude Code instead.'
  if (err.status === 400) return err.message
  return err.relayStatus !== null ? 'The relay refused the question. Try again.' : err.message
}

/** A refused acceptance, in words for the Join page. */
export function acceptRefusal(err: ChangeError): string {
  if (err.notOnTeam || err.signedOut) return err.message
  if (err.relayStatus === 409 && err.relayError === 'not_set') return "The team's topic isn't set yet, so there is nothing to accept. Ask a team owner."
  if (err.relayStatus === 409) return "The team's topic changed while you were reading. Read it again below, then click Accept."
  if (err.relayStatus === 429) return 'Too many tries just now. Wait a minute, then click Accept again.'
  if (err.relayStatus === 403 || err.relayStatus === 404) return "Accepting from this page doesn't work for this team yet. Ask a team owner."
  return err.relayStatus !== null ? "That didn't work. Try again." : err.message
}
