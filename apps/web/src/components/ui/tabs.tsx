// shadcn-style Tabs on the Radix primitive: a tablist with arrow-key movement,
// each trigger linked to its panel. The classes are the prototype's.
import { Tabs as TabsPrimitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "../../lib/cn.ts";

export const Tabs = TabsPrimitive.Root;

export function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return <TabsPrimitive.List className={cn("tabs", className)} {...props} />;
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return <TabsPrimitive.Trigger className={cn("tab", className)} {...props} />;
}

/** The panel lays out as its children (display: contents) so the drawer's column keeps its shape. */
export function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content tabIndex={-1} className={cn("contents", className)} {...props} />;
}
