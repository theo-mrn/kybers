"use client";

import * as React from "react";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Layers, Loader2, Plus, XCircle } from "lucide-react";

import { createRepoEnvAction } from "@/app/actions";
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

/** Noms usuels, proposés pour éviter une divergence entre dépôts. */
const SUGGESTIONS = ["production", "staging", "preview"];

/**
 * Création d'un environnement sur le dépôt.
 *
 * GitHub le crée à la volée au premier secret déposé, mais on veut souvent
 * poser le cloisonnement avant d'avoir une valeur à y mettre — ne serait-ce
 * que pour vérifier que le nom correspond à celui du workflow.
 */
export function NewEnvDialog({
  appId,
  existing,
}: {
  appId: string;
  existing: string[];
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  const clean = name.trim();
  const exists = existing.includes(clean);

  function submit() {
    if (!clean || exists) return;
    setError(null);
    start(async () => {
      const res = await createRepoEnvAction(appId, clean);
      if (!res?.ok) {
        setError(res?.message ?? "Échec de la création.");
        return;
      }
      setOpen(false);
      setName("");
      // Basculer dessus : on vient de le créer pour y déposer quelque chose.
      router.push(`?tab=configuration&env=${encodeURIComponent(clean)}`);
    });
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Nouvel environnement"
        title="Nouvel environnement"
        onClick={() => {
          setName("");
          setError(null);
          setOpen(true);
        }}
        className="text-muted-foreground"
      >
        <Plus className="size-3.5" />
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Nouvel environnement</DialogTitle>
            <DialogDescription>
              Ses secrets ne seront lisibles que par les workflows qui le
              visent. Le nom doit correspondre à celui déclaré dans votre
              pipeline.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-1.5">
            <Label htmlFor="env_name">Nom</Label>
            <Input
              id="env_name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              placeholder="production"
              autoFocus
              aria-invalid={exists}
              className="font-mono"
            />

            <div className="flex flex-wrap gap-1.5 pt-1">
              {SUGGESTIONS.filter((s) => !existing.includes(s)).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setName(s)}
                  className="rounded-md border border-border px-2 py-0.5 font-mono text-xs text-muted-foreground transition-colors hover:bg-muted"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          {(exists || error) && (
            <p
              className="flex items-start gap-1.5 text-xs text-destructive"
              role="alert"
            >
              <XCircle className="mt-0.5 size-3.5 shrink-0" />
              {error ?? `« ${clean} » existe déjà sur ce dépôt.`}
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
              disabled={pending || !clean || exists}
            >
              {pending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Layers className="size-3.5" />
              )}
              Créer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
