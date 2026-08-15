"use client";

import { useActionState } from "react";
import { GitBranch, Info, Link2, Unlink } from "lucide-react";

import { setAppRepoAction, type ActionState } from "@/app/actions";
import { SubmitButton, Feedback } from "@/components/forms";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Rattache un dépôt Git à une application.
 *
 * Le rattachement est vérifié côté serveur avant d'être enregistré : une
 * référence que l'API Git ne sait pas résoudre laisserait la documentation et
 * les pipelines muettes.
 */
export function RepoForm({
  appId,
  repo,
  configured,
}: {
  appId: string;
  repo: string;
  /** Faux quand l'instance n'a pas de jeton Git : le rattachement reste
   *  possible, mais rien ne sera lu. */
  configured: boolean;
}) {
  const [state, action] = useActionState<ActionState, FormData>(
    setAppRepoAction,
    null,
  );

  return (
    <div className="flex flex-col gap-4">
      <form action={action} className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="app_id" value={appId} />

        <div className="min-w-0 flex-1 space-y-1.5">
          <Label htmlFor="repo">Dépôt</Label>
          <Input
            id="repo"
            name="repo"
            key={repo}
            defaultValue={repo}
            placeholder="acme/billing-api"
            className="font-mono"
          />
          <p className="text-xs text-muted-foreground">
            Format <code className="font-mono">owner/nom</code>, ou collez
            l&apos;URL du dépôt.
          </p>
        </div>

        <SubmitButton
          label={repo ? "Mettre à jour" : "Rattacher"}
          pendingLabel="Vérification…"
          icon={Link2}
          size="sm"
        />
      </form>

      {repo && (
        <form action={action} className="flex flex-wrap items-center gap-3">
          <input type="hidden" name="app_id" value={appId} />
          <input type="hidden" name="repo" value="" />
          <SubmitButton
            label="Détacher"
            pendingLabel="…"
            icon={Unlink}
            variant="ghost"
            size="sm"
            confirm="Détacher ce dépôt ? La documentation et les pipelines ne seront plus affichées."
          />
        </form>
      )}

      <Feedback state={state} />

      {!configured && (
        <p className="flex items-start gap-2 rounded-md bg-warning/10 px-3 py-2 text-xs text-warning">
          <Info className="mt-0.5 size-3.5 shrink-0" />
          Aucun jeton Git n&apos;est configuré sur cette instance : le dépôt
          peut être renseigné, mais sa documentation et ses pipelines ne seront
          pas lues. Définissez{" "}
          <code className="font-mono">GITHUB_TOKEN</code> sur le Control Plane.
        </p>
      )}

      {configured && !repo && (
        <p className="flex items-start gap-2 rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
          <GitBranch className="mt-0.5 size-3.5 shrink-0" />
          Rattacher un dépôt donne accès à sa documentation et à l&apos;état de
          ses pipelines depuis cette application.
        </p>
      )}
    </div>
  );
}
