import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  ArrowLeft,
  Boxes,
  Building2,
  Info,
  Search,
  ShieldCheck,
  Users,
  X,
} from "lucide-react";

import { api, activeOrganization, type Member, type Permission } from "@/lib/api";
import { MemberRowActions } from "@/components/member-row-actions";
import { AddMemberDialog } from "@/components/team-dialogs";
import { RenameOrgForm, DeleteOrgButton } from "@/components/org-forms";
import { SwitchOrgButton } from "@/components/switch-org";
import { Card, EmptyState, PageHeader, formatAge } from "@/components/ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const ROLE_LABELS: Record<string, string> = {
  owner: "Admin",
  member: "Membre",
  viewer: "Lecteur",
};

const ROLE_STYLES: Record<string, string> = {
  owner: "bg-warning/15 text-warning",
  member: "bg-info/15 text-info",
  viewer: "bg-muted text-muted-foreground",
};

/**
 * Niveau réel d'un compte, en un seul badge.
 *
 * Le statut plateforme n'est pas un supplément au rôle d'organisation : c'est
 * un niveau supérieur qui le REMPLACE. Afficher « Admin » puis « Super-admin »
 * sur la même ligne décrivait deux fois la même personne.
 *
 * « Propriétaire » désigne le compte unique créé à l'installation ; « Admin »
 * couvre aussi bien un administrateur de plateforme qu'un admin d'organisation
 * — ce que chacun administre se lit au contexte de la page.
 */
const LEVEL_LABELS: Record<string, string> = {
  superadmin: "Propriétaire",
  admin: "Admin",
  ...ROLE_LABELS,
};

const LEVEL_STYLES: Record<string, string> = {
  superadmin: "bg-primary/15 text-primary",
  admin: "bg-warning/15 text-warning",
  ...ROLE_STYLES,
};

function levelOf(m: Member): string {
  if (m.is_superadmin) return "superadmin";
  if (m.is_admin) return "admin";
  return m.role;
}

function initialsOf(value: string) {
  return (
    value
      .split(/[\s@.]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase())
      .join("") || "?"
  );
}

export default async function OrganisationDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ q?: string }>;
}) {
  const { id } = await params;
  const { q } = await searchParams;
  const query = (q ?? "").trim().toLowerCase();

  const me = await api.me().catch(() => null);
  if (!me) redirect("/login");

  const isAdmin = me.user.is_admin;
  const mine = me.organizations.find((o) => o.id === id);

  // Un admin plateforme peut consulter n'importe quelle organisation ; les
  // autres seulement celles dont ils sont membres.
  const org = isAdmin
    ? (await api.adminListOrganizations().catch(() => [])).find(
        (o) => o.id === id,
      ) ?? mine
    : mine;
  if (!org) notFound();

  // Les droits suivent le rôle dans CETTE organisation, pas celle qui se trouve
  // active : être propriétaire ici suffit pour y gérer les membres. Les appels
  // ciblent donc explicitement l'organisation consultée.
  const active = await activeOrganization(me.organizations);
  const isActive = active?.id === id;
  const myRole = mine?.role ?? "";
  const canManage = myRole === "owner";

  // Même règle que pour les lignes du tableau : le badge annonce le niveau
  // réel, pas seulement le rôle d'organisation.
  const myLevel = me.user.is_superadmin
    ? "superadmin"
    : me.user.is_admin
      ? "admin"
      : myRole;

  const members: Member[] = mine
    ? await api.listMembers(id).catch(() => [])
    : isAdmin
      ? await api.adminListOrgMembers(id).catch(() => [])
      : [];

  // Droits fins : lisibles seulement dans l'organisation active, et seulement
  // par un propriétaire habilité à les modifier.
  const permissionsByUser: Record<string, Permission[]> = canManage
    ? Object.fromEntries(
        await Promise.all(
          members.map(
            async (m) =>
              [
                m.user_id,
                await api
                  .getUserPermissions(m.user_id, id)
                  .then((r) => r.permissions)
                  .catch(() => [] as Permission[]),
              ] as const,
          ),
        ),
      )
    : {};

  const owners = members.filter((m) => m.role === "owner").length;

  const visibleMembers = query
    ? members.filter(
        (m) =>
          m.email.toLowerCase().includes(query) ||
          (m.name ?? "").toLowerCase().includes(query),
      )
    : members;

  return (
    <>
      <PageHeader title={org.name}>
        <Button
          variant="ghost"
          size="sm"
          nativeButton={false}
          render={<Link href="/parametres/organisations" />}
        >
          <ArrowLeft className="size-3.5" />
          Organisations
        </Button>
        {!isActive && mine && <SwitchOrgButton slug={org.slug} />}
        {canManage && <AddMemberDialog />}
      </PageHeader>

      <div className="-mt-4 flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="font-mono">
          {org.slug}
        </Badge>
        <Badge variant="outline" className="gap-1">
          <Boxes className="size-3" />
          {org.app_count ?? 0} application(s)
        </Badge>
        {myLevel && (
          <Badge
            variant="secondary"
            className={cn("gap-1 border-transparent", LEVEL_STYLES[myLevel])}
          >
            <ShieldCheck className="size-3" />
            {LEVEL_LABELS[myLevel] ?? myLevel}
          </Badge>
        )}
        <span className="text-xs text-muted-foreground">
          créée {formatAge(org.created_at)}
        </span>
      </div>

      {/* Un admin plateforme peut consulter une organisation dont il n'est pas
          membre : il en voit la composition, sans pouvoir la modifier. */}
      {!mine && (
        <p className="flex items-start gap-2 rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" />
          Consultation seule : vous n&apos;êtes pas membre de cette organisation.
        </p>
      )}

      <Card
        title="Membres"
        description={
          query
            ? `${visibleMembers.length} résultat(s) sur ${members.length} membre(s).`
            : "Le rôle définit les droits par défaut ; un droit individuel prime toujours sur lui."
        }
        icon={Users}
        action={
          members.length > 0 && (
            <form method="get" className="flex items-center gap-2">
              <div className="relative w-full sm:w-64">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  name="q"
                  key={q ?? ""}
                  defaultValue={q ?? ""}
                  placeholder="Rechercher un membre…"
                  aria-label="Rechercher un membre par nom ou email"
                  className="h-8 pl-8.5"
                />
              </div>
              {query && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Effacer la recherche"
                  nativeButton={false}
                  render={<Link href={`/parametres/organisations/${id}`} />}
                >
                  <X className="size-3.5" />
                </Button>
              )}
            </form>
          )
        }
        contentClassName="px-0"
      >
        {visibleMembers.length === 0 ? (
          <div className="px-6">
            <EmptyState
              icon={Users}
              title={query ? "Aucun membre ne correspond" : "Aucun membre"}
              description={
                query
                  ? `Rien ne correspond à « ${q} ».`
                  : "Personne ne peut déployer dans cette organisation."
              }
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                {/* Largeurs fixées sur les colonnes courtes : sinon « Membre »
                    s'étire sur tout l'espace libre et rejette les suivantes
                    contre le bord droit. */}
                <TableRow>
                  <TableHead className="pl-6">Membre</TableHead>
                  <TableHead className="w-[34%]">Rôle</TableHead>
                  <TableHead className="w-32">Depuis</TableHead>
                  {/* Sans droit de gestion, la colonne resterait vide sur
                      toutes les lignes : autant ne pas la dessiner. */}
                  {canManage && (
                    <TableHead className="w-20 pr-6 text-right">Actions</TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleMembers.map((m) => {
                  const isLastOwner = m.role === "owner" && owners <= 1;
                  const perms = permissionsByUser[m.user_id] ?? [];

                  return (
                    <TableRow key={m.user_id}>
                      <TableCell className="pl-6">
                        <div className="flex items-center gap-3">
                          <Avatar className="size-8">
                            <AvatarFallback className="bg-primary/15 text-xs font-medium text-primary">
                              {initialsOf(m.name || m.email)}
                            </AvatarFallback>
                          </Avatar>
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">
                              {m.name || m.email}
                              {m.user_id === me.user.id && (
                                <span className="ml-2 text-xs font-normal text-muted-foreground">
                                  (vous)
                                </span>
                              )}
                            </p>
                            <p className="truncate text-xs text-muted-foreground">
                              {m.email}
                            </p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        {/* Un seul badge : le niveau RÉEL du compte. Le statut
                            plateforme remplace le rôle d'organisation au lieu
                            de s'y ajouter — cumuler « Admin » et
                            « Super-admin » sur la même ligne décrivait deux
                            fois la même personne. */}
                        <Badge
                          variant="secondary"
                          className={cn(
                            "border-transparent",
                            LEVEL_STYLES[levelOf(m)],
                          )}
                        >
                          {LEVEL_LABELS[levelOf(m)]}
                        </Badge>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {formatAge(m.joined_at)}
                      </TableCell>
                      {canManage && (
                        <TableCell className="pr-6 text-right">
                          <MemberRowActions
                            member={m}
                            permissions={perms}
                            canManage={canManage}
                            isLastOwner={isLastOwner}
                            isSelf={m.user_id === me.user.id}
                            orgId={id}
                            // Hiérarchie stricte : on n'agit que sur un niveau
                            // inférieur au sien. Le statut plateforme du membre
                            // prime sur son rôle dans l'organisation.
                            isPeerAdmin={
                              m.user_id !== me.user.id &&
                              (m.is_superadmin ||
                                (m.is_admin && !me.user.is_superadmin) ||
                                (m.role === "owner" && !isAdmin))
                            }
                          />
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>

      {/* Renommage et suppression : réservés aux administrateurs plateforme. */}
      {isAdmin && (
        <Card title="Paramètres" icon={Building2}>
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">Nom</p>
            <RenameOrgForm org={org} />
          </div>

          <div className="mt-6 flex flex-wrap items-start justify-between gap-4 rounded-lg border border-destructive/25 bg-destructive/5 p-4">
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-medium text-destructive">
                Supprimer cette organisation
              </p>
              <p className="text-xs text-muted-foreground">
                Les comptes sont conservés ; les clusters, registries et jetons
                de l&apos;organisation sont supprimés avec elle. Une organisation
                qui héberge encore des applications est refusée.
              </p>
            </div>
            <DeleteOrgButton org={org} />
          </div>
        </Card>
      )}
    </>
  );
}
