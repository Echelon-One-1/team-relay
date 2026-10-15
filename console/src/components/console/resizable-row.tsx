import { useCallback, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'

import { readStored, writeStored } from '@/lib/stored'
import { cn } from '@/lib/utils'

// The Team map and Agents row, with a handle under it that drags the row taller or shorter
// (or the arrow keys, on the focused handle). Until the viewer drags, the row keeps its natural
// height; a double-click on the handle goes back to it. The height is remembered in this
// browser. Only the two-column layout is resized: stacked on a narrow screen, each panel keeps
// its own height and the handle is not shown.

export const ROW_HEIGHT_STORAGE_KEY = 'team-relay-console.map-height'
export const ROW_MIN = 240
export const ROW_MAX = 1200
const KEY_STEP = 24

const clamp = (h: number) => Math.round(Math.min(ROW_MAX, Math.max(ROW_MIN, h)))

function storedHeight(): number | null {
  const v = Number.parseInt(readStored(ROW_HEIGHT_STORAGE_KEY) ?? '', 10)
  return Number.isFinite(v) ? clamp(v) : null
}

export function ResizableRow({ className, children }: { className?: string; children: (sized: boolean) => ReactNode }) {
  const row = useRef<HTMLDivElement>(null)
  const drag = useRef<{ y: number; h: number } | null>(null)
  const [height, setHeight] = useState<number | null>(storedHeight)

  const natural = () => clamp(row.current?.getBoundingClientRect().height ?? ROW_MIN)
  const commit = useCallback((h: number | null) => {
    setHeight(h)
    writeStored(ROW_HEIGHT_STORAGE_KEY, h === null ? null : String(h))
  }, [])

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { y: e.clientY, h: height ?? natural() }
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return
    setHeight(clamp(drag.current.h + e.clientY - drag.current.y))
  }
  const onPointerEnd = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return
    drag.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    if (height !== null) commit(height)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const delta = e.key === 'ArrowDown' ? KEY_STEP : e.key === 'ArrowUp' ? -KEY_STEP : 0
    if (delta !== 0) {
      e.preventDefault()
      commit(clamp((height ?? natural()) + delta))
    } else if (e.key === 'Escape' && height !== null) {
      e.preventDefault()
      commit(null)
    }
  }

  return (
    <div className="flex min-w-0 flex-col">
      <div
        ref={row}
        className={cn(className, height !== null && 'lg:h-(--row-h) lg:grid-rows-[minmax(0,1fr)]')}
        style={height !== null ? ({ '--row-h': `${height}px` } as CSSProperties) : undefined}
        data-row-height={height ?? 'auto'}
      >
        {children(height !== null)}
      </div>
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize the team map and agents"
        aria-valuemin={ROW_MIN}
        aria-valuemax={ROW_MAX}
        aria-valuenow={height ?? undefined}
        tabIndex={0}
        title="Drag to resize. Double-click to reset."
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onKeyDown={onKeyDown}
        onDoubleClick={() => commit(null)}
        className="group -mb-4 hidden h-4 cursor-row-resize touch-none items-center justify-center rounded-full outline-none select-none lg:flex"
        data-row-handle
      >
        <span
          aria-hidden
          className="h-1 w-12 rounded-full bg-border transition-colors group-hover:bg-subtle group-focus-visible:bg-ring group-active:bg-signal"
        />
      </div>
    </div>
  )
}
