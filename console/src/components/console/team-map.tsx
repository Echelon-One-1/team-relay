import { useEffect, useMemo, useRef, useState } from 'react'

import type { ActivityRequest, DirectoryMember } from '@/api/types'
import { flights, type Flight } from '@/lib/activity'
import { PRESENCE_LABEL, presenceOf, type Presence } from '@/lib/presence'
import { cn } from '@/lib/utils'
import { Panel } from './primitives'

// The team map (M2 §5, the hero): members as nodes, an edge animating while a request is
// in flight between two of them, in the direction it is travelling. Rings show session
// presence: the outer ring is the answering session, the inner ring the working session.

interface Geometry {
  w: number
  h: number
  cx: number
  cy: number
  rx: number
  ry: number
}

// Wide panels get a wide ellipse; a phone-width panel a tighter one, so that text inside
// the drawing stays at its real size instead of being scaled down with the viewBox.
const WIDE: Geometry = { w: 520, h: 270, cx: 240, cy: 135, rx: 200, ry: 104 }
const NARROW: Geometry = { w: 340, h: 280, cx: 150, cy: 136, rx: 105, ry: 104 }

const NODE_R = 19
const INNER_R = 24
const OUTER_R = 29.5

interface Point {
  x: number
  y: number
}

export interface MapMember {
  member: string
  you: boolean
  working: Presence | null
  answering: Presence | null
  open: number
}

function layout(n: number, { cx: CX, cy: CY, rx: RX, ry: RY }: Geometry): Point[] {
  if (n === 1) return [{ x: CX, y: CY }]
  if (n === 2) return [{ x: CX - RX, y: CY }, { x: CX + RX, y: CY }]
  // The viewer sits on the left; teammates go round the ellipse from there. The ring is
  // then centred on its bounding box, so three members make a balanced triangle.
  const pts = Array.from({ length: n }, (_, i) => {
    const a = Math.PI + (i * 2 * Math.PI) / n
    return { x: CX + RX * Math.cos(a), y: CY + RY * Math.sin(a) }
  })
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  const dx = CX - (Math.min(...xs) + Math.max(...xs)) / 2
  const dy = CY - (Math.min(...ys) + Math.max(...ys)) / 2
  return pts.map((p) => ({ x: p.x + dx, y: p.y + dy }))
}

const LANE = { out: 24, back: 46 } as const

function curve(a: Point, b: Point, lane: number) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy) || 1
  const ux = dx / len
  const uy = dy / len
  // Perpendicular to the left of the direction of travel, so A→B and B→A never overlap.
  const nx = uy
  const ny = -ux
  const start = { x: a.x + ux * (OUTER_R + 5), y: a.y + uy * (OUTER_R + 5) }
  const end = { x: b.x - ux * (OUTER_R + 9), y: b.y - uy * (OUTER_R + 9) }
  const c = { x: (a.x + b.x) / 2 + nx * lane, y: (a.y + b.y) / 2 + ny * lane }
  const mid = {
    x: 0.25 * start.x + 0.5 * c.x + 0.25 * end.x,
    y: 0.25 * start.y + 0.5 * c.y + 0.25 * end.y,
  }
  return { d: `M ${start.x.toFixed(1)} ${start.y.toFixed(1)} Q ${c.x.toFixed(1)} ${c.y.toFixed(1)} ${end.x.toFixed(1)} ${end.y.toFixed(1)}`, mid }
}

function ringClass(p: Presence | null): string {
  switch (p) {
    case 'online':
      return 'stroke-ok'
    case 'idle':
      return 'stroke-warn'
    case 'offline':
      return 'stroke-faint'
    default:
      return 'stroke-border'
  }
}

function describe(members: MapMember[], fl: Flight[]): string {
  const people = members
    .map((m) =>
      m.you
        ? `${m.member} (you)`
        : `${m.member}: answering session ${PRESENCE_LABEL[m.answering ?? 'offline'].toLowerCase()}, working session ${PRESENCE_LABEL[m.working ?? 'offline'].toLowerCase()}`,
    )
    .join('; ')
  const moving =
    fl.length === 0
      ? 'Nothing in flight.'
      : fl
          .map((f) =>
            f.direction === 'out'
              ? `${f.requestIds.length} request${f.requestIds.length > 1 ? 's' : ''} from ${f.from} to ${f.to}`
              : `${f.requestIds.length} answer${f.requestIds.length > 1 ? 's' : ''} from ${f.from} back to ${f.to}`,
          )
          .join('; ') + '.'
  return `${people}. ${moving}`
}

export function mapMembers(me: string, teammates: string[], directory: DirectoryMember[] | undefined, now: number): MapMember[] {
  const byName = new Map((directory ?? []).map((d) => [d.member, d]))
  const names = [me, ...[...new Set([...teammates, ...byName.keys()])].filter((m) => m !== me).sort()]
  return names.map((member) => {
    const d = byName.get(member)
    return {
      member,
      you: member === me,
      working: d ? presenceOf(d.sessions.working.last_seen, now) : null,
      answering: d ? presenceOf(d.sessions.answering.last_seen, now) : null,
      open: d?.stats.open ?? 0,
    }
  })
}

export function TeamMap({
  members,
  requests,
  stale = false,
  fill = false,
  className,
}: {
  members: MapMember[]
  requests: ActivityRequest[]
  /** The relay stopped answering: what is drawn is the last known state, so it holds still. */
  stale?: boolean
  /** The panel has a set height (dragged by the viewer): the drawing scales to fill it. */
  fill?: boolean
  className?: string
}) {
  const fl = useMemo(() => flights(requests), [requests])
  const box = useRef<HTMLDivElement>(null)
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    const el = box.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([entry]) => setNarrow((entry?.contentRect.width ?? 999) < 480))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const geo = narrow ? NARROW : WIDE
  const pos = useMemo(() => {
    const pts = layout(members.length, geo)
    return new Map(members.map((m, i) => [m.member, pts[i] ?? { x: geo.cx, y: geo.cy }]))
  }, [members, geo])

  const pairs: [Point, Point][] = []
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      const a = pos.get(members[i]?.member ?? '')
      const b = pos.get(members[j]?.member ?? '')
      if (a && b) pairs.push([a, b])
    }
  }

  const inFlight = fl.reduce((n, f) => n + f.requestIds.length, 0)
  const summary = describe(members, fl)

  return (
    <Panel
      id="team-map"
      title="Team map"
      className={className}
      aside={
        <span className={cn('tnum text-[12px]', inFlight > 0 ? 'text-signal' : 'text-subtle')}>
          {inFlight === 0 ? 'Quiet' : `${inFlight} in flight`}
        </span>
      }
      bodyClassName="flex flex-col"
    >
      <div ref={box} className={cn('relative flex flex-1 items-center px-2 py-2 transition-opacity', fill && 'min-h-0', stale && 'map-stale opacity-55')}>
        <svg
          viewBox={`0 0 ${geo.w} ${geo.h}`}
          role="img"
          aria-labelledby="team-map-desc"
          preserveAspectRatio="xMidYMid meet"
          className={cn(
            'block select-none',
            fill ? 'absolute top-2 left-2 h-[calc(100%-1rem)] w-[calc(100%-1rem)]' : 'h-auto max-h-[330px] w-full',
          )}
        >
          <desc id="team-map-desc">{summary}</desc>
          <defs>
            <marker id="arrow-out" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="4.5" markerHeight="4.5" orient="auto-start-reverse">
              <path d="M 0 1 L 8 5 L 0 9 z" className="fill-signal" />
            </marker>
            <marker id="arrow-back" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="4.5" markerHeight="4.5" orient="auto-start-reverse">
              <path d="M 0 1 L 8 5 L 0 9 z" className="fill-ok" />
            </marker>
          </defs>

          {/* The topology: every pair can talk. */}
          <g aria-hidden>
            {pairs.map(([a, b], i) => (
              <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="stroke-border" strokeWidth={1} />
            ))}
          </g>

          {/* Traffic in flight. */}
          <g aria-hidden>
            {fl.map((f) => {
              const a = pos.get(f.from)
              const b = pos.get(f.to)
              if (!a || !b) return null
              const { d, mid } = curve(a, b, LANE[f.direction])
              const out = f.direction === 'out'
              const n = f.requestIds.length
              return (
                <g key={`${f.from}-${f.to}-${f.direction}`} data-flight={`${f.from}>${f.to}:${f.direction}`}>
                  <path d={d} className={cn('fill-none', out ? 'stroke-signal/15' : 'stroke-ok/15')} strokeWidth={4} strokeLinecap="round" />
                  <path
                    d={d}
                    className={cn('edge-flow fill-none', out ? 'stroke-signal' : 'stroke-ok')}
                    strokeWidth={2.2}
                    strokeLinecap="round"
                    markerEnd={`url(#${out ? 'arrow-out' : 'arrow-back'})`}
                  />
                  {n > 1 || f.broadcast ? (
                    <g transform={`translate(${mid.x.toFixed(1)} ${mid.y.toFixed(1)})`}>
                      <rect x={f.broadcast && n === 1 ? -13 : -10} y={-8} width={f.broadcast && n === 1 ? 26 : 20} height={16} rx={8} className={cn('stroke-1', out ? 'fill-card stroke-signal/50' : 'fill-card stroke-ok/50')} />
                      <text textAnchor="middle" dominantBaseline="central" className={cn('tnum text-[10px] font-semibold', out ? 'fill-signal' : 'fill-ok')}>
                        {f.broadcast && n === 1 ? 'all' : n}
                      </text>
                    </g>
                  ) : null}
                </g>
              )
            })}
          </g>

          {/* Members. */}
          <g>
            {members.map((m) => {
              const p = pos.get(m.member)
              if (!p) return null
              return (
                <g key={m.member} transform={`translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`} data-member={m.member}>
                  {m.answering === 'online' ? (
                    <circle r={OUTER_R} className="presence-pulse fill-none stroke-ok" strokeWidth={2} />
                  ) : null}
                  {m.you && m.answering === null ? (
                    <circle r={OUTER_R - 2.5} className="fill-none stroke-foreground/25" strokeWidth={1} strokeDasharray="1 3" />
                  ) : (
                    <>
                      <circle
                        r={OUTER_R}
                        className={cn('fill-none', ringClass(m.answering))}
                        strokeWidth={2.5}
                        strokeDasharray={m.answering === 'offline' ? '2 3.2' : undefined}
                      />
                      <circle
                        r={INNER_R}
                        className={cn('fill-none', ringClass(m.working))}
                        strokeWidth={2.5}
                        strokeDasharray={m.working === 'offline' ? '2 3.2' : undefined}
                      />
                    </>
                  )}
                  <circle r={NODE_R} className={m.you ? 'fill-foreground' : 'fill-card stroke-border'} strokeWidth={1} />
                  <text
                    textAnchor="middle"
                    dominantBaseline="central"
                    className={cn('text-[14px] font-semibold uppercase', m.you ? 'fill-background' : 'fill-foreground')}
                  >
                    {m.member.slice(0, 1)}
                  </text>
                  <NodeLabel member={m} side={p.x > geo.cx + 10 ? 'right' : 'below'} />
                </g>
              )
            })}
          </g>
        </svg>
      </div>
      <MapLegend />
    </Panel>
  )
}

/**
 * One word or two for both sessions, matching the two rings: the better of the two, and
 * "not answering" when only the working session is there (the inner ring is green, the
 * outer one is not).
 */
export function presenceSummary(working: Presence | null, answering: Presence | null): string {
  const rank: Record<Presence, number> = { offline: 0, idle: 1, online: 2 }
  const w = working ?? 'offline'
  const a = answering ?? 'offline'
  const best = rank[w] >= rank[a] ? w : a
  if (best === 'offline') return 'offline'
  const label = PRESENCE_LABEL[best].toLowerCase()
  return a === 'offline' ? `${label}, not answering` : label
}

/** Right-hand nodes are labelled to their right, so edges between them never cross a label. */
function NodeLabel({ member: m, side }: { member: MapMember; side: 'right' | 'below' }) {
  const sub = m.you ? 'you' : m.open > 0 ? `${m.open} open` : presenceSummary(m.working, m.answering)
  const x = side === 'right' ? OUTER_R + 9 : 0
  const y = side === 'right' ? -3 : OUTER_R + 16
  const anchor = side === 'right' ? 'start' : 'middle'
  return (
    <>
      <text x={x} y={y} textAnchor={anchor} className="fill-foreground text-[12.5px] font-medium">
        {m.member}
      </text>
      <text x={x} y={y + 14} textAnchor={anchor} className="tnum fill-subtle text-[11px]">
        {sub}
      </text>
    </>
  )
}

function MapLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-hairline px-4 py-2.5 text-[11.5px] text-subtle">
      <span className="inline-flex items-center gap-1.5">
        <svg viewBox="0 0 22 8" aria-hidden className="h-2 w-[22px]">
          <line x1="1" y1="4" x2="21" y2="4" className="stroke-signal" strokeWidth="2.4" strokeLinecap="round" strokeDasharray="2 5" />
        </svg>
        Question or call out
      </span>
      <span className="inline-flex items-center gap-1.5">
        <svg viewBox="0 0 22 8" aria-hidden className="h-2 w-[22px]">
          <line x1="1" y1="4" x2="21" y2="4" className="stroke-ok" strokeWidth="2.4" strokeLinecap="round" strokeDasharray="2 5" />
        </svg>
        Answer back
      </span>
      <span className="inline-flex items-center gap-1.5">
        <svg viewBox="0 0 16 16" aria-hidden className="size-3.5">
          <circle cx="8" cy="8" r="6.5" className="fill-none stroke-subtle" strokeWidth="1.5" />
          <circle cx="8" cy="8" r="3.5" className="fill-none stroke-subtle/50" strokeWidth="1.5" />
        </svg>
        Outer ring answering, inner ring working
      </span>
      <span className="inline-flex items-center gap-3 sm:ml-auto">
        <LegendDot className="bg-ok" label="Online" />
        <LegendDot className="bg-warn" label="Idle" />
        <LegendDot className="border border-faint" label="Offline" />
      </span>
    </div>
  )
}

function LegendDot({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className={cn('size-2 rounded-full', className)} />
      {label}
    </span>
  )
}
