import Link from "next/link";
import { redirect } from "next/navigation";
import {
  AlertTriangle,
  Building2,
  Check,
  KeyRound,
  Mail,
  ShieldCheck,
  UserCog,
} from "lucide-react";

import { api, activeOrganization } from "@/lib/api";
import { ChangePasswordDialog } from "@/components/password-form";
import { SwitchOrgButton } from "@/components/switch-org";
import { Card, Field, formatAge } from "@/components/ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Separator } from "@/components/ui/separator";
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

export default async function ProfilPage() {
  const me = await api.me().catch(() => null);
  if (!me) redirect("/login");

  const { user, organizations } = me;
  const activeId = (await activeOrganization(organizations))?.id;

  const initials =
    (user.name || user.email)
      .split(/[\s@.]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase())
      .join("") || "?";

  return (
    <>
      {/* Un mot de passe temporaire doit être remplacé : le signaler en tête
          plutôt que de laisser l'utilisateur le découvrir à la déconnexion. */}
      {user.must_change_password && (
        <p className="flex items-start gap-2 rounded-md bg-warning/10 px-3 py-2 text-sm text-warning">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          Votre mot de passe est temporaire : remplacez-le ci-dessous.
        </p>
      )}

      <Card title="Compte" icon={UserCog}>
        <div className="flex flex-wrap items-center gap-4">
          <Avatar className="size-14">
            <AvatarFallback className="bg-primary/15 text-base font-medium text-primary">
              {initials}
            </AvatarFallback>
          </Avatar>

          <div className="min-w-0 space-y-1">
            <p className="text-lg font-semibold tracking-tight">
              {user.name || user.email}
            </p>
            <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Mail className="size-3.5" />
              {user.email}
            </p>
          </div>

          {(user.is_superadmin || user.is_admin) && (
            <Badge
              variant="secondary"
              className={cn(
                "gap-1 border-transparent",
                user.is_superadmin
                  ? "bg-primary/15 text-primary"
                  : "bg-warning/15 text-warning",
              )}
            >
              <ShieldCheck className="size-3" />
              {user.is_superadmin ? "Propriétaire" : "Admin"}
            </Badge>
          )}
        </div>

        <Separator className="my-5" />

        <div className="grid gap-5 sm:grid-cols-3">
          <Field label="Compte créé" value={formatAge(user.created_at)} />
          <Field
            label="Dernière connexion"
            value={user.last_login_at ? formatAge(user.last_login_at) : "jamais"}
          />
          <Field
            label="Identifiant"
            value={user.id}
            mono
          />
        </div>
      </Card>

      <Card
        title="Mes organisations"
        description="L'organisation active détermine les applications, clusters et registries que vous voyez."
        icon={Building2}
      >
        {organizations.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Vous n&apos;appartenez à aucune organisation : un administrateur doit
            vous y rattacher pour que vous puissiez déployer.
          </p>
        ) : (
          <div className="space-y-2">
            {organizations.map((o) => {
              const isActive = o.id === activeId;
              return (
                <div
                  key={o.id}
                  className={cn(
                    "flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 transition-colors",
                    isActive ? "border-primary/40 bg-primary/5" : "border-border",
                  )}
                >
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 font-medium">
                      {o.name}
                      {o.role && (
                        <Badge
                          variant="secondary"
                          className={cn(
                            "border-transparent",
                            ROLE_STYLES[o.role],
                          )}
                        >
                          {ROLE_LABELS[o.role] ?? o.role}
                        </Badge>
                      )}
                    </p>
                    <p className="font-mono text-xs text-muted-foreground">
                      {o.slug}
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    {isActive ? (
                      <Badge
                        variant="secondary"
                        className="gap-1 border-transparent bg-primary/15 text-primary"
                      >
                        <Check className="size-3" />
                        active
                      </Badge>
                    ) : (
                      <SwitchOrgButton slug={o.slug} />
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      nativeButton={false}
                      render={<Link href={`/parametres/organisations/${o.id}`} />}
                    >
                      Ouvrir
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Card title="Sécurité" icon={KeyRound}>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <p className="text-sm font-medium">Mot de passe</p>
            <p className="text-sm text-muted-foreground">
              {user.must_change_password
                ? "Temporaire : remplacez-le pour retrouver un accès normal."
                : "Changez-le si vous pensez qu'il a été exposé."}
            </p>
          </div>
          <ChangePasswordDialog />
        </div>
      </Card>
    </>
  );
}
