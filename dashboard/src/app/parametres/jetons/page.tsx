import { redirect } from "next/navigation";
import {
  Check,
  GitBranch,
  Info,
  KeyRound,
  Plug,
  Terminal,
  TriangleAlert,
  XCircle,
} from "lucide-react";

import { api, activeOrganization, type GitStatus } from "@/lib/api";
import { DeleteTokenButton } from "@/components/auth-forms";
import { CreateTokenDialog } from "@/components/team-dialogs";
import { Card, EmptyState, formatAge } from "@/components/ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { GitSettingsDialog } from "@/components/git-settings-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Les jetons appartiennent au compte, pas à l'organisation : ils héritent des
 * droits de leur porteur. Ils ont donc leur propre page plutôt qu'un onglet
 * sous Organisations, où on les croirait partagés avec l'équipe.
 */
export default async function JetonsPage() {
  const me = await api.me().catch(() => null);
  if (!me) redirect("/login");

  const [tokens, gitStatus] = await Promise.all([
    api.listTokens().catch(() => []),
    api.gitStatus().catch(() => ({ configured: false }) as GitStatus),
  ]);
  const currentOrg = await activeOrganization(me.organizations);

  return (
    <>
      <Card
        title="Vos jetons"
        description="Pour la CLI et l'intégration continue. Un jeton agit en votre nom."
        icon={KeyRound}
        action={<CreateTokenDialog />}
        contentClassName="px-0"
      >
        {tokens.length === 0 ? (
          <div className="px-6">
            <EmptyState
              icon={KeyRound}
              title="Aucun jeton"
              description="Créez-en un pour déployer depuis votre CLI ou votre intégration continue."
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nom</TableHead>
                  <TableHead>Jeton</TableHead>
                  <TableHead>Dernier usage</TableHead>
                  <TableHead>Expire</TableHead>
                  <TableHead className="w-12 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tokens.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="font-medium">{t.name}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {t.prefix}…
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {t.last_used_at ? formatAge(t.last_used_at) : "jamais"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {t.expires_at ? formatAge(t.expires_at) : "jamais"}
                    </TableCell>
                    <TableCell className="text-right">
                      <DeleteTokenButton token={t} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>

      <Card
        title="Jeton GitHub de l'instance"
        description="Celui que Kybers utilise pour lire vos dépôts — distinct des jetons ci-dessus, qui servent à appeler Kybers."
        icon={GitBranch}
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 space-y-2 text-sm text-muted-foreground">
            {gitStatus.configured && gitStatus.valid ? (
              <p className="flex items-center gap-2 text-success">
                <Check className="size-4 shrink-0" />
                Connecté en tant que{" "}
                <span className="font-mono">{gitStatus.login}</span>
                {gitStatus.can_create === false && (
                  <Badge variant="outline">lecture seule</Badge>
                )}
              </p>
            ) : gitStatus.configured ? (
              <p className="flex items-start gap-2 text-destructive">
                <XCircle className="mt-0.5 size-4 shrink-0" />
                Jeton refusé : {gitStatus.error ?? "accès impossible"}
              </p>
            ) : (
              <p className="flex items-start gap-2 text-warning">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                Aucun jeton configuré : documentation, pipelines et création de
                dépôts sont indisponibles.
              </p>
            )}

            <p className="text-xs">
              Il vaut pour toute l&apos;instance et n&apos;est modifiable que
              par un administrateur.
            </p>
          </div>

          {me.user.is_admin && (
            <GitSettingsDialog
              trigger={
                <Button size="sm" variant={gitStatus.valid ? "outline" : "default"}>
                  <Plug className="size-3.5" />
                  {gitStatus.configured ? "Remplacer le jeton" : "Connecter GitHub"}
                </Button>
              }
            />
          )}
        </div>

        <div className="mt-4 space-y-1.5 rounded-lg border border-border p-3 text-xs text-muted-foreground">
          <p className="font-medium text-foreground">Droits nécessaires</p>
          <p>
            <strong className="text-foreground">Lire</strong> la documentation
            et les pipelines — <code className="font-mono">Contents: read</code>{" "}
            + <code className="font-mono">Actions: read</code>.
          </p>
          <p>
            <strong className="text-foreground">Créer</strong> des dépôts —{" "}
            <code className="font-mono">Administration: write</code>, ou la
            portée <code className="font-mono">repo</code>.
          </p>
          <p>
            <strong className="text-foreground">Installer la pipeline</strong> —{" "}
            <code className="font-mono">Contents: write</code> +{" "}
            <code className="font-mono">Secrets: write</code> +{" "}
            <code className="font-mono">Workflows: write</code>, ou les portées{" "}
            <code className="font-mono">repo</code> et{" "}
            <code className="font-mono">workflow</code> d&apos;un jeton
            classique.
          </p>
        </div>
      </Card>

      <Card title="Portée d'un jeton" icon={Info}>
        <div className="space-y-2 text-sm text-muted-foreground">
          <p className="flex items-start gap-2 rounded-md bg-warning/10 px-3 py-2 text-warning">
            <Terminal className="mt-0.5 size-3.5 shrink-0" />
            Un jeton marqué <strong className="font-medium">pipeline</strong> a
            été déposé dans les secrets d&apos;un dépôt : le révoquer fera
            échouer ses déploiements automatiques.
          </p>
          <p>
            Un jeton est <strong className="text-foreground">personnel</strong> :
            il n&apos;est pas partagé avec les autres membres et disparaît si
            votre compte est désactivé.
          </p>
          <p>
            Il agit dans l&apos;organisation active
            {currentOrg && (
              <>
                {" "}
                — actuellement{" "}
                <Badge variant="outline" className="font-mono">
                  {currentOrg.slug}
                </Badge>
              </>
            )}{" "}
            et ne peut rien faire que vous ne puissiez faire vous-même.
          </p>
        </div>
      </Card>
    </>
  );
}
