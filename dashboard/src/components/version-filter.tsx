"use client";

import * as React from "react";
import { useEffect, useMemo, useState } from "react";
import { Check, Loader2, Search } from "lucide-react";

import { listRuntimeVersionsAction } from "@/app/actions";
import type { RuntimeVersion } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * Choix des versions autorisées pour un type.
 *
 * Un champ texte demandait de connaître par cœur ce que publie l'image et de
 * l'écrire sans faute. Les tags réellement publiés sont proposés à la place :
 * on coche ceux que l'entreprise valide, rien de coché signifie qu'on les
 * accepte tous.
 *
 * Les tags précis (`22.11.0`) figurent à côté des branches (`22`), parce que
 * les deux se défendent : figer un correctif garantit la reproductibilité,
 * suivre une branche récupère les corrections de sécurité.
 */
export function VersionFilter({
  folderId,
  image,
  value,
  onChange,
}: {
  /** Type existant ; absent tant qu'il n'est pas enregistré. */
  folderId?: string;
  /** Image saisie, pour prévenir quand elle manque. */
  image: string;
  /** Versions autorisées, séparées par des virgules. */
  value: string;
  onChange: (v: string) => void;
}) {
  const [versions, setVersions] = useState<RuntimeVersion[] | null>(null);
  const [q, setQ] = useState("");

  const selected = new Set(
    value
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
  );

  // Les versions ne se lisent que pour un type déjà enregistré : la route les
  // tire de son image, qui n'existe pas encore à la création.
  useEffect(() => {
    if (!folderId) return;
    let alive = true;

    (async () => {
      // `all` ignore le filtre du type : sans cela, on ne verrait que ce qui
      // est déjà coché, et rien ne pourrait être ajouté.
      const res = await listRuntimeVersionsAction(folderId, true);
      if (alive) setVersions(res.versions);
    })();

    return () => {
      alive = false;
    };
  }, [folderId]);

  const shown = useMemo(() => {
    if (!versions) return [];
    const needle = q.trim();
    return needle ? versions.filter((v) => v.name.startsWith(needle)) : versions;
  }, [versions, q]);

  function toggle(name: string) {
    const next = new Set(selected);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    onChange([...next].join(", "));
  }

  return (
    <div className="flex flex-col gap-2">
      <input type="hidden" name="versions" value={value} />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-medium">
          Versions proposées à la création
        </span>
        {selected.size > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => onChange("")}
          >
            Tout autoriser
          </Button>
        )}
      </div>

      {!image ? (
        <Notice>Renseignez une image pour voir ses versions.</Notice>
      ) : !folderId ? (
        <Notice>Enregistrez le type pour choisir ses versions.</Notice>
      ) : versions === null ? (
        <Notice>
          <Loader2 className="size-3 animate-spin" />
          Lecture des versions publiées…
        </Notice>
      ) : versions.length === 0 ? (
        <Notice>
          Aucune version lisible pour <span className="font-mono">{image}</span>.
        </Notice>
      ) : (
        <div className="flex flex-col gap-2 rounded-lg border border-border p-2">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Filtrer : 22, 3.12…"
              className="h-8 pl-7 font-mono text-xs"
            />
          </div>

          <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
            {selected.size === 0 && !q && (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">
                Rien de coché : toutes les versions ci-dessous sont proposées.
              </p>
            )}

            {shown.length === 0 ? (
              <p className="px-2 py-4 text-center text-xs text-muted-foreground">
                Aucune version ne commence par « {q} ».
              </p>
            ) : (
              shown.map((v) => {
                const on = selected.has(v.name);
                return (
                  <button
                    key={v.name}
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    onClick={() => toggle(v.name)}
                    className={cn(
                      "flex items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
                      on ? "bg-primary/10" : "hover:bg-muted/60",
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "flex size-4 shrink-0 items-center justify-center rounded border transition-colors",
                        on
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border",
                      )}
                    >
                      {on && <Check className="size-3" />}
                    </span>

                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate font-mono text-xs",
                        on && "font-medium text-primary",
                      )}
                    >
                      {v.name}
                    </span>

                    {/* Un tag sans mineure suit sa branche : le dire évite de
                        croire qu'on fige une version précise. */}
                    {v.floating && (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        suit les correctifs
                      </span>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-center justify-center gap-2 rounded-md border border-dashed border-border px-3 py-3 text-center text-xs text-muted-foreground">
      {children}
    </p>
  );
}
