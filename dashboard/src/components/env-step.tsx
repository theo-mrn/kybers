"use client";

import * as React from "react";
import { useState } from "react";
import { Eye, EyeOff, KeyRound, Plus, Trash2, Variable } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * Une entrée de configuration.
 *
 * Deux natures, deux destinations : une variable est injectée au conteneur et
 * reste lisible dans le dashboard ; un secret part chiffré sur GitHub, où seul
 * le workflow le lira. Les confondre exposerait un mot de passe dans une liste
 * consultable, ou priverait le CI de ce dont il a besoin.
 */
export type EnvEntry = {
  id: string;
  key: string;
  value: string;
  secret: boolean;
};

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Valide une clé d'environnement ; `null` si elle est utilisable. */
export function checkKey(key: string, others: string[]): string | null {
  const k = key.trim();
  if (!k) return null; // ligne encore vide : pas encore une erreur
  if (!KEY_RE.test(k))
    return "Lettres, chiffres et tirets bas ; ne commence pas par un chiffre.";
  if (others.filter((o) => o.trim() === k).length > 1)
    return "Cette clé apparaît deux fois.";
  return null;
}

/**
 * Saisie des variables et secrets de l'application.
 *
 * Les valeurs sont demandées ici plutôt qu'après coup : un service a besoin de
 * son URL de base de données pour démarrer, et un workflow de son jeton de
 * registre dès sa première exécution.
 */
export function EnvStep({
  entries,
  onChange,
  repo,
}: {
  entries: EnvEntry[];
  onChange: (entries: EnvEntry[]) => void;
  /** Dépôt retenu ; sans lui, les secrets n'ont nulle part où aller. */
  repo: string;
}) {
  const [shown, setShown] = useState<Set<string>>(new Set());

  const keys = entries.map((e) => e.key);

  function update(id: string, patch: Partial<EnvEntry>) {
    onChange(entries.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  }

  function add(secret: boolean) {
    onChange([
      ...entries,
      { id: crypto.randomUUID(), key: "", value: "", secret },
    ]);
  }

  return (
    <div className="flex flex-col gap-3">
      {entries.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-4 py-8 text-center">
          <Variable className="size-6 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium">Aucune configuration</p>
            <p className="text-xs text-muted-foreground">
              Vous pourrez en ajouter plus tard depuis l&apos;application.
            </p>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {entries.map((e) => {
            const error = checkKey(e.key, keys);
            const visible = shown.has(e.id) || !e.secret;

            return (
              <div key={e.id} className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <Input
                    value={e.key}
                    onChange={(ev) =>
                      update(e.id, { key: ev.target.value.toUpperCase() })
                    }
                    placeholder="DATABASE_URL"
                    aria-label="Clé"
                    aria-invalid={Boolean(error)}
                    className="h-9 w-56 font-mono text-xs"
                  />

                  <Input
                    value={e.value}
                    onChange={(ev) => update(e.id, { value: ev.target.value })}
                    placeholder="valeur"
                    aria-label="Valeur"
                    type={visible ? "text" : "password"}
                    className="h-9 min-w-0 flex-1 font-mono text-xs"
                  />

                  {/* Le type se change en cours de saisie : on découvre parfois
                      qu'une valeur est sensible après l'avoir tapée. */}
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    title={
                      e.secret
                        ? "Secret GitHub — cliquer pour en faire une variable"
                        : "Variable du conteneur — cliquer pour en faire un secret"
                    }
                    onClick={() => update(e.id, { secret: !e.secret })}
                    className={cn(
                      "shrink-0 gap-1",
                      e.secret ? "text-primary" : "text-muted-foreground",
                    )}
                  >
                    {e.secret ? (
                      <KeyRound className="size-3" />
                    ) : (
                      <Variable className="size-3" />
                    )}
                    {e.secret ? "secret" : "variable"}
                  </Button>

                  {e.secret && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={visible ? "Masquer" : "Afficher"}
                      onClick={() =>
                        setShown((s) => {
                          const next = new Set(s);
                          if (next.has(e.id)) next.delete(e.id);
                          else next.add(e.id);
                          return next;
                        })
                      }
                      className="shrink-0 text-muted-foreground"
                    >
                      {visible ? (
                        <EyeOff className="size-3.5" />
                      ) : (
                        <Eye className="size-3.5" />
                      )}
                    </Button>
                  )}

                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Retirer ${e.key || "cette entrée"}`}
                    onClick={() =>
                      onChange(entries.filter((x) => x.id !== e.id))
                    }
                    className="shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>

                {error && (
                  <p className="pl-1 text-xs text-destructive" role="alert">
                    {error}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => add(false)}>
          <Plus className="size-3.5" />
          Variable
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => add(true)}>
          <Plus className="size-3.5" />
          Secret
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        Les <strong className="text-foreground">variables</strong> sont
        injectées dans le conteneur au déploiement. Les{" "}
        <strong className="text-foreground">secrets</strong> partent chiffrés
        {repo ? (
          <>
            {" "}
            dans <span className="font-mono text-foreground">{repo}</span>
          </>
        ) : (
          " sur le dépôt"
        )}{" "}
        et ne sont plus relisibles ensuite.
      </p>

      {!repo && entries.some((e) => e.secret) && (
        <p className="text-xs text-destructive" role="alert">
          Aucun dépôt rattaché : les secrets n&apos;ont nulle part où être
          écrits. Ils seront ignorés.
        </p>
      )}
    </div>
  );
}

/** Sépare les entrées valides selon leur destination. */
export function splitEnv(entries: EnvEntry[]) {
  const clean = entries
    .map((e) => ({ ...e, key: e.key.trim() }))
    .filter((e) => e.key && KEY_RE.test(e.key));

  return {
    vars: clean.filter((e) => !e.secret).map(({ key, value }) => ({ key, value })),
    secrets: clean.filter((e) => e.secret).map(({ key, value }) => ({ key, value })),
  };
}
