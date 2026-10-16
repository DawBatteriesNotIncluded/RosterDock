// shadcn-style Dialog on the Radix primitive: focus stays inside, Escape and a
// click on the overlay close it, the title labels it. Rendered in place rather
// than through a portal, so the headless render tests see it and the overlay's
// own CSS centres the content.
import { Dialog as DialogPrimitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "../../lib/cn.ts";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;
export const DialogDescription = DialogPrimitive.Description;

export function DialogOverlay({ className, ...props }: ComponentProps<typeof DialogPrimitive.Overlay>) {
  return <DialogPrimitive.Overlay className={cn("overlay", className)} {...props} />;
}

export function DialogContent({
  className,
  children,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogOverlay>
      <DialogPrimitive.Content className={cn("modal", className)} {...props}>
        {children}
      </DialogPrimitive.Content>
    </DialogOverlay>
  );
}

export function DialogTitle({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className={cn(className)} {...props} />;
}
