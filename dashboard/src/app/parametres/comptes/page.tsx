import Link from "next/link";
import { redirect } from "next/navigation";
import {
  AlertTriangle,
  Lock,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Users,
  X,
} from "lucide-react";

import { api } from "@/lib/api";
import { CreateUserDialog } from "@/components/create-dialogs";
import { UserRowActions } from "@/components/user-row-actions";
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

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const query = (q ?? "").trim().toLowerCase();

  const me = await api.me().catch(() => null);
  if (!me) redirect("/login");

  // Réservé aux administrateurs de la plateforme : l'API refuserait de toute
  // façon, mais autant l'annoncer clairement.
  if (!me.user.is_admin) {
    return (
      <>
        <Card title="Accès réservé" icon={Lock}>
          <p className="text-sm text-muted-foreground">
            Cette page est réservée aux administrateurs de la plateforme. Pour
            gérer les membres de votre organisation, voir{" "}
            <Link href="/parametres/organisations" className="text-primary hover:underline">
              Organisations
            </Link>
            .
          </p>
        </Card>
      </>
    );
  }

  // Les organisations ne servent qu'à proposer un rattachement à la création
  // d'un compte : leur gestion vit désormais dans sa propre section.
  const [users, organizations] = await Promise.all([
    api.adminListUsers().catch(() => []),
    api.adminListOrganizations().catch(() => []),
  ]);

  const admins = users.filter((u) => u.is_admin && !u.disabled).length;

  // Recherche sur le nom et l'email : les deux identifiants qu'un admin a en
  // tête quand il cherche un compte.
  const visibleUsers = query
    ? users.filter(
        (u) =>
          u.email.toLowerCase().includes(query) ||
          (u.name ?? "").toLowerCase().includes(query),
      )
    : users;

  return (
    <>
      <PageHeader
        title="Administration"
        description="Les comptes qui peuvent se connecter à la plateforme."
      >
        <CreateUserDialog organizations={organizations} />
      </PageHeader>

      <Card
        title="Comptes"
        description={
          query
            ? `${visibleUsers.length} résultat(s) sur ${users.length} compte(s).`
            : undefined
        }
        icon={Users}
        action={
          // Recherche côté serveur : le filtre reste dans l'URL, donc
          // partageable et conservé au rafraîchissement.
          <form method="get" className="flex items-center gap-2">
            <div className="relative w-full sm:w-64">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                name="q"
                key={q ?? ""}
                defaultValue={q ?? ""}
                placeholder="Rechercher un compte…"
                aria-label="Rechercher un compte par nom ou email"
                className="h-8 pl-8.5"
              />
            </div>
            {query && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Effacer la recherche"
                nativeButton={false}
                render={<Link href="/parametres/comptes" />}
              >
                <X className="size-3.5" />
              </Button>
            )}
          </form>
        }
        contentClassName="px-0"
      >
        {visibleUsers.length === 0 ? (
          <div className="px-6">
            <EmptyState
              icon={Users}
              title={
                query
                  ? "Aucun compte ne correspond"
                  : "Aucun compte"
              }
              description={
                query
                  ? `Rien ne correspond à « ${q} ».`
                  : undefined
              }
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Utilisateur</TableHead>
                  <TableHead>Statut</TableHead>
                  <TableHead>Dernière connexion</TableHead>
                  <TableHead className="w-12 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleUsers.map((u) => {
                  const isLastAdmin =
                    u.is_admin && !u.disabled && admins <= 1;
                  return (
                    <TableRow key={u.id}>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <Avatar className="size-8">
                            <AvatarFallback
                              className={cn(
                                "text-xs font-medium",
                                u.disabled
                                  ? "bg-muted text-muted-foreground"
                                  : "bg-primary/15 text-primary",
                              )}
                            >
                              {initialsOf(u.name || u.email)}
                            </AvatarFallback>
                          </Avatar>
                          <div className="min-w-0">
                            <p
                              className={cn(
                                "truncate text-sm font-medium",
                                u.disabled &&
                                  "text-muted-foreground line-through",
                              )}
                            >
                              {u.name || u.email}
                              {u.id === me.user.id && (
                                <span className="ml-2 text-xs font-normal text-muted-foreground no-underline">
                                  (vous)
                                </span>
                              )}
                            </p>
                            <p className="truncate text-xs text-muted-foreground">
                              {u.email}
                            </p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        {/* Un seul badge : le niveau du compte. L'état
                            (désactivé, mot de passe temporaire) est une
                            information distincte, en texte discret — pas un
                            second badge qui rivaliserait avec le premier. */}
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge
                            variant="secondary"
                            className={cn(
                              "gap-1 border-transparent",
                              u.is_superadmin
                                ? "bg-primary/15 text-primary"
                                : u.is_admin
                                  ? "bg-warning/15 text-warning"
                                  : "bg-muted text-muted-foreground",
                            )}
                          >
                            <ShieldCheck className="size-3" />
                            {u.is_superadmin
                              ? "Propriétaire"
                              : u.is_admin
                                ? "Admin"
                                : "Membre"}
                          </Badge>

                          {u.disabled && (
                            <span className="inline-flex items-center gap-1 text-xs text-destructive">
                              <AlertTriangle className="size-3" />
                              désactivé
                            </span>
                          )}
                          {!u.disabled && u.must_change_password && (
                            <span className="text-xs text-muted-foreground">
                              mot de passe temporaire
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {u.last_login_at
                          ? formatAge(u.last_login_at)
                          : "jamais"}
                      </TableCell>
                      <TableCell className="text-right">
                        <UserRowActions
                          user={u}
                          organizations={organizations}
                          isLastAdmin={isLastAdmin}
                          isSelf={u.id === me.user.id}
                          viewerIsSuperAdmin={me.user.is_superadmin ?? false}
                        />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>

      <Card title="Comptes et organisations" icon={SlidersHorizontal}>
        <div className="space-y-2 text-sm text-muted-foreground">
          <p>
            Un compte existe au niveau de la{" "}
            <strong className="text-foreground">plateforme</strong> : c&apos;est
            ce qui permet de se connecter. Il ne donne accès à rien tant
            qu&apos;il n&apos;est rattaché à aucune organisation.
          </p>
          <p>
            Le rôle et les droits fins — qui peut déployer, supprimer, voir
            les secrets — se règlent{" "}
            <strong className="text-foreground">par organisation</strong>,
            sur la page{" "}
            <Link
              href="/parametres/organisations"
              className="text-primary hover:underline"
            >
              Organisations
            </Link>
            . Un propriétaire y gère ses membres sans passer par un
            administrateur.
          </p>
        </div>
      </Card>
    </>
  );
}
