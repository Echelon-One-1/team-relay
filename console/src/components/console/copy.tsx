import { Check, Copy } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

// Copying text for the viewer (M11 §6: the setup command, the invite message). The clipboard
// can be refused (no permission, an insecure context, no clipboard at all): the text then shows
// in a box, selected, to copy by hand.

const COPIED_MS = 1600

export function useCopy(text: string) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current)
    },
    [],
  )
  // A different text starts over (the fallback box would show an old one).
  useEffect(() => setState('idle'), [text])
  const copy = async () => {
    let next: 'copied' | 'failed'
    try {
      if (!navigator.clipboard) throw new Error('no clipboard')
      await navigator.clipboard.writeText(text)
      next = 'copied'
    } catch {
      next = 'failed'
    }
    setState(next)
    if (timer.current !== null) clearTimeout(timer.current)
    if (next === 'copied') timer.current = setTimeout(() => setState('idle'), COPIED_MS)
  }
  return { state, copy }
}

/** The text in a box, selected, for when the clipboard refused it. */
export function CopyFallback({ text, label }: { text: string; label: string }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const id = useId()
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const lines = Math.min(8, text.split('\n').length + 1)
  return (
    <div className="flex flex-col gap-1" data-copy-fallback>
      <label htmlFor={id} className="text-[12px] text-subtle">
        Copying did not work here. Select the text and copy it yourself.
      </label>
      <textarea
        id={id}
        ref={ref}
        readOnly
        aria-label={label}
        value={text}
        rows={lines}
        onFocus={(e) => e.currentTarget.select()}
        className="w-full resize-none rounded-sm border border-input bg-field px-2.5 py-1.5 font-mono text-[12px] leading-[1.6] text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring"
      />
    </div>
  )
}

/** A command on one line with a copy button beside it, and the fallback box below when needed. */
export function CopyCommand({ text, label }: { text: string; label: string }) {
  const { state, copy } = useCopy(text)
  return (
    <div className="flex flex-col gap-2">
      <div className="flex min-w-0 items-start gap-1 rounded-md border bg-muted/60 py-1 pr-1 pl-3" data-command={label}>
        <pre className="min-w-0 flex-1 py-0.5 font-mono text-[12px] leading-[1.6] whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]">
          <code>{text}</code>
        </pre>
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={`Copy ${label}`}
          data-copy={state}
          className={cn(
            'inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11.5px] font-medium text-subtle transition-colors hover:bg-card hover:text-foreground',
            state === 'copied' && 'text-ok hover:text-ok',
          )}
        >
          {state === 'copied' ? <Check aria-hidden className="size-3.5" /> : <Copy aria-hidden className="size-3.5" />}
          <span aria-live="polite" className={cn(state !== 'copied' && 'sr-only')}>
            {state === 'copied' ? 'Copied' : ''}
          </span>
        </button>
      </div>
      {state === 'failed' ? <CopyFallback text={text} label={label} /> : null}
    </div>
  )
}

/**
 * The setup line for someone who has never used Terminal: the line in a box and a big "Copy"
 * button beside it (below it on a phone), with the fallback box when the clipboard refuses.
 */
export function BigCopyCommand({ text, label }: { text: string; label: string }) {
  const { state, copy } = useCopy(text)
  return (
    <div className="flex flex-col gap-2">
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-stretch" data-command={label}>
        <pre className="min-w-0 flex-1 rounded-md border bg-muted/60 px-3 py-2 font-mono text-[12.5px] leading-[1.6] whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]">
          <code>{text}</code>
        </pre>
        <Button type="button" size="lg" onClick={() => void copy()} aria-label={`Copy ${label}`} data-copy={state} className="px-4 sm:h-auto">
          {state === 'copied' ? <Check aria-hidden /> : <Copy aria-hidden />}
          <span aria-live="polite">{state === 'copied' ? 'Copied' : 'Copy'}</span>
        </Button>
      </div>
      {state === 'failed' ? <CopyFallback text={text} label={label} /> : null}
    </div>
  )
}

/** A button that copies a longer text (the invite message), with the fallback box below it. */
export function CopyTextButton({ text, label, children }: { text: string; label: string; children: string }) {
  const { state, copy } = useCopy(text)
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" onClick={() => void copy()} data-copy={state}>
          {state === 'copied' ? <Check aria-hidden /> : <Copy aria-hidden />}
          {children}
        </Button>
        <span aria-live="polite" className="text-[12px] text-ok">
          {state === 'copied' ? 'Copied' : ''}
        </span>
      </div>
      {state === 'failed' ? <CopyFallback text={text} label={label} /> : null}
    </div>
  )
}
