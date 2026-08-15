"use client";

import * as React from "react";
import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, GitBranch, Trash2, TriangleAlert } from "lucide-react";

import { deleteAppAction, type ActionState } from "@/app/actions";
import type { App } from "@/lib/api";
import { SubmitButton, Feedback } from "@/components/forms";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
 * Suppression d'une application.
 *
 * Le geste emporte des ressources réelles — namespaces, pods, et le dépôt Git
 * si on le demande. Une confirmation par saisie du nom remplace le `confirm()`
 * du navigateur, qui n'expose ni la portée ni les options.
 */
export function DeleteAppDialog({
  app,
  environments,
}: {
  app: App;
  /** Environnements encore déployés : conditionne la cascade. */
  environments: number;
}) {
  const [open, setOpen] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const [deleteRepo, setDeleteRepo] = useState(false);
  const [state, action] = useActionState<ActionState, FormData>(
    deleteAppAction,
    null,
  );
  const router = useRouter();

  // La page courante décrit l'application supprimée : y rester donnerait un
  // 404 au premier rafraîchissement.
  const done = Boolean(state?.ok);
  React.useEffect(() => {
    if (done) router.push("/apps");
  }, [done, router]);

  const isOpen = open && !done;
  // La saisie du nom évite une suppression par inadvertance : le geste est
  // irréversible et emporte le cluster.
  const confirmed = confirmName.trim() === app.name;

  function close() {
    setOpen(false);
    setConfirmName("");
    setDeleteRepo(false);
  }

  return (
    <>
      <Button variant="destructive" size="sm" onClick={() => setOpen(true)}>
        <Trash2 className="size-3.5" />
        Supprimer
      </Button>

      <Dialog open={isOpen} onOpenChange={(o) => (o ? setOpen(true) : close())}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Supprimer « {app.name} »</DialogTitle>
            <DialogDescription>
              Cette action est irréversible.
            </DialogDescription>
          </DialogHeader>

          <form action={action} className="flex flex-col gap-4">
            <input type="hidden" name="app_id" value={app.id} />
            <input
              type="hidden"
              name="cascade"
              value={environments > 0 ? "true" : "false"}
            />
            <input
              type="hidden"
              name="delete_repo"
              value={deleteRepo ? "true" : "false"}
            />

            <div className="space-y-2 rounded-lg border border-destructive/25 bg-destructive/5 p-3 text-xs">
              <p className="flex items-center gap-1.5 font-medium text-destructive">
                <AlertTriangle className="size-3.5" />
                Ce qui sera supprimé
              </p>
              <ul className="space-y-1 text-muted-foreground">
                <li>
                  L&apos;application, ses révisions et son historique de
                  déploiement.
                </li>
                {environments > 0 && (
                  <li>
                    {environments} environnement(s) sur le cluster : namespaces,
                    pods, services et configurations.
                  </li>
                )}
              </ul>
            </div>

            {/* Le dépôt survit par défaut : il contient le code, pas seulement
                le déploiement. */}
            {app.git_repo && (
              <label
                className={
                  deleteRepo
                    ? "flex items-start gap-2.5 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm"
                    : "flex items-start gap-2.5 rounded-lg border border-border p-3 text-sm"
                }
              >
                <input
                  type="checkbox"
                  checked={deleteRepo}
                  onChange={(e) => setDeleteRepo(e.target.checked)}
                  className="mt-0.5 size-4 accent-destructive"
                />
                <span>
                  <span className="flex flex-wrap items-center gap-1.5 font-medium">
                    <GitBranch className="size-3.5" />
                    Supprimer aussi le dépôt
                    <Badge variant="outline" className="font-mono">
                      {app.git_repo}
                    </Badge>
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    Le code, l&apos;historique Git et les issues disparaissent
                    définitivement. Décoché, le dépôt reste intact.
                  </span>
                </span>
              </label>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="confirm_name">
                Saisissez{" "}
                <span className="font-mono text-foreground">{app.name}</span>{" "}
                pour confirmer
              </Label>
              <Input
                id="confirm_name"
                value={confirmName}
                onChange={(e) => setConfirmName(e.target.value)}
                autoComplete="off"
                className="font-mono"
              />
            </div>

            {deleteRepo && (
              <p className="flex items-start gap-1.5 text-xs text-destructive">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                Le dépôt sera supprimé sur GitHub. Cette opération exige la
                portée <code className="font-mono">delete_repo</code> sur le
                jeton de l&apos;instance.
              </p>
            )}

            <Feedback state={state} />

            <DialogFooter>
              <Button type="button" variant="outline" onClick={close}>
                Annuler
              </Button>
              <SubmitButton
                label={deleteRepo ? "Supprimer application et dépôt" : "Supprimer"}
                pendingLabel="Suppression…"
                variant="destructive"
                icon={Trash2}
                disabled={!confirmed}
              />
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
