"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ExternalLink } from "lucide-react";

import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { SearchCommand } from "@/components/search-command";

/** Libellé de la section courante, dérivé du premier segment de l'URL. */
const SECTIONS: Record<string, string> = {
  "": "Applications",
  apps: "Applications",
  modeles: "Modèles",
  infra: "Infrastructure",
  parametres: "Paramètres",
};

export function Topbar() {
  const pathname = usePathname();
  const segment = pathname.split("/")[1] ?? "";
  const section = SECTIONS[segment] ?? "Kybers";
  const { isMobile } = useSidebar();

  return (
    <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b border-border/60 bg-background/80 px-4 backdrop-blur-md md:px-6">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-1 h-4" />

      <nav aria-label="Fil d'Ariane" className="min-w-0">
        <Link
          href={`/${segment}`}
          className="truncate text-sm font-medium transition-colors hover:text-primary"
        >
          {section}
        </Link>
      </nav>

      <div className="ml-auto flex items-center gap-2">
        <SearchCommand />
        {!isMobile && (
          <Button
            variant="ghost"
            size="sm"
            // Rendu en <a> : Base UI exige de désactiver la sémantique native
            // de bouton, sinon il avertit en console.
            nativeButton={false}
            render={
              <a
                href="https://kubernetes.io/docs/"
                target="_blank"
                rel="noreferrer"
              />
            }
          >
            Docs
            <ExternalLink className="size-3.5" />
          </Button>
        )}
      </div>
    </header>
  );
}
