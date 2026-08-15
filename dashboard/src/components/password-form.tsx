"use client";

import { useActionState, useState } from "react";
import { KeyRound, XCircle } from "lucide-react";

import { changePasswordAction, type AuthState } from "@/app/auth-actions";
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
 * Changement de mot de passe en self-service.
 *
 * Le succès n'a pas d'état affiché : le Control Plane invalide toutes les
 * sessions, l'action redirige donc vers la page de connexion.
 */
export function ChangePasswordDialog() {
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState<AuthState, FormData>(
    changePasswordAction,
    null,
  );

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <KeyRound className="size-3.5" />
        Changer le mot de passe
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Changer le mot de passe</DialogTitle>
            <DialogDescription>
              Toutes vos sessions seront fermées : vous devrez vous reconnecter,
              ici comme ailleurs.
            </DialogDescription>
          </DialogHeader>

          <form action={action} className="flex flex-col gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="current_password">Mot de passe actuel</Label>
              <Input
                id="current_password"
                name="current_password"
                type="password"
                required
                autoComplete="current-password"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="new_password">Nouveau mot de passe</Label>
              <Input
                id="new_password"
                name="new_password"
                type="password"
                required
                autoComplete="new-password"
              />
              <p className="text-xs text-muted-foreground">
                10 caractères minimum — une phrase longue vaut mieux qu&apos;un
                mot complexe.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="confirm_password">Confirmer</Label>
              <Input
                id="confirm_password"
                name="confirm_password"
                type="password"
                required
                autoComplete="new-password"
              />
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
                label="Changer le mot de passe"
                pendingLabel="Changement…"
                icon={KeyRound}
              />
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
