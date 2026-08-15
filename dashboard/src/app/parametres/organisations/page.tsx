import Link from "next/link";
import { redirect } from "next/navigation";
import {
  AlertTriangle,
  ArrowRight,
  Boxes,
  Building2,
  Check,
  ShieldCheck,
  Users,
} from "lucide-react";

import { api, activeOrganization, type Member, type Organization } from "@/lib/api";
import { CreateOrgDialog } from "@/components/create-dialogs";
import { SwitchOrgButton } from "@/components/switch-org";
import { Card, EmptyState, formatAge } from "@/components/ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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

export default async function OrganisationsPage() {
  const me = await api.me().catch(() => null);
  if (!me) redirect("/login");

  const isAdmin = me.user.is_admin;

  // Un admin voit toutes les organisations de la plateforme ; les autres ne
  // voient que celles dont ils sont membres.
  const organizations: Organization[] = isAdmin
    ? await api.adminListOrganizations().catch(() => me.organizations)
    : me.organizations;

  // L'organisation active conditionne tout le reste du dashboard : c'est elle
  // qu'on interroge pour les applications, clusters et registries.
  const activeSlug = (await activeOrganization(me.organizations))?.slug;

  const users = isAdmin ? await api.adminListUsers().catch(() => []) : [];

  // Effectif de chaque organisation, pour situer sa taille sans l'ouvrir.
  const membersByOrg: Record<string, Member[]> = isAdmin
    ? Object.fromEntries(
        await Promise.all(
          organizations.map(
            async (o) =>
              [
                o.id,
                await api.adminListOrgMembers(o.id).catch(() => [] as Member[]),
              ] as const,
          ),
        ),
      )
    : {};

  const orphans = organizations.filter(
    (o) => (o.member_count ?? membersByOrg[o.id]?.length ?? 0) === 0,
  );

  return (
    <>
      {isAdmin && (
        <div className="flex justify-end">
          <CreateOrgDialog users={users} />
        </div>
      )}

      {isAdmin && orphans.length > 0 && (
        <p className="flex items-start gap-2 rounded-md bg-warning/10 px-3 py-2 text-xs text-warning">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          {orphans.length} organisation(s) sans membre : personne ne peut y
          déployer tant qu&apos;un compte n&apos;y est pas rattaché.
        </p>
      )}

      {organizations.length === 0 ? (
        <Card title="Organisations" icon={Building2}>
          <EmptyState
            icon={Building2}
            title="Aucune organisation"
            description={
              isAdmin
                ? "Créez-en une pour commencer à déployer."
                : "Un administrateur doit vous rattacher à une organisation."
            }
          />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {organizations.map((o) => {
            const isActive = o.slug === activeSlug;
            const members = membersByOrg[o.id] ?? [];
            const count = o.member_count ?? members.length;
            // Le rôle n'est connu que pour les organisations dont on est membre.
            const myRole = me.organizations.find((x) => x.id === o.id)?.role;

            return (
              <Card
                key={o.id}
                title={o.name}
                icon={Building2}
                className={cn(isActive && "border-primary/40")}
                action={
                  isActive ? (
                    <Badge
                      variant="secondary"
                      className="gap-1 border-transparent bg-primary/15 text-primary"
                    >
                      <Check className="size-3" />
                      active
                    </Badge>
                  ) : (
                    myRole && <SwitchOrgButton slug={o.slug} />
                  )
                }
              >
                <p className="font-mono text-xs text-muted-foreground">
                  {o.slug}
                </p>

                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="gap-1">
                    <Users className="size-3" />
                    {count} membre{count > 1 ? "s" : ""}
                  </Badge>
                  <Badge variant="outline" className="gap-1">
                    <Boxes className="size-3" />
                    {o.app_count ?? 0} application(s)
                  </Badge>
                  {myRole && (
                    <Badge
                      variant="secondary"
                      className={cn(
                        "gap-1 border-transparent",
                        ROLE_STYLES[myRole],
                      )}
                    >
                      <ShieldCheck className="size-3" />
                      {ROLE_LABELS[myRole] ?? myRole}
                    </Badge>
                  )}
                </div>

                <p className="mt-3 text-xs text-muted-foreground">
                  créée {formatAge(o.created_at)}
                </p>

                <div className="mt-4">
                  <Button
                    variant="outline"
                    size="sm"
                    nativeButton={false}
                    render={<Link href={`/parametres/organisations/${o.id}`} />}
                  >
                    Membres et droits
                    <ArrowRight className="size-3.5" />
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
