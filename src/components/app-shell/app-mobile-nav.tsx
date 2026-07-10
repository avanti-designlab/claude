"use client";

import { useState } from "react";
import { MenuIcon } from "lucide-react";
import { usePathname } from "next/navigation";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { OPERATOR_NAV, OPERATOR_NAV_FOOTER } from "./nav";
import { NavLink } from "./app-sidebar";
import { Wordmark } from "./wordmark";

/**
 * Mobile operator navigation (`< lg`). The hamburger lives in the operator top
 * bar; tapping it opens a left Sheet with the same grouped nav as the desktop
 * sidebar (one source of truth in nav.ts). Selecting a destination closes the
 * sheet. Operator-only — a client_viewer's top bar renders no menu trigger.
 */
export function AppMobileNav() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const close = () => setOpen(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="lg:hidden"
          aria-label="Open navigation"
        >
          <MenuIcon aria-hidden />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="w-72 gap-0 p-0">
        <SheetHeader className="h-16 flex-row items-center border-b border-border px-5">
          <SheetTitle asChild>
            <span>
              <Wordmark />
            </span>
          </SheetTitle>
        </SheetHeader>
        <nav
          aria-label="Primary"
          className="flex flex-1 flex-col gap-6 overflow-y-auto px-3 py-5"
        >
          {OPERATOR_NAV.map((group, i) => (
            <div key={group.label ?? `group-${i}`} className="flex flex-col gap-1">
              {group.label ? (
                <p className="px-3 pb-1 font-mono text-[10px] font-medium tracking-[0.16em] text-muted uppercase">
                  {group.label}
                </p>
              ) : null}
              {group.items.map((item) => (
                <NavLink
                  key={item.href}
                  item={item}
                  pathname={pathname}
                  onNavigate={close}
                />
              ))}
            </div>
          ))}
        </nav>
        <div className="border-t border-border px-3 py-4">
          {OPERATOR_NAV_FOOTER.map((item) => (
            <NavLink
              key={item.href}
              item={item}
              pathname={pathname}
              onNavigate={close}
            />
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}
