"use client";

import * as React from "react";
import { useActionState, useState } from "react";
import {
  MoreHorizontal,
  RotateCcw,
  ShieldCheck,
  SlidersHorizontal,
  UserMinus,
} from "lucide-react";

import {
  updateRoleAction,
  removeMemberAction,
  setPermissionAction,
  type AuthState,
} from "@/app/auth-actions";
import type { Member, Permission } from "@/lib/api";
import { SubmitButton } from "@/components/forms";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
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

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm outline-none " +
  "transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40";

/**
 * Actions d'un membre regroupées derrière un menu unique.
 *
 * Les droits fins étaient auparavant dépliés pour tous les membres à la fois,
 * en bas de page : des dizaines de sélecteurs qu'il fallait parcourir pour
 * trouver la bonne personne. Ils sont désormais rattachés au membre concerné.
 */
export function MemberRowActions({
  member,
  permissions,
  canManage,
  isLastOwner,
  isSelf,
  orgId,
  isPeerAdmin = false,
}: {
  member: Member;
  permissions: Permission[];
  canManage: boolean;
  isLastOwner: boolean;
  isSelf: boolean;
  /** Cible admin de l'organisation, modifiable seulement par un admin de
   *  plateforme : entre pairs, chacun pourrait rétrograder l'autre. */
  isPeerAdmin?: boolean;
  /** Organisation de la page : les actions la ciblent explicitement, plutôt
   *  que de dépendre de l'organisation active. */
  orgId: string;
}) {
  const [dialog, setDialog] = useState<null | "role" | "rights" | "remove">(null);

  // Un lecteur ne peut rien modifier, et un admin ne touche pas à un pair :
  // dans les deux cas le menu serait vide ou mènerait à un refus.
  if (!canManage || isPeerAdmin) return null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Actions pour ${member.email}`}
            />
          }
        >
          <MoreHorizontal className="size-4" />
        </DropdownMenuTrigger>

        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuGroup>
            <DropdownMenuLabel className="font-normal text-muted-foreground">
              {member.name || member.email}
            </DropdownMenuLabel>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />

          <DropdownMenuItem
            onClick={() => setDialog("role")}
            disabled={isLastOwner}
          >
            <ShieldCheck className="size-4" />
            Changer le rôle
          </DropdownMenuItem>

          {permissions.length > 0 && (
            <DropdownMenuItem onClick={() => setDialog("rights")}>
              <SlidersHorizontal className="size-4" />
              Droits individuels
            </DropdownMenuItem>
          )}

          {/* Retirer le dernier propriétaire rendrait l'organisation
              ingérable ; se retirer soi-même est tout aussi définitif. */}
          {!isLastOwner && !isSelf && (
            <>
              <DropdownMenuSeparator />
              <RemoveItem onAsk={() => setDialog("remove")} />
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <RoleDialog
        member={member}
        orgId={orgId}
        open={dialog === "role"}
        onOpenChange={(o) => setDialog(o ? "role" : null)}
      />
      <RemoveMemberDialog
        member={member}
        orgId={orgId}
        open={dialog === "remove"}
        onOpenChange={(o) => setDialog(o ? "remove" : null)}
      />
      <RightsDialog
        member={member}
        permissions={permissions}
        orgId={orgId}
        open={dialog === "rights"}
        onOpenChange={(o) => setDialog(o ? "rights" : null)}
      />
    </>
  );
}

function RemoveItem({
  onAsk,
}: {
  /** Le menu se ferme au clic : la confirmation est portée par le parent. */
  onAsk: () => void;
}) {
  return (
    <DropdownMenuItem variant="destructive" onClick={onAsk}>
      <UserMinus className="size-4" />
      Retirer de l&apos;organisation
    </DropdownMenuItem>
  );
}

/** Confirmation du retrait, hors du menu qui se referme au clic. */
function RemoveMemberDialog({
  member,
  orgId,
  open,
  onOpenChange,
}: {
  member: Member;
  orgId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [state, action] = useActionState<AuthState, FormData>(
    removeMemberAction,
    null,
  );

  return (
    <Dialog open={open && !state?.ok} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Retirer {member.name || member.email} ?</DialogTitle>
          <DialogDescription>
            Cette personne perd l&apos;accès aux applications, clusters et
            registries de l&apos;organisation. Son compte est conservé.
          </DialogDescription>
        </DialogHeader>

        <form action={action} className="flex flex-col gap-4">
          <input type="hidden" name="user_id" value={member.user_id} />
          <input type="hidden" name="org_id" value={orgId} />

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
              label="Retirer"
              pendingLabel="…"
              variant="destructive"
              icon={UserMinus}
            />
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RoleDialog({
  member,
  open,
  onOpenChange,
  orgId,
}: {
  member: Member;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgId: string;
}) {
  const [state, action] = useActionState<AuthState, FormData>(
    updateRoleAction,
    null,
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Changer le rôle</DialogTitle>
          <DialogDescription>
            Le rôle définit les droits par défaut de {member.name || member.email}.
          </DialogDescription>
        </DialogHeader>

        <form action={action} className="flex flex-col gap-4">
          <input type="hidden" name="user_id" value={member.user_id} />
          <input type="hidden" name="org_id" value={orgId} />

          <div className="space-y-1.5">
            <Label htmlFor={`role-${member.user_id}`}>Rôle</Label>
            <select
              id={`role-${member.user_id}`}
              name="role"
              defaultValue={member.role}
              className={selectClass}
            >
              {ROLES.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>

          {/* Rappel de ce que chaque rôle autorise, pour choisir sans deviner. */}
          <div className="space-y-2 rounded-lg border border-border p-3">
            {ROLES.map((r) => (
              <p key={r.value} className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{r.label}</span> —{" "}
                {r.hint}
              </p>
            ))}
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
            <SubmitButton label="Enregistrer" pendingLabel="…" />
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Chaque permission a trois états : suivre le rôle, accorder explicitement,
 * refuser explicitement. Distinguer « accordé par le rôle » de « accordé
 * individuellement » évite qu'un changement de rôle emporte une décision
 * délibérée.
 */
function RightsDialog({
  member,
  permissions,
  open,
  onOpenChange,
  orgId,
}: {
  member: Member;
  permissions: Permission[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgId: string;
}) {
  const overrides = permissions.filter((p) => p.overridden).length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Droits individuels</DialogTitle>
          <DialogDescription>
            Affinez les droits de {member.name || member.email} au-delà de son
            rôle. Une décision individuelle prime toujours sur le rôle.
          </DialogDescription>
        </DialogHeader>

        {overrides > 0 && (
          <p className="text-xs text-warning">
            {overrides} droit(s) défini(s) individuellement — ils ne suivront
            plus les changements de rôle.
          </p>
        )}

        <Separator />

        <div className="flex max-h-96 flex-col gap-3 overflow-y-auto">
          {permissions.map((p) => (
            <PermissionRow
              key={p.key}
              userId={member.user_id}
              permission={p}
              orgId={orgId}
            />
          ))}
        </div>

        <DialogFooter>
          <Button type="button" onClick={() => onOpenChange(false)}>
            Terminé
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PermissionRow({
  userId,
  permission,
  orgId,
}: {
  userId: string;
  permission: Permission;
  orgId: string;
}) {
  const [state, action] = useActionState<AuthState, FormData>(
    setPermissionAction,
    null,
  );

  const value = permission.overridden
    ? permission.granted
      ? "grant"
      : "deny"
    : "role";

  return (
    <form
      action={action}
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5"
    >
      <input type="hidden" name="user_id" value={userId} />
      <input type="hidden" name="org_id" value={orgId} />
      <input type="hidden" name="permission" value={permission.key} />

      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-sm">
          {permission.label}
          {permission.overridden && (
            <Badge
              variant="secondary"
              className="gap-1 border-transparent bg-warning/15 text-warning"
            >
              individuel
            </Badge>
          )}
        </p>
        <p className="text-xs text-muted-foreground">{permission.hint}</p>
        {state && !state.ok && (
          <p className="text-xs text-destructive" role="alert">
            {state.message}
          </p>
        )}
      </div>

      <div className="flex items-center gap-1.5">
        <select
          name="value"
          defaultValue={value}
          onChange={(e) => e.currentTarget.form?.requestSubmit()}
          className="h-8 rounded-md border border-input bg-transparent px-2 text-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40"
          aria-label={`Droit ${permission.label}`}
        >
          <option value="role">
            selon le rôle ({permission.from_role ? "autorisé" : "refusé"})
          </option>
          <option value="grant">autorisé</option>
          <option value="deny">refusé</option>
        </select>
        {permission.overridden && (
          <Button
            type="submit"
            name="value"
            value="role"
            variant="ghost"
            size="icon-sm"
            aria-label="Revenir au rôle"
            title="Revenir au rôle"
          >
            <RotateCcw className="size-3.5" />
          </Button>
        )}
      </div>
    </form>
  );
}
