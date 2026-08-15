"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Building2,
  Container,
  FileCode,
  KeyRound,
  LayoutGrid,
  Search,
  Server,
  ShieldCheck,
  UserCog,
} from "lucide-react";

import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Button } from "@/components/ui/button";

const DESTINATIONS = [
  {
    group: "Applications",
    items: [
      { href: "/apps", label: "Toutes les applications", icon: LayoutGrid },
      { href: "/modeles", label: "Modèles de fichiers", icon: FileCode },
    ],
  },
  {
    group: "Opérations",
    items: [{ href: "/infra", label: "Infrastructure", icon: Server }],
  },
  {
    group: "Paramètres",
    items: [
      { href: "/parametres", label: "Mon profil", icon: UserCog },
      { href: "/parametres/registries", label: "Registries", icon: Container },
      { href: "/parametres/jetons", label: "Jetons d'API", icon: KeyRound },
      {
        href: "/parametres/organisations",
        label: "Organisations",
        icon: Building2,
      },
      { href: "/parametres/comptes", label: "Comptes", icon: ShieldCheck },
    ],
  },
];

export function SearchCommand() {
  const [open, setOpen] = React.useState(false);
  const router = useRouter();

  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const go = React.useCallback(
    (href: string) => {
      setOpen(false);
      router.push(href);
    },
    [router],
  );

  return (
    <>
      {/* Déclencheur : champ factice sur desktop, icône seule sur mobile où la
          place manque. */}
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        className="hidden h-8 w-56 justify-start gap-2 px-2.5 text-muted-foreground font-normal sm:flex"
      >
        <Search className="size-3.5" />
        <span className="flex-1 text-left">Rechercher…</span>
        <kbd className="pointer-events-none flex h-5 items-center gap-0.5 rounded border border-border bg-muted px-1.5 font-mono text-[10px] font-medium">
          <span className="text-xs">⌘</span>K
        </kbd>
      </Button>

      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Rechercher"
        onClick={() => setOpen(true)}
        className="sm:hidden"
      >
        <Search className="size-4" />
      </Button>

      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="Recherche"
        description="Naviguer dans Kybers"
      >
        {/* `CommandDialog` ne fournit pas le contexte cmdk : c'est `Command`
            qui le pose, et sans lui `CommandInput` échoue au montage. */}
        <Command>
          <CommandInput placeholder="Rechercher une page…" />
          <CommandList>
            <CommandEmpty>Aucun résultat.</CommandEmpty>
            {DESTINATIONS.map((section) => (
              <CommandGroup key={section.group} heading={section.group}>
                {section.items.map((item) => (
                  <CommandItem
                    key={item.href}
                    value={`${section.group} ${item.label}`}
                    onSelect={() => go(item.href)}
                  >
                    <item.icon className="size-4" />
                    <span>{item.label}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </CommandDialog>
    </>
  );
}
