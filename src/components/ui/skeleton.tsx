import { cn } from "@/lib/theme/utils"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-overlay", className)}
      {...props}
    />
  )
}

export { Skeleton }
