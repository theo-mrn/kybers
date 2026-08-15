"use client";

import { useActionState, useState } from "react";
import { Container, Info, Plug, Settings2, XCircle } from "lucide-react";

import { createRegistryAction, type ActionState } from "@/app/actions";
import type { Registry } from "@/lib/api";
import { DeleteRegistryButton, SubmitButton } from "@/components/forms";
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
 * Gestion des comptes, reléguée derrière un bouton.
 *
 * Les comptes occupaient la moitié haute de la page alors qu'on les configure
 * une fois : ce sont les images qu'on vient consulter. La liste et le
 * formulaire d'ajout partagent la même modale — deux modales imbriquées
 * poseraient des conflits de focus.
 */
export function RegistriesDialog({ registries }: { registries: Registry[] }) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [state, action] = useActionState<ActionState, FormData>(
    createRegistryAction,
    null,
  );

  // Un ajout réussi ramène à la liste, rafraîchie derrière.
  const showForm = adding && !state?.ok;

  function close() {
    setOpen(false);
    setAdding(false);
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Settings2 className="size-3.5" />
        Comptes
        <Badge variant="secondary" className="ml-1">
          {registries.length}
        </Badge>
      </Button>

      <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {showForm ? "Connecter un registry" : "Comptes connectés"}
            </DialogTitle>
            <DialogDescription>
              {showForm
                ? "Donne accès à vos images privées pour les déployer."
                : "Les images de tous ces comptes apparaissent dans le catalogue."}
            </DialogDescription>
          </DialogHeader>

          {showForm ? (
            <form action={action} className="flex flex-col gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="reg_name">Nom</Label>
                  <Input
                    id="reg_name"
                    name="name"
                    required
                    placeholder="mon-docker-hub"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="reg_server">Serveur</Label>
                  <Input
                    id="reg_server"
                    name="server"
                    required
                    list="server-suggestions"
                    defaultValue="docker.io"
                    className="font-mono"
                  />
                  <datalist id="server-suggestions">
                    <option value="docker.io">Docker Hub</option>
                    <option value="ghcr.io">GitHub Container Registry</option>
                    <option value="quay.io">Quay</option>
                    <option value="registry.gitlab.com">GitLab</option>
                  </datalist>
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="reg_username">Identifiant</Label>
                  <Input
                    id="reg_username"
                    name="username"
                    required
                    autoComplete="username"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="reg_password">Mot de passe / token</Label>
                  <Input
                    id="reg_password"
                    name="password"
                    type="password"
                    required
                    autoComplete="new-password"
                  />
                  <p className="text-xs text-muted-foreground">
                    Chiffré en base, jamais relu.
                  </p>
                </div>
              </div>

              <p className="flex items-start gap-2 rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
                <Info className="mt-0.5 size-3.5 shrink-0" />
                Pour Docker Hub, préférez un{" "}
                <a
                  href="https://app.docker.com/settings/personal-access-tokens"
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary hover:underline"
                >
                  access token
                </a>{" "}
                à votre mot de passe : il est révocable sans changer vos
                identifiants.
              </p>

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
                  onClick={() => setAdding(false)}
                >
                  Retour
                </Button>
                <SubmitButton
                  label="Connecter"
                  pendingLabel="Vérification…"
                  icon={Plug}
                />
              </DialogFooter>
            </form>
          ) : (
            <>
              <div className="flex flex-col gap-2">
                {registries.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
                    Aucun compte connecté.
                  </p>
                ) : (
                  registries.map((r) => (
                    <div
                      key={r.id}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3"
                    >
                      <div className="flex min-w-0 items-center gap-2.5">
                        <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
                          <Container className="size-4 text-muted-foreground" />
                        </div>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{r.name}</p>
                          <p className="truncate font-mono text-xs text-muted-foreground">
                            {r.server} · {r.username}
                          </p>
                        </div>
                      </div>
                      <DeleteRegistryButton registryId={r.id} />
                    </div>
                  ))
                )}
              </div>

              <DialogFooter className="sm:justify-between">
                <Button onClick={() => setAdding(true)}>
                  <Plug className="size-3.5" />
                  Connecter un registry
                </Button>
                <Button variant="outline" onClick={close}>
                  Fermer
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
