"use client";

import * as React from "react";
import { useState, useTransition } from "react";
import {
  ClipboardPaste,
  KeyRound,
  Loader2,
  Plus,
  Trash2,
  Variable,
  XCircle,
} from "lucide-react";

import { putRepoVarsAction, putRepoSecretsAction } from "@/app/actions";
import { parseEnvPairs } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/** Clé d'environnement valide, telle que GitHub l'accepte. */
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

type Row = { id: string; key: string; value: string };

const blank = (): Row => ({ id: crypto.randomUUID(), key: "", value: "" });

/**
 * Ajout de variables ou de secrets sur le dépôt.
 *
 * Plusieurs lignes à la fois : on récupère rarement une seule valeur, et
 * rouvrir le dialogue à chaque paire était le chemin le plus long vers le cas
 * le plus fréquent.
 *
 * Coller un bloc — `.env`, export shell, extrait de documentation — le répartit
 * sur autant de lignes, plutôt que de tout entasser dans un champ.
 */
export function RepoEntryDialog({
  appId,
  kind,
  taken,
  env = "",
}: {
  appId: string;
  kind: "var" | "secret";
  /** Noms déjà présents : les réécrire remplace leur valeur. */
  taken: string[];
  /** Environnement visé ; vide = niveau dépôt. */
  env?: string;
}) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Row[]>([blank()]);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const isSecret = kind === "secret";

  const filled = rows.filter((r) => r.key.trim());
  const invalid = filled.filter((r) => !KEY_RE.test(r.key.trim()));
  const replaced = filled.filter((r) => taken.includes(r.key.trim()));

  // Une même clé deux fois dans la saisie : la seconde écraserait la première
  // sans que rien ne le montre.
  const seen = new Set<string>();
  const duplicated = filled.filter((r) => {
    const k = r.key.trim();
    if (seen.has(k)) return true;
    seen.add(k);
    return false;
  });

  function update(id: string, patch: Partial<Row>) {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  /**
   * Répartit un collage multi-lignes sur autant de lignes du formulaire.
   *
   * Le collage remplit la ligne courante puis en ajoute : coller dix paires ne
   * doit pas demander dix clics sur « + ».
   */
  function paste(id: string, text: string) {
    const pairs = parseEnvPairs(text);
    if (pairs.length === 0) return false;

    setRows((rs) => {
      const at = rs.findIndex((r) => r.id === id);
      const added = pairs.map((p) => ({ ...blank(), ...p }));
      const next = [...rs.slice(0, at), ...added, ...rs.slice(at + 1)];
      // Une ligne vide en fin de liste, pour enchaîner sans cliquer.
      return next.some((r) => !r.key.trim()) ? next : [...next, blank()];
    });
    return true;
  }

  function reset() {
    setRows([blank()]);
    setError(null);
  }

  function submit() {
    if (filled.length === 0 || invalid.length > 0) return;

    const data = new FormData();
    data.set("app_id", appId);
    data.set("env", env);
    data.set(
      "vars",
      filled.map((r) => `${r.key.trim()}=${r.value}`).join("\n"),
    );

    setError(null);
    start(async () => {
      const action = isSecret ? putRepoSecretsAction : putRepoVarsAction;
      const res = await action(null, data);
      if (res?.ok) {
        reset();
        setOpen(false);
      } else {
        setError(res?.message ?? "Échec de l'enregistrement.");
      }
    });
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          reset();
          setOpen(true);
        }}
      >
        <Plus className="size-3.5" />
        {isSecret ? "Ajouter des secrets" : "Ajouter des variables"}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {isSecret ? "Nouveaux secrets" : "Nouvelles variables"}
            </DialogTitle>
            <DialogDescription>
              {isSecret
                ? "Chiffrés par GitHub à l'enregistrement. Leurs valeurs ne seront plus relisibles."
                : "Lisibles par vos workflows, valeurs comprises."}
            </DialogDescription>
          </DialogHeader>

          <p className="flex shrink-0 items-center gap-1.5 rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
            <ClipboardPaste className="size-3.5 shrink-0" />
            Collez un bloc <code className="font-mono">.env</code> dans
            n&apos;importe quel champ : les paires sont réparties
            automatiquement.
          </p>

          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1">
            <div className="grid grid-cols-[1fr_1fr_auto] gap-2 text-xs text-muted-foreground">
              <Label htmlFor={`k-${rows[0]?.id}`}>Clé</Label>
              <span>Valeur</span>
              <span className="w-7" />
            </div>

            {rows.map((r) => {
              const k = r.key.trim();
              const bad = k && !KEY_RE.test(k);
              const dup = duplicated.some((d) => d.id === r.id);

              return (
                <div
                  key={r.id}
                  className="grid grid-cols-[1fr_1fr_auto] items-center gap-2"
                >
                  <Input
                    id={`k-${r.id}`}
                    value={r.key}
                    onChange={(e) => update(r.id, { key: e.target.value })}
                    onPaste={(e) => {
                      const text = e.clipboardData.getData("text");
                      if (paste(r.id, text)) e.preventDefault();
                    }}
                    placeholder={isSecret ? "DB_PASSWORD" : "LOG_LEVEL"}
                    aria-invalid={Boolean(bad) || dup}
                    className={cn("h-9 font-mono text-xs", (bad || dup) && "border-destructive")}
                  />

                  <Input
                    value={r.value}
                    onChange={(e) => update(r.id, { value: e.target.value })}
                    onPaste={(e) => {
                      const text = e.clipboardData.getData("text");
                      // Un bloc collé dans la valeur est un bloc mal visé : le
                      // répartir vaut mieux que de l'aplatir sur une ligne. On
                      // ne le fait qu'au-delà d'une paire, pour ne pas voler
                      // une valeur qui contient un « = ».
                      if (parseEnvPairs(text).length > 1 && paste(r.id, text)) {
                        e.preventDefault();
                      }
                    }}
                    type={isSecret ? "password" : "text"}
                    placeholder={isSecret ? "••••••" : "info"}
                    className="h-9 font-mono text-xs"
                  />

                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Retirer cette ligne"
                    disabled={rows.length === 1}
                    onClick={() =>
                      setRows((rs) => rs.filter((x) => x.id !== r.id))
                    }
                    className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              );
            })}

            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setRows((rs) => [...rs, blank()])}
              className="self-start"
            >
              <Plus className="size-3.5" />
              Ajouter une ligne
            </Button>

            {(invalid.length > 0 || duplicated.length > 0 || error) && (
              <p
                className="flex items-start gap-1.5 text-xs text-destructive"
                role="alert"
              >
                <XCircle className="mt-0.5 size-3.5 shrink-0" />
                {error ??
                  (duplicated.length > 0
                    ? `${duplicated[0].key.trim()} apparaît deux fois.`
                    : "Clé invalide : lettres, chiffres et tirets bas ; ne commence pas par un chiffre.")}
              </p>
            )}

            {replaced.length > 0 && !error && (
              <p className="text-xs text-muted-foreground">
                {replaced.map((r) => r.key.trim()).join(", ")} existe déjà — sa
                valeur sera remplacée.
              </p>
            )}
          </div>

          <DialogFooter className="shrink-0 border-t border-border pt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
            >
              Annuler
            </Button>
            <Button
              type="button"
              onClick={submit}
              disabled={
                pending || filled.length === 0 || invalid.length > 0 ||
                duplicated.length > 0
              }
            >
              {pending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : isSecret ? (
                <KeyRound className="size-3.5" />
              ) : (
                <Variable className="size-3.5" />
              )}
              Enregistrer
              {filled.length > 1 && ` (${filled.length})`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
