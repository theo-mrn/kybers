"use client";

import { useActionState, useState } from "react";
import { CheckCircle2, Info, Plug, Terminal, XCircle } from "lucide-react";

import { createClusterAction, type ClusterState } from "@/app/actions";
import { SubmitButton } from "@/components/forms";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Enregistrement d'un cluster.
 *
 * Le jeton d'agent n'est affiché qu'une fois : la modale bascule alors sur la
 * commande d'installation et refuse de se fermer tant qu'elle n'a pas été lue,
 * sinon le jeton serait perdu.
 */
export function ClusterDialog({
  controlPlaneAddr,
}: {
  controlPlaneAddr: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState<ClusterState, FormData>(
    createClusterAction,
    null,
  );

  const created = Boolean(state?.ok && state.token);

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plug className="size-3.5" />
        Enregistrer un cluster
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {created ? "Installer l'agent" : "Enregistrer un cluster"}
            </DialogTitle>
            <DialogDescription>
              {created
                ? "Le cluster est enregistré. Il reste à y installer l'agent."
                : "L'agent s'installe sur le cluster et ouvre une connexion sortante vers le Control Plane."}
            </DialogDescription>
          </DialogHeader>

          {created ? (
            <div className="flex flex-col gap-4">
              <p className="flex items-center gap-1.5 text-sm font-medium text-success">
                <CheckCircle2 className="size-4" />
                Cluster « {state?.clusterName} » enregistré
              </p>

              <div className="space-y-2">
                <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <Terminal className="size-3.5" />
                  À exécuter sur une machine ayant un accès{" "}
                  <code className="font-mono">kubectl</code> au cluster
                </p>
                <pre className="overflow-x-auto rounded-lg border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed select-all">
                  {state?.installCommand ??
                    `helm install kybers-agent oci://registry-1.docker.io/maxwellfaraday/kybers-agent \\
  --namespace kybers-system --create-namespace \\
  --set controlPlane.addr=${controlPlaneAddr} \\
  --set controlPlane.clusterId=${state?.clusterName ?? ""} \\
  --set auth.token=${state?.token ?? ""}`}
                </pre>
                <p className="text-xs text-warning">
                  Le jeton n&apos;apparaîtra plus : copiez la commande
                  maintenant.
                </p>
              </div>

              <Separator />

              <p className="flex items-start gap-2 text-xs text-muted-foreground">
                <Info className="mt-0.5 size-3.5 shrink-0" />
                L&apos;agent ouvre une connexion sortante : aucun port entrant
                n&apos;est à ouvrir sur le cluster. Il doit pouvoir joindre{" "}
                <code className="font-mono">{controlPlaneAddr}</code>. Le cluster
                apparaîtra comme connecté dès que l&apos;agent aura démarré.
              </p>

              <DialogFooter>
                <Button onClick={() => setOpen(false)}>Terminé</Button>
              </DialogFooter>
            </div>
          ) : (
            <form action={action} className="flex flex-col gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="cluster_name">Nom du cluster</Label>
                <Input
                  id="cluster_name"
                  name="name"
                  required
                  placeholder="k3s-prod"
                />
                <p className="text-xs text-muted-foreground">
                  Identifie ce cluster auprès du Control Plane.
                </p>
              </div>

              {/* Expliquer le mécanisme ici évite la carte « Comment ça
                  marche » qui occupait la page en permanence. */}
              <div className="space-y-2 rounded-lg border border-border p-3 text-xs text-muted-foreground">
                <p className="flex items-center gap-1.5 font-medium text-foreground">
                  <Info className="size-3.5" />
                  Comment ça marche
                </p>
                <p>
                  À la validation, un jeton d&apos;agent est généré avec une
                  commande <code className="font-mono">helm</code> prête à
                  coller.
                </p>
                <p>
                  L&apos;agent ouvre une connexion{" "}
                  <strong className="text-foreground">sortante</strong> vers le
                  Control Plane : aucun port entrant n&apos;est à ouvrir côté
                  cluster.
                </p>
                <p>
                  Sans agent connecté, les déploiements sont enregistrés mais
                  restent en attente — ils partiront à la reconnexion.
                </p>
              </div>

              {state && !state.ok && (
                <p
                  className="flex items-center gap-1.5 text-sm text-destructive"
                  role="alert"
                >
                  <XCircle className="size-3.5 shrink-0" />
                  {state.message}
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
                <SubmitButton
                  label="Enregistrer"
                  pendingLabel="Création…"
                  icon={Plug}
                />
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
