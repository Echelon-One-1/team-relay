import * as React from "react"
import { Dialog as DialogPrimitive } from "radix-ui"
import { XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

// As the Sheet: under the console's CSP (default-src 'self') Radix's Dialog.Overlay would
// inject a <style> element through react-remove-scroll, which the CSP refuses. So the backdrop
// is a plain element; the dialog keeps Radix's focus trap, aria-hidden siblings, Escape and
// outside-click dismissal, and the page's scroll is locked with a class while it is open.

function Dialog({ open, ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  React.useEffect(() => {
    if (!open) return
    document.documentElement.classList.add("overflow-hidden")
    return () => document.documentElement.classList.remove("overflow-hidden")
  }, [open])
  return <DialogPrimitive.Root data-slot="dialog" open={open} {...props} />
}

function DialogContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal>
      <div aria-hidden data-slot="dialog-overlay" className="fixed inset-0 z-50 bg-foreground/15 duration-150 animate-in fade-in-0" />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          "fixed top-[12vh] left-1/2 z-50 flex max-h-[80vh] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 flex-col overflow-y-auto rounded-lg border bg-popover text-popover-foreground shadow-menu outline-none duration-150 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-[0.98] data-closed:animate-out data-closed:fade-out-0",
          className
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close asChild>
          <Button variant="ghost" size="icon-sm" className="absolute top-3 right-3">
            <XIcon />
            <span className="sr-only">Close</span>
          </Button>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title data-slot="dialog-title" className={cn("text-base leading-[22px] font-semibold", className)} {...props} />
}

function DialogDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-[12.5px] leading-relaxed text-subtle", className)}
      {...props}
    />
  )
}

export { Dialog, DialogContent, DialogDescription, DialogTitle }
