// M11 §4: what may be asked, how a recipient's state and answer read, how often a question is
// read again (3 s open, 30 s closed), the refusals in words, and reading my-requests safely.

import { describe, expect, it } from 'vitest'

import { ChangeError } from '@/api/client'
import type { RecipientStatus, RequestDetail } from '@/api/types'
import {
  acceptRefusal,
  answerText,
  ASK_CLOSED_MS,
  ASK_OPEN_MS,
  askPollMs,
  askProblem,
  askRefusal,
  questionLength,
  readMyRequests,
  recipientsOf,
  summaryLine,
  toLabel,
} from './ask'

function detail(statuses: Record<string, RecipientStatus>): RequestDetail {
  return {
    request_id: `rq_${'a'.repeat(32)}`,
    kind: 'question',
    asker: 'alice',
    broadcast: false,
    question: 'q',
    capability: null,
    created_at: '2026-11-10T10:00:00Z',
    ack_deadline: '2026-11-10T10:02:00Z',
    answer_deadline: '2026-11-10T10:30:00Z',
    expire_at: '2026-11-17T10:00:00Z',
    recipients: Object.fromEntries(Object.entries(statuses).map(([m, status]) => [m, { status, acked_at: null, answered_at: null }])),
    progress: [],
  }
}

describe('askProblem', () => {
  it('needs someone to ask and a question of 1 to 8000 characters', () => {
    expect(askProblem([], 'q')).toBe('Choose who to ask.')
    expect(askProblem('*', '   ')).toBe('Type a question.')
    expect(askProblem(['bob'], 'x'.repeat(8001))).toMatch(/at most 8000/)
    expect(askProblem(['bob'], '\u{1F600}'.repeat(8000))).toBeNull()
    expect(askProblem(Array.from({ length: 65 }, (_, i) => `m${i}`), 'q')).toMatch(/at most 64/)
    expect(askProblem('*', 'Where is it?')).toBeNull()
    expect(questionLength('\u{1F600}a')).toBe(2)
  })
})

describe('reading a question', () => {
  it('labels the recipients and sums them up', () => {
    expect(toLabel('*')).toBe('Everyone')
    expect(toLabel(['bob', 'carol'])).toBe('bob, carol')
    expect(summaryLine(detail({ bob: 'answered', carol: 'acked' }))).toBe('1 of 2 answered, 1 still working')
    expect(summaryLine(detail({ bob: 'answered', carol: 'no_response' }))).toBe('1 of 2 answered')
    expect(summaryLine(detail({ bob: 'pending' }))).toBe('Not acknowledged yet')
    expect(summaryLine(undefined)).toBeNull()
  })
  it('the full answer wins over the preview; none before an answer', () => {
    expect(answerText({ status: 'answered', answer_preview: 'short', answer: 'short and long' })).toBe('short and long')
    expect(answerText({ status: 'answered', answer_preview: 'short', answer: null })).toBe('short')
    expect(answerText({ status: 'acked' })).toBeNull()
  })
  it('keeps recipients with a known status only', () => {
    const d = detail({ bob: 'answered' })
    ;(d.recipients as Record<string, unknown>).zed = { status: 'weird' }
    ;(d.recipients as Record<string, unknown>).yan = null
    expect(recipientsOf(d).map(([m]) => m)).toEqual(['bob'])
    expect(recipientsOf({ ...d, recipients: undefined as never })).toEqual([])
  })
})

describe('askPollMs: 3 s while open, 30 s while closed (M11 §4)', () => {
  it('open: every 3 s until everyone has answered (late answers can still come)', () => {
    expect(askPollMs(undefined, true)).toBe(ASK_OPEN_MS)
    expect(askPollMs(detail({ bob: 'acked' }), true)).toBe(3_000)
    expect(askPollMs(detail({ bob: 'no_response' }), true)).toBe(3_000)
    expect(askPollMs(detail({ bob: 'answered', carol: 'answered' }), true)).toBe(false)
  })
  it('closed: every 30 s while someone has yet to acknowledge or answer', () => {
    expect(askPollMs(undefined, false)).toBe(ASK_CLOSED_MS)
    expect(askPollMs(detail({ bob: 'pending' }), false)).toBe(30_000)
    expect(askPollMs(detail({ bob: 'answered', carol: 'acked' }), false)).toBe(30_000)
    expect(askPollMs(detail({ bob: 'answered', carol: 'timed_out' }), false)).toBe(false)
  })
})

describe('refusals in words', () => {
  const relay = (relayStatus: number, relayError: string, detail: string | null = null) =>
    new ChangeError('x', { status: 502, relayStatus, relayError, detail })
  it('a question', () => {
    expect(askRefusal(relay(400, 'bad_recipients', "'to' names someone who is not in your team."))).toBe("'to' names someone who is not in your team.")
    expect(askRefusal(relay(429, 'rate_limited'))).toMatch(/Wait a minute/)
    expect(askRefusal(relay(403, 'forbidden'))).toMatch(/Ask from Claude Code instead/)
    expect(askRefusal(new ChangeError('The console server did not answer.'))).toBe('The console server did not answer.')
  })
  it('an acceptance', () => {
    expect(acceptRefusal(relay(409, 'version_conflict'))).toMatch(/changed while you were reading/)
    expect(acceptRefusal(relay(409, 'not_set'))).toMatch(/not set any more/)
  })
})

describe('readMyRequests', () => {
  it('keeps well-formed entries; not that answer is null', () => {
    const out = readMyRequests({
      requests: [
        { id: `rq_${'b'.repeat(32)}`, to: '*', created_at: '2026-11-10T10:00:00Z', question_preview: 'q1' },
        { id: `rq_${'c'.repeat(32)}`, to: ['bob', 'Bad!'], created_at: '2026-11-10T09:00:00Z', question_preview: 'q2' },
        { id: 'nope', to: '*', created_at: 'x', question_preview: 'q3' },
        { id: `rq_${'d'.repeat(32)}`, to: 'bob', created_at: 'x', question_preview: 'q4' },
      ],
    })!
    expect(out.requests).toEqual([
      { id: `rq_${'b'.repeat(32)}`, to: '*', created_at: '2026-11-10T10:00:00Z', question_preview: 'q1' },
      { id: `rq_${'c'.repeat(32)}`, to: ['bob'], created_at: '2026-11-10T09:00:00Z', question_preview: 'q2' },
    ])
    expect(readMyRequests({ requests: 'x' })).toBeNull()
    expect(readMyRequests(null)).toBeNull()
  })
})
