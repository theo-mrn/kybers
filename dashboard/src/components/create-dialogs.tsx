"use client";

import * as React from "react";
import { useActionState, useState } from "react";
import { Building2, Plus, ShieldCheck, UserPlus } from "lucide-react";

import {
  adminCreateOrgAction,
  adminCreateUserAction,
  type AuthState,
  type AdminUserState,
} from "@/app/auth-actions";
import type { User, Organization } from "@/lib/api";
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

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm outline-none " +
  "transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40";

const ROLE_OPTIONS = [
  { value: "owner", label: "Admin" },
  { value: "member", label: "Membre" },
  { value: "viewer", label: "Lecteur" },
];

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Message({ state }: { state: AuthState | AdminUserState }) {
  if (!state) return null;
  return (
    <p
      className={state.ok ? "text-sm text-success" : "text-sm text-destructive"}
      role="status"
    >
      {state.message}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Création d'un compte
// ---------------------------------------------------------------------------

/**
 * La création se fait en modale : le formulaire n'occupait la page que pour un
 * geste occasionnel, et le mot de passe temporaire généré se retrouvait relégué
 * en bas de page, loin du regard.
 */
export function CreateUserDialog({
  organizations,
}: {
  organizations: Organization[];
}) {
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState<AdminUserState, FormData>(
    adminCreateUserAction,
    null,
  );

  // Le mot de passe n'étant montré qu'une fois, la modale reste ouverte tant
  // qu'il n'a pas été lu : la refermer le perdrait définitivement.
  const created = Boolean(state?.ok && state.password);

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <UserPlus className="size-3.5" />
        Nouveau compte
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Créer un compte</DialogTitle>
            <DialogDescription>
              Un mot de passe temporaire est généré ; la personne devra le
              changer à sa première connexion.
            </DialogDescription>
          </DialogHeader>

          {created ? (
            <div className="flex flex-col gap-4">
              <div className="rounded-lg border border-success/30 bg-success/5 p-4">
                <p className="mb-2 text-sm font-medium text-success">
                  Compte créé — mot de passe temporaire
                  {state?.email ? ` pour ${state.email}` : ""}
                </p>
                <pre className="overflow-x-auto rounded-md border border-border bg-background p-3 font-mono text-sm select-all">
                  {state?.password}
                </pre>
                <p className="mt-2 text-xs text-muted-foreground">
                  Transmettez-le à la personne : il ne sera plus affiché.
                </p>
              </div>
              <DialogFooter>
                <Button onClick={() => setOpen(false)}>Terminé</Button>
              </DialogFooter>
            </div>
          ) : (
            <form action={action} className="flex flex-col gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Email" htmlFor="new_email">
                  <Input
                    id="new_email"
                    name="email"
                    type="email"
                    required
                    placeholder="marie@interne.fr"
                  />
                </Field>
                <Field label="Nom" htmlFor="new_name">
                  <Input
                    id="new_name"
                    name="name"
                    placeholder="Marie Dupont"
                  />
                </Field>
              </div>

              <Separator />

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Organisation" htmlFor="new_org">
                  <select id="new_org" name="org_id" className={selectClass}>
                    <option value="">aucune pour l&apos;instant</option>
                    {organizations.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Rôle" htmlFor="new_role">
                  <select
                    id="new_role"
                    name="role"
                    defaultValue="member"
                    className={selectClass}
                  >
                    {ROLE_OPTIONS.map((r) => (
                      <option key={r.value} value={r.value}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>

              <label className="flex items-start gap-2.5 rounded-lg border border-border p-3 text-sm">
                <input
                  type="checkbox"
                  name="is_admin"
                  className="mt-0.5 size-4 accent-primary"
                />
                <span>
                  <span className="flex items-center gap-1.5 font-medium">
                    <ShieldCheck className="size-3.5" />
                    Administrateur de la plateforme
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    pourra créer des comptes et des organisations
                  </span>
                </span>
              </label>

              <Message state={state} />

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setOpen(false)}
                >
                  Annuler
                </Button>
                <SubmitButton
                  label="Créer le compte"
                  pendingLabel="Création…"
                  icon={UserPlus}
                />
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// Création d'une organisation
// ---------------------------------------------------------------------------

/**
 * Le slug est dérivé du nom par défaut : il sert d'identifiant dans les URL et
 * l'en-tête X-Kybers-Org, et ne change plus ensuite.
 */
export function CreateOrgDialog({ users }: { users: User[] }) {
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState<AuthState, FormData>(
    adminCreateOrgAction,
    null,
  );
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");

  // Aperçu du slug tant que l'admin ne l'a pas fixé lui-même. Même règle que
  // `auth.Slugify` côté Control Plane, qui reste l'autorité.
  const preview =
    slug ||
    name
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

  // Une création réussie referme la modale : l'organisation apparaît alors
  // dans la liste rafraîchie derrière. L'état est dérivé plutôt que synchronisé
  // par un effet, qui provoquerait un rendu en cascade.
  const succeeded = Boolean(state?.ok);
  const isOpen = open && !succeeded;

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="size-3.5" />
        Nouvelle organisation
      </Button>

      <Dialog open={isOpen} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Créer une organisation</DialogTitle>
            <DialogDescription>
              Une organisation cloisonne applications, clusters et registries.
              Rien n&apos;est partagé entre elles.
            </DialogDescription>
          </DialogHeader>

          <form action={action} className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Nom" htmlFor="org_name_new">
                <Input
                  id="org_name_new"
                  name="name"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Équipe data"
                />
              </Field>

              <Field
                label="Identifiant"
                htmlFor="org_slug_new"
                hint="Figé après création."
              >
                <Input
                  id="org_slug_new"
                  name="slug"
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  placeholder={preview || "equipe-data"}
                  className="font-mono"
                />
              </Field>
            </div>

            <Field
              label="Admin"
              htmlFor="org_owner"
              hint="Devient le premier membre de l'organisation."
            >
              <select id="org_owner" name="owner_id" className={selectClass}>
                <option value="">moi-même</option>
                {users
                  .filter((u) => !u.disabled)
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name || u.email}
                    </option>
                  ))}
              </select>
            </Field>

            <p className="flex items-start gap-2 rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
              <Building2 className="mt-0.5 size-3.5 shrink-0" />
              L&apos;identifiant apparaît dans les URL et les jetons d&apos;API :
              il ne pourra plus être modifié ensuite.
            </p>

            <Message state={state} />

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setOpen(false)}
              >
                Annuler
              </Button>
              <SubmitButton
                label="Créer l'organisation"
                pendingLabel="Création…"
                icon={Plus}
              />
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
