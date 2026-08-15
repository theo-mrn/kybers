"use client";

import { useActionState, useState } from "react";
import { Info, Plug, XCircle } from "lucide-react";

import { createRegistryAction, type ActionState } from "@/app/actions";
import { SubmitButton } from "@/components/forms";
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
 * Connexion d'un registry.
 *
 * Les identifiants sont vérifiés au moment de la création : l'action échoue si
 * le compte ne répond pas, plutôt que d'enregistrer un registry inutilisable.
 */
export function RegistryDialog() {
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState<ActionState, FormData>(
    createRegistryAction,
    null,
  );

  const isOpen = open && !state?.ok;

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plug className="size-3.5" />
        Connecter un registry
      </Button>

      <Dialog open={isOpen} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Connecter un registry</DialogTitle>
            <DialogDescription>
              Donne accès à vos images privées pour les déployer.
            </DialogDescription>
          </DialogHeader>

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
                  Chiffré en base, jamais relu par l&apos;interface.
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
                onClick={() => setOpen(false)}
              >
                Annuler
              </Button>
              <SubmitButton
                label="Connecter"
                pendingLabel="Vérification…"
                icon={Plug}
              />
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
