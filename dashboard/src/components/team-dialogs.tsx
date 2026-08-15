"use client";

import { useActionState, useState } from "react";
import { Info, KeyRound, UserPlus } from "lucide-react";

import {
  addMemberAction,
  createTokenAction,
  type AuthState,
  type TokenState,
} from "@/app/auth-actions";
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

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm outline-none " +
  "transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40";

const ROLES = [
  {
    value: "owner",
    label: "Admin",
    hint: "gère les membres, clusters et registries",
  },
  {
    value: "member",
    label: "Membre",
    hint: "déploie et administre les applications",
  },
  { value: "viewer", label: "Lecteur", hint: "consulte sans modifier" },
];

// ---------------------------------------------------------------------------
// Ajout d'un membre
// ---------------------------------------------------------------------------

export function AddMemberDialog() {
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState<AuthState, FormData>(
    addMemberAction,
    null,
  );

  // État dérivé plutôt qu'un effet de synchronisation : un succès referme la
  // modale, la liste rafraîchie derrière montre le nouveau membre.
  const isOpen = open && !state?.ok;

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <UserPlus className="size-3.5" />
        Ajouter un membre
      </Button>

      <Dialog open={isOpen} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Ajouter un membre</DialogTitle>
            <DialogDescription>
              Donne accès à cette organisation à quelqu&apos;un qui a déjà un
              compte sur la plateforme.
            </DialogDescription>
          </DialogHeader>

          <form action={action} className="flex flex-col gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="member_email">Email</Label>
              <Input
                id="member_email"
                name="email"
                type="email"
                required
                placeholder="collegue@exemple.fr"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="member_role">Rôle</Label>
              <select
                id="member_role"
                name="role"
                defaultValue="member"
                className={selectClass}
              >
                {ROLES.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-2 rounded-lg border border-border p-3">
              {ROLES.map((r) => (
                <p key={r.value} className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{r.label}</span>{" "}
                  — {r.hint}
                </p>
              ))}
            </div>

            {/* Le cas d'échec le plus courant : la personne n'a pas encore de
                compte. L'API le refuse sans dire quoi faire ensuite. */}
            <p className="flex items-start gap-2 rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
              <Info className="mt-0.5 size-3.5 shrink-0" />
              Aucune invitation par email n&apos;est envoyée. Si la personne
              n&apos;a pas encore de compte, un administrateur de la plateforme
              doit d&apos;abord le créer depuis Administration.
            </p>

            {state && !state.ok && (
              <p className="text-sm text-destructive" role="alert">
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
                label="Ajouter"
                pendingLabel="Ajout…"
                icon={UserPlus}
              />
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// Création d'un jeton d'API
// ---------------------------------------------------------------------------

export function CreateTokenDialog() {
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState<TokenState, FormData>(
    createTokenAction,
    null,
  );

  // Le jeton n'est montré qu'une fois : la modale reste ouverte tant qu'il n'a
  // pas été copié, sinon il serait perdu.
  const created = Boolean(state?.ok && state.token);

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <KeyRound className="size-3.5" />
        Nouveau jeton
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Créer un jeton d&apos;API</DialogTitle>
            <DialogDescription>
              Pour la CLI et l&apos;intégration continue. Un jeton hérite de vos
              droits dans l&apos;organisation.
            </DialogDescription>
          </DialogHeader>

          {created ? (
            <div className="flex flex-col gap-4">
              <div className="rounded-lg border border-success/30 bg-success/5 p-4">
                <p className="mb-2 text-sm font-medium text-success">
                  Jeton créé — copiez-le maintenant
                </p>
                <pre className="overflow-x-auto rounded-md border border-border bg-background p-3 font-mono text-xs select-all">
                  {state?.token}
                </pre>
                <p className="mt-2 text-xs text-muted-foreground">
                  Il ne sera plus jamais affiché : seule son empreinte est
                  conservée.
                </p>
              </div>
              <DialogFooter>
                <Button onClick={() => setOpen(false)}>Terminé</Button>
              </DialogFooter>
            </div>
          ) : (
            <form action={action} className="flex flex-col gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="token_name">Nom du jeton</Label>
                <Input
                  id="token_name"
                  name="name"
                  required
                  placeholder="ci-github"
                />
                <p className="text-xs text-muted-foreground">
                  Sert à le reconnaître dans la liste — choisissez le service
                  qui l&apos;utilisera.
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="token_expiry">Expiration</Label>
                <select
                  id="token_expiry"
                  name="expires_in_days"
                  defaultValue="90"
                  className={selectClass}
                >
                  <option value="30">30 jours</option>
                  <option value="90">90 jours</option>
                  <option value="365">1 an</option>
                  <option value="0">sans expiration</option>
                </select>
              </div>

              <p className="flex items-start gap-2 rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
                <Info className="mt-0.5 size-3.5 shrink-0" />
                Le jeton ne sera affiché qu&apos;une seule fois, juste après sa
                création.
              </p>

              {state && !state.ok && (
                <p className="text-sm text-destructive" role="alert">
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
                  label="Créer le jeton"
                  pendingLabel="Création…"
                  icon={KeyRound}
                />
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
