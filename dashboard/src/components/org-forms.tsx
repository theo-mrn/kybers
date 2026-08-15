"use client";

import { useActionState } from "react";
import {
  adminRenameOrgAction,
  adminDeleteOrgAction,
  adminRemoveOrgMemberAction,
  adminAssignOrgAction,
  type AuthState,
} from "@/app/auth-actions";
import type { User, Organization, Member } from "@/lib/api";
import { SubmitButton } from "@/components/forms";

const ROLE_LABELS: Record<string, string> = {
  owner: "Admin",
  member: "Membre",
  viewer: "Lecteur",
};

/** Renomme une organisation, sans toucher à son identifiant. */
export function RenameOrgForm({ org }: { org: Organization }) {
  const [state, action] = useActionState<AuthState, FormData>(adminRenameOrgAction, null);

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="org_id" value={org.id} />
      <input
        name="name"
        defaultValue={org.name}
        required
        aria-label={`Nom de ${org.slug}`}
        className="h-8 w-48 rounded-md border border-input bg-transparent px-2 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40"
      />
      <SubmitButton label="Renommer" pendingLabel="…" variant="outline"
        size="sm" />
      {state && !state.ok && (
        <span className="text-xs text-destructive" role="alert">{state.message}</span>
      )}
    </form>
  );
}

/**
 * Suppression d'une organisation. Le bouton disparaît tant qu'elle héberge des
 * applications : le Control Plane refuserait de toute façon, autant le dire
 * avant le clic. Les clusters, eux, appartiennent à la plateforme et survivent
 * à la suppression.
 */
export function DeleteOrgButton({ org }: { org: Organization }) {
  const [state, action] = useActionState<AuthState, FormData>(adminDeleteOrgAction, null);
  const apps = org.app_count ?? 0;
  const members = org.member_count ?? 0;

  if (apps > 0) {
    return (
      <span className="text-xs text-muted-foreground">
        {apps} application(s) — supprimez-les d&apos;abord
      </span>
    );
  }

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="org_id" value={org.id} />
      <SubmitButton
        label="Supprimer"
        pendingLabel="…"
        variant="destructive"
        size="sm"
        confirm={
          `Supprimer définitivement « ${org.name} » ?` +
          (members > 0
            ? `\n\n${members} membre(s) en seront retirés. Leurs comptes sont conservés.`
            : "")
        }
      />
      {state && !state.ok && (
        <span className="text-xs text-destructive" role="alert">{state.message}</span>
      )}
    </form>
  );
}

/** Ajoute un compte existant à une organisation donnée. */
export function AddOrgMemberForm({ org, users }: { org: Organization; users: User[] }) {
  const [state, action] = useActionState<AuthState, FormData>(adminAssignOrgAction, null);

  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="org_id" value={org.id} />
      <select
        name="user_id"
        required
        aria-label={`Ajouter un membre à ${org.name}`}
        className="h-8 rounded-md border border-input bg-transparent px-2 text-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40"
      >
        <option value="">ajouter une personne…</option>
        {users
          .filter((u) => !u.disabled)
          .map((u) => (
            <option key={u.id} value={u.id}>
              {u.name || u.email}
            </option>
          ))}
      </select>
      <select
        name="role"
        defaultValue="member"
        aria-label="Rôle"
        className="h-8 rounded-md border border-input bg-transparent px-2 text-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40"
      >
        <option value="owner">Admin</option>
        <option value="member">Membre</option>
        <option value="viewer">Lecteur</option>
      </select>
      <SubmitButton label="Ajouter" pendingLabel="…" variant="outline"
        size="sm" />
      {state && !state.ok && (
        <span className="text-xs text-destructive" role="alert">{state.message}</span>
      )}
    </form>
  );
}

/** Retire un membre d'une organisation, sans supprimer son compte. */
export function RemoveOrgMemberButton({
  org,
  member,
  disabled,
}: {
  org: Organization;
  member: Member;
  disabled?: boolean;
}) {
  const [state, action] = useActionState<AuthState, FormData>(
    adminRemoveOrgMemberAction,
    null,
  );

  // Le dernier propriétaire ne peut être retiré : on masque simplement
  // l'action, sans afficher d'étiquette sur chaque ligne.
  if (disabled) return null;

  return (
    <form action={action} className="inline-flex items-center gap-2">
      <input type="hidden" name="org_id" value={org.id} />
      <input type="hidden" name="user_id" value={member.user_id} />
      <SubmitButton
        label="Retirer"
        pendingLabel="…"
        variant="destructive"
        size="sm"
        confirm={`Retirer ${member.email} de « ${org.name} » ? Son compte est conservé.`}
      />
      {state && !state.ok && (
        <span className="text-xs text-destructive" role="alert">{state.message}</span>
      )}
    </form>
  );
}

/** Liste dépliable des membres : une organisation peut en compter beaucoup. */
export function OrgMembers({
  org,
  members,
  users,
}: {
  org: Organization;
  members: Member[];
  users: User[];
}) {
  const owners = members.filter((m) => m.role === "owner").length;

  return (
    <details className="mt-3">
      <summary className="cursor-pointer text-xs text-muted-foreground transition-colors hover:text-foreground">
        {members.length} membre(s)
      </summary>

      <div className="mt-3 flex flex-col gap-2">
        {members.map((m) => (
          <div
            key={m.user_id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2"
          >
            <div className="min-w-0">
              <span className="text-sm">{m.name || m.email}</span>
              {m.name && <span className="ml-2 text-xs text-muted-foreground">{m.email}</span>}
              <span className="ml-2 text-xs text-muted-foreground">
                {ROLE_LABELS[m.role] ?? m.role}
              </span>
            </div>
            <RemoveOrgMemberButton
              org={org}
              member={m}
              // Retirer le dernier propriétaire rendrait l'organisation
              // ingérable par ses propres membres.
              disabled={m.role === "owner" && owners <= 1}
            />
          </div>
        ))}

        <AddOrgMemberForm org={org} users={users} />
      </div>
    </details>
  );
}
