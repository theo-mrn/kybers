"use client";

import * as React from "react";
import { useState, useTransition } from "react";
import { Eye, EyeOff, KeyRound, Loader2, Pencil, Save, XCircle } from "lucide-react";

import { putRepoVarsAction, putRepoSecretsAction } from "@/app/actions";
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

/**
 * Modification d'une variable ou d'un secret du dépôt.
 *
 * La clé n'est pas modifiable : GitHub n'a pas d'opération de renommage, et la
 * simuler par suppression puis création ferait disparaître la valeur entre les
 * deux appels. Renommer se fait en ajoutant la nouvelle clé puis en retirant
 * l'ancienne, deux gestes que l'utilisateur maîtrise.
 *
 * Pour un secret, le champ part vide : sa valeur n'est restituée par personne,
 * on la remplace sans jamais la voir.
 */
export function RepoEntryEdit({
  appId,
  name,
  value,
  kind,
  env = "",
}: {
  appId: string;
  name: string;
  /** Valeur actuelle ; absente pour un secret, que GitHub ne restitue pas. */
  value?: string;
  kind: "var" | "secret";
  /** Environnement visé ; vide = niveau dépôt. */
  env?: string;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const [reveal, setReveal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const isSecret = kind === "secret";

  function submit() {
    const data = new FormData();
    data.set("app_id", appId);
    data.set("env", env);
    data.set("vars", `${name}=${draft}`);

    setError(null);
    start(async () => {
      const action = isSecret ? putRepoSecretsAction : putRepoVarsAction;
      const res = await action(null, data);
      if (res?.ok) setOpen(false);
      else setError(res?.message ?? "Échec de l'enregistrement.");
    });
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={`Modifier ${name}`}
        title="Modifier"
        onClick={() => {
          // Repartir de la valeur en base, pas d'une saisie abandonnée.
          setDraft(value ?? "");
          setReveal(false);
          setError(null);
          setOpen(true);
        }}
        className="shrink-0 text-muted-foreground"
      >
        <Pencil className="size-3.5" />
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              Modifier <span className="font-mono">{name}</span>
            </DialogTitle>
            <DialogDescription>
              {isSecret
                ? "Sa valeur actuelle n'est restituée par personne : saisissez la nouvelle, elle remplacera l'ancienne."
                : "La nouvelle valeur remplacera l'actuelle sur le dépôt."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-1.5">
            <Label htmlFor="edit_value">Valeur</Label>
            <div className="flex items-center gap-1">
              <Input
                id="edit_value"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                type={isSecret && !reveal ? "password" : "text"}
                placeholder={isSecret ? "Nouvelle valeur" : "info"}
                autoFocus
                className="font-mono"
              />
              {isSecret && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={reveal ? "Masquer" : "Afficher"}
                  onClick={() => setReveal((r) => !r)}
                  className="shrink-0 text-muted-foreground"
                >
                  {reveal ? (
                    <EyeOff className="size-3.5" />
                  ) : (
                    <Eye className="size-3.5" />
                  )}
                </Button>
              )}
            </div>
            {isSecret && (
              <p className="text-xs text-muted-foreground">
                L&apos;œil montre ce que vous tapez, pas la valeur existante.
              </p>
            )}
          </div>

          {error && (
            <p
              className="flex items-start gap-1.5 text-xs text-destructive"
              role="alert"
            >
              <XCircle className="mt-0.5 size-3.5 shrink-0" />
              {error}
            </p>
          )}

          <DialogFooter>
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
              disabled={pending || (!isSecret && draft === value)}
            >
              {pending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : isSecret ? (
                <KeyRound className="size-3.5" />
              ) : (
                <Save className="size-3.5" />
              )}
              Enregistrer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
