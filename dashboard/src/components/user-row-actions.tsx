"use client";

import * as React from "react";
import { useActionState } from "react";
import {
  Building2,
  KeyRound,
  MoreHorizontal,
  ShieldCheck,
  ShieldMinus,
  UserCheck,
  UserX,
} from "lucide-react";

import {
  adminSetUserStatusAction,
  adminResetPasswordAction,
  adminAssignOrgAction,
  type AuthState,
  type AdminUserState,
} from "@/app/auth-actions";
import type { User, Organization } from "@/lib/api";
import { SubmitButton } from "@/components/forms";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const ROLE_OPTIONS = [
  { value: "owner", label: "Admin" },
  { value: "member", label: "Membre" },
  { value: "viewer", label: "Lecteur" },
];

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm outline-none " +
  "transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40";

/** Mot de passe temporaire : affiché une seule fois, jamais relisible. */
function PasswordReveal({ password, email }: { password: string; email?: string }) {
  return (
    <div className="rounded-lg border border-success/30 bg-success/5 p-4">
      <p className="mb-2 text-sm font-medium text-success">
        Mot de passe temporaire {email ? `pour ${email}` : ""}
      </p>
      <pre className="overflow-x-auto rounded-md border border-border bg-background p-3 font-mono text-sm select-all">
        {password}
      </pre>
      <p className="mt-2 text-xs text-muted-foreground">
        Transmettez-le à la personne : il ne sera plus affiché. Elle devra le
        remplacer à sa première connexion.
      </p>
    </div>
  );
}

/**
 * Toutes les actions d'un compte derrière un menu unique.
 *
 * Les contrôles étaient auparavant dépliés sur la ligne (deux sélecteurs et
 * quatre boutons) : illisible, et l'action principale ne s'y distinguait plus.
 * Le menu ne montre que ce qui est applicable à ce compte, et les opérations
 * qui demandent une saisie ouvrent une modale.
 */
export function UserRowActions({
  user,
  organizations,
  isLastAdmin,
  isSelf,
  viewerIsSuperAdmin = false,
}: {
  user: User;
  organizations: Organization[];
  isLastAdmin: boolean;
  isSelf: boolean;
  /** Seul le super-admin nomme des administrateurs et modifie ses pairs. */
  viewerIsSuperAdmin?: boolean;
}) {
  const [dialog, setDialog] = React.useState<null | "assign" | "reset">(null);

  // Hiérarchie stricte : on n'agit que sur un niveau inférieur au sien. Un
  // administrateur ordinaire ne touche donc ni au super-admin ni à un pair.
  const targetIsAdmin = user.is_admin || user.is_superadmin;
  if (user.is_superadmin) return null;
  if (targetIsAdmin && !viewerIsSuperAdmin && !isSelf) return null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="ghost" size="icon-sm" aria-label={`Actions pour ${user.email}`} />
          }
        >
          <MoreHorizontal className="size-4" />
        </DropdownMenuTrigger>

        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuGroup>
            <DropdownMenuLabel className="font-normal text-muted-foreground">
              {user.name || user.email}
            </DropdownMenuLabel>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />

          <DropdownMenuItem onClick={() => setDialog("assign")}>
            <Building2 className="size-4" />
            Affecter à une organisation
          </DropdownMenuItem>

          <DropdownMenuItem onClick={() => setDialog("reset")}>
            <KeyRound className="size-4" />
            Réinitialiser le mot de passe
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          {/* Nommer ou révoquer un administrateur relève du seul super-admin :
              sinon un admin pourrait s'entourer de pairs. */}
          {user.is_admin
            ? viewerIsSuperAdmin && !isLastAdmin && (
                <StatusItem
                  user={user}
                  kind="demote"
                  label="Retirer les droits admin"
                  icon={ShieldMinus}
                />
              )
            : viewerIsSuperAdmin &&
              !user.disabled && (
                <StatusItem
                  user={user}
                  kind="promote"
                  label="Rendre administrateur"
                  icon={ShieldCheck}
                />
              )}

          {user.disabled ? (
            <StatusItem
              user={user}
              kind="enable"
              label="Réactiver le compte"
              icon={UserCheck}
            />
          ) : (
            !isLastAdmin &&
            !isSelf && (
              <StatusItem
                user={user}
                kind="disable"
                label="Désactiver le compte"
                icon={UserX}
                destructive
                confirm={`Désactiver ${user.email} ? Ses sessions seront fermées immédiatement.`}
              />
            )
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <AssignOrgDialog
        user={user}
        organizations={organizations}
        open={dialog === "assign"}
        onOpenChange={(o) => setDialog(o ? "assign" : null)}
      />
      <ResetPasswordDialog
        user={user}
        open={dialog === "reset"}
        onOpenChange={(o) => setDialog(o ? "reset" : null)}
      />
    </>
  );
}

/** Entrée de menu qui déclenche une mutation de statut. */
function StatusItem({
  user,
  kind,
  label,
  icon: Icon,
  destructive,
  confirm,
}: {
  user: User;
  kind: "disable" | "enable" | "promote" | "demote";
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  destructive?: boolean;
  confirm?: string;
}) {
  const [, formAction] = useActionState<AuthState, FormData>(
    adminSetUserStatusAction,
    null,
  );

  return (
    <form action={formAction}>
      <input type="hidden" name="user_id" value={user.id} />
      <input type="hidden" name="action" value={kind} />
      {/* Sans confirmation, une désactivation part au premier clic : elle
          ferme les sessions immédiatement. */}
      {confirm ? (
        <SubmitButton
          label={label}
          pendingLabel="…"
          variant="ghost"
          className="w-full justify-start gap-1.5 px-1.5 font-normal text-destructive"
          icon={Icon}
          confirm={confirm}
          confirmTitle={label}
          confirmLabel={label}
        />
      ) : (
        <DropdownMenuItem
          variant={destructive ? "destructive" : "default"}
          nativeButton
          render={<button type="submit" className="w-full" />}
        >
          <Icon className="size-4" />
          {label}
        </DropdownMenuItem>
      )}
    </form>
  );
}

function AssignOrgDialog({
  user,
  organizations,
  open,
  onOpenChange,
}: {
  user: User;
  organizations: Organization[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [state, action] = useActionState<AuthState, FormData>(
    adminAssignOrgAction,
    null,
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Affecter à une organisation</DialogTitle>
          <DialogDescription>
            {user.name || user.email} rejoindra l&apos;organisation choisie avec
            le rôle indiqué.
          </DialogDescription>
        </DialogHeader>

        <form action={action} className="flex flex-col gap-4">
          <input type="hidden" name="user_id" value={user.id} />

          <div className="space-y-1.5">
            <Label htmlFor={`org-${user.id}`}>Organisation</Label>
            <select
              id={`org-${user.id}`}
              name="org_id"
              required
              className={selectClass}
            >
              <option value="">choisir…</option>
              {organizations.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={`role-${user.id}`}>Rôle</Label>
            <select
              id={`role-${user.id}`}
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
          </div>

          {state && (
            <p
              className={
                state.ok ? "text-sm text-success" : "text-sm text-destructive"
              }
              role="status"
            >
              {state.message}
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Annuler
            </Button>
            <SubmitButton label="Affecter" pendingLabel="…" />
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ResetPasswordDialog({
  user,
  open,
  onOpenChange,
}: {
  user: User;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [state, action] = useActionState<AdminUserState, FormData>(
    adminResetPasswordAction,
    null,
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Réinitialiser le mot de passe</DialogTitle>
          <DialogDescription>
            Un mot de passe temporaire sera généré pour {user.email}. Ses
            sessions en cours seront fermées.
          </DialogDescription>
        </DialogHeader>

        {state?.ok && state.password ? (
          <div className="flex flex-col gap-4">
            <PasswordReveal password={state.password} email={user.email} />
            <DialogFooter>
              <Button type="button" onClick={() => onOpenChange(false)}>
                Terminé
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form action={action} className="flex flex-col gap-4">
            <input type="hidden" name="user_id" value={user.id} />

            {state && !state.ok && (
              <p className="text-sm text-destructive" role="alert">
                {state.message}
              </p>
            )}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Annuler
              </Button>
              <SubmitButton
                label="Réinitialiser"
                pendingLabel="…"
                icon={KeyRound}
              />
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
