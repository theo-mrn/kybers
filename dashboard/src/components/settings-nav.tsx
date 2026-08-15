"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Building2,
  Container,
  KeyRound,
  ShieldCheck,
  UserCog,
} from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Icônes résolues côté client.
 *
 * Un composant Lucide n'est pas sérialisable : le passer depuis un Server
 * Component lève. Seule la clé traverse la frontière.
 */
const ICONS = {
  profil: UserCog,
  registries: Container,
  jetons: KeyRound,
  organisations: Building2,
  comptes: ShieldCheck,
} as const;

export type SettingsNavItem = {
  href: string;
  label: string;
  icon: keyof typeof ICONS;
  /** Racine des paramètres : sans égalité stricte, elle resterait toujours
   *  active puisque toutes les autres routes en descendent. */
  exact?: boolean;
};

/** Navigation latérale des paramètres ; horizontale sur petit écran. */
export function SettingsNav({ items }: { items: SettingsNavItem[] }) {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Paramètres"
      className="flex shrink-0 gap-1 overflow-x-auto border-b border-border pb-2 lg:w-56 lg:flex-col lg:border-b-0 lg:pb-0"
    >
      {items.map((item) => {
        const active = item.exact
          ? pathname === item.href
          : pathname.startsWith(item.href);
        const Icon = ICONS[item.icon];

        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-2 rounded-md px-3 py-2 text-sm whitespace-nowrap transition-colors",
              active
                ? "bg-muted font-medium text-foreground"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
            )}
          >
            <Icon className="size-4 shrink-0" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
