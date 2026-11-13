import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { Toggle as TogglePrimitive } from "radix-ui"

// Pills. Pressed or on, a toggle is the raised thumb (the thumb colour with a soft shadow) with a
// 1px accent edge and accent text (at least 3:1 against the track; plain text in dark), as the
// selected tab in a segmented track; ToggleGroup draws the track.
const toggleVariants = cva(
  "group/toggle inline-flex items-center justify-center gap-1 rounded-full border border-transparent text-[13px] font-medium whitespace-nowrap text-subtle transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 aria-invalid:ring-destructive/20 aria-pressed:border-signal aria-pressed:bg-thumb aria-pressed:text-signal aria-pressed:shadow-thumb dark:aria-pressed:text-foreground data-[state=on]:border-signal data-[state=on]:bg-thumb data-[state=on]:text-signal data-[state=on]:shadow-thumb dark:data-[state=on]:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-transparent",
        outline: "bg-transparent",
      },
      size: {
        default: "h-8 min-w-8 px-4 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
        sm: "h-7 min-w-7 px-3 text-[12.5px] has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 min-w-9 px-5 has-data-[icon=inline-end]:pr-4 has-data-[icon=inline-start]:pl-4",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Toggle({
  className,
  variant = "default",
  size = "default",
  ...props
}: React.ComponentProps<typeof TogglePrimitive.Root> &
  VariantProps<typeof toggleVariants>) {
  return (
    <TogglePrimitive.Root
      data-slot="toggle"
      className={cn(toggleVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Toggle, toggleVariants }
