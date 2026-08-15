import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BookText,
  Boxes,
  ExternalLink,
  GitBranch,
  Info,
  Layers,
  Network,
  Rocket,
  Settings2,
  Terminal,
} from "lucide-react";

import { api, publicApiUrl, type Deployment, type GitRun } from "@/lib/api";
import { DeployDialog } from "@/components/deploy-dialog";
import { CiOnboardingDialog } from "@/components/ci-onboarding";
import { AppSettings } from "@/components/app-settings";
import { RunBadge } from "@/components/run-badge";
import { AutoRefresh } from "@/components/auto-refresh";
import {
  Card,
  EmptyState,
  PageHeader,
  StatusBadge,
  formatAge,
} from "@/components/ui";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card as ShadcnCard, CardContent } from "@/components/ui/card";
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

const TABS = [
  ["apercu", "Vue d'ensemble", Layers],
  ["docs", "Documentation", BookText],
  ["pipeline", "Pipeline", GitBranch],
  ["parametres", "Paramètres", Settings2],
] as const;

/**
 * Une application : le service, pas son exécution.
 *
 * Elle porte son identité, son dépôt et sa forme d'exécution ; ses
 * environnements en sont les instances, chacun avec ses propres révisions.
 * C'est ici qu'on entre, et le déploiement se fait un cran plus bas.
 */
export default async function AppDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; file?: string }>;
}) {
  const { id } = await params;
  const { tab, file } = await searchParams;
  const activeTab = TABS.some(([k]) => k === tab) ? tab! : "apercu";

  if (!(await api.me().catch(() => null))) redirect("/login");

  const app = await api.getApp(id).catch(() => null);
  if (!app) notFound();

  const deployments = await api.listAppDeployments(id).catch(() => []);

  // Révision courante de chaque environnement : c'est ce qui décrit son état
  // réel, les autres n'étant que de l'historique.
  const latest = new Map<string, Deployment>();
  const counts = new Map<string, number>();
  for (const d of deployments) {
    counts.set(d.environment, (counts.get(d.environment) ?? 0) + 1);
    const seen = latest.get(d.environment);
    if (!seen || d.revision > seen.revision) latest.set(d.environment, d);
  }
  const envs = [...latest.values()].sort((a, b) =>
    a.environment.localeCompare(b.environment),
  );

  // Les données Git ne sont chargées que sur leur onglet : ce sont des appels
  // réseau vers l'hébergeur.
  const docs =
    activeTab === "docs" && app.git_repo
      ? await api.listAppDocs(id).catch(() => [])
      : [];
  const readme = docs.find((d) => /^readme\.md$/i.test(d.name)) ?? docs[0];
  const selectedDoc = docs.find((d) => d.path === file) ?? readme;
  const doc =
    activeTab === "docs" && selectedDoc
      ? await api.getAppDoc(id, selectedDoc.path).catch(() => null)
      : null;

  const runs: GitRun[] =
    activeTab === "pipeline" && app.git_repo
      ? await api.listAppRuns(id).catch(() => [])
      : [];

  // Les modèles ne servent que sur l'onglet paramètres, où l'on écrit dans le
  // dépôt.
  const [templates, folders] =
    activeTab === "parametres"
      ? await Promise.all([
          api.listTemplates().catch(() => []),
          api.listFolders().catch(() => []),
        ])
      : [[], []];

  const failed = envs.filter((d) => d.status === "failed");
  const href = (t: string) => `/apps/${id}?tab=${t}`;

  return (
    <>
      <PageHeader title={app.name}>
        <Button
          variant="ghost"
          size="sm"
          nativeButton={false}
          render={<Link href="/apps" />}
        >
          <ArrowLeft className="size-3.5" />
          Applications
        </Button>
        <CiOnboardingDialog
          baseUrl={publicApiUrl}
          appId={app.id}
          appName={app.name}
          environment={envs[0]?.environment ?? "production"}
        />
        <DeployDialog apps={[app]} defaultAppId={app.id} />
      </PageHeader>

      {/* Carte d'identité du service. */}
      <div className="-mt-4 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-1 font-mono">
          <Network className="size-3" />
          {(app.ports ?? []).length > 1
            ? (app.ports ?? [])
                .map((p) => (p.exposed ? `${p.port}*` : String(p.port)))
                .join(" · ")
            : `port ${app.container_port}`}
        </span>
        {app.git_repo ? (
          <span className="flex items-center gap-1 font-mono">
            <GitBranch className="size-3" />
            {app.git_repo}
          </span>
        ) : (
          <Link
            href={href("parametres")}
            className="flex items-center gap-1 text-primary hover:underline"
          >
            <GitBranch className="size-3" />
            rattacher un dépôt
          </Link>
        )}
        <span className="flex items-center gap-1">
          <Layers className="size-3" />
          {envs.length} environnement{envs.length > 1 ? "s" : ""}
        </span>
      </div>

      <nav className="flex flex-wrap gap-1 border-b border-border">
        {TABS.map(([key, label, Icon]) => (
          <Link
            key={key}
            href={href(key)}
            aria-current={activeTab === key ? "page" : undefined}
            className={cn(
              "-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors",
              activeTab === key
                ? "border-primary font-medium text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-3.5" />
            {label}
            {key === "apercu" && envs.length > 0 && (
              <Badge variant="secondary" className="ml-1">
                {envs.length}
              </Badge>
            )}
          </Link>
        ))}
      </nav>

      {/* ------------------------------------------------------------------ */}
      {activeTab === "apercu" && (
        <>
          {failed.length > 0 && (
            <p className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              {failed.length} environnement(s) en échec :{" "}
              {failed.map((d) => d.environment).join(", ")}.
            </p>
          )}

          <Card
            title="Environnements"
            description="Chaque environnement est un namespace Kubernetes indépendant : sa propre configuration, ses propres variables, ses propres révisions."
            icon={Layers}
          >
            {envs.length === 0 ? (
              <EmptyState
                icon={Rocket}
                title="Aucun environnement"
                description="Le premier déploiement créera l'environnement de votre choix — production, staging, ou tout autre nom."
              >
                <DeployDialog apps={[app]} defaultAppId={app.id} />
                <CiOnboardingDialog
                  baseUrl={publicApiUrl}
                  appId={app.id}
                  appName={app.name}
                  environment="production"
                />
              </EmptyState>
            ) : (
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {envs.map((d) => (
                  <EnvCard
                    key={d.id}
                    appId={id}
                    appName={app.name}
                    deployment={d}
                    revisions={counts.get(d.environment) ?? 1}
                  />
                ))}
              </div>
            )}
          </Card>

          {envs.length === 0 && (
            <Card title="Comment déployer" icon={Info}>
              <div className="space-y-3 text-sm text-muted-foreground">
                <p className="flex items-start gap-2">
                  <Terminal className="mt-0.5 size-4 shrink-0" />
                  <span>
                    <strong className="text-foreground">
                      Depuis votre CI
                    </strong>{" "}
                    — votre pipeline construit l&apos;image, la publie, puis
                    appelle Kybers. C&apos;est le chemin de production.
                  </span>
                </p>
                <p className="flex items-start gap-2">
                  <Rocket className="mt-0.5 size-4 shrink-0" />
                  <span>
                    <strong className="text-foreground">À la main</strong> —
                    depuis une image déjà publiée, pour tester ou dépanner.
                  </span>
                </p>
              </div>
            </Card>
          )}
        </>
      )}

      {/* ------------------------------------------------------------------ */}
      {activeTab === "docs" && (
        <Card
          title="Documentation"
          description={app.git_repo ? `Fichiers Markdown de ${app.git_repo}.` : undefined}
          icon={BookText}
        >
          {!app.git_repo ? (
            <EmptyState
              icon={GitBranch}
              title="Aucun dépôt rattaché"
              description="Rattachez un dépôt dans les paramètres pour afficher sa documentation."
            >
              <Button
                variant="outline"
                size="sm"
                nativeButton={false}
                render={<Link href={href("parametres")} />}
              >
                Rattacher un dépôt
              </Button>
            </EmptyState>
          ) : docs.length === 0 ? (
            <EmptyState
              icon={BookText}
              title="Aucun document"
              description="Aucun fichier Markdown trouvé à la racine du dépôt."
            />
          ) : (
            <div className="flex flex-col gap-4">
              {docs.length > 1 && (
                <nav className="flex flex-wrap gap-1" aria-label="Documents">
                  {docs.map((d) => {
                    const active = d.path === selectedDoc?.path;
                    return (
                      <Link
                        key={d.path}
                        href={`/apps/${id}?tab=docs&file=${encodeURIComponent(d.path)}`}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "rounded-md px-2.5 py-1 font-mono text-xs transition-colors",
                          active
                            ? "bg-muted font-medium text-foreground"
                            : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                        )}
                      >
                        {d.name}
                      </Link>
                    );
                  })}
                </nav>
              )}

              {doc?.html ? (
                // Le HTML vient du rendu Markdown de l'hébergeur, qui échappe
                // déjà le contenu.
                <div
                  className="prose-kybers max-w-none text-sm"
                  dangerouslySetInnerHTML={{ __html: doc.html }}
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  Document illisible pour le moment.
                </p>
              )}
            </div>
          )}
        </Card>
      )}

      {/* ------------------------------------------------------------------ */}
      {activeTab === "pipeline" && (
        <Card
          title="Pipeline"
          description={app.git_repo ? `Dernières exécutions de ${app.git_repo}.` : undefined}
          icon={GitBranch}
          contentClassName="px-0"
        >
          {!app.git_repo ? (
            <div className="px-6">
              <EmptyState
                icon={GitBranch}
                title="Aucun dépôt rattaché"
                description="Rattachez un dépôt dans les paramètres pour suivre ses pipelines."
              >
                <Button
                  variant="outline"
                  size="sm"
                  nativeButton={false}
                  render={<Link href={href("parametres")} />}
                >
                  Rattacher un dépôt
                </Button>
              </EmptyState>
            </div>
          ) : runs.length === 0 ? (
            <div className="px-6">
              <EmptyState
                icon={GitBranch}
                title="Aucune exécution"
                description="Aucun workflow n'a encore tourné sur ce dépôt."
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Workflow</TableHead>
                    <TableHead>Branche</TableHead>
                    <TableHead>Commit</TableHead>
                    <TableHead>Par</TableHead>
                    <TableHead>Statut</TableHead>
                    <TableHead>Démarré</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {runs.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="font-medium">
                        <a
                          href={r.html_url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 hover:text-primary"
                        >
                          {r.name}
                          <ExternalLink className="size-3 shrink-0" />
                        </a>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {r.branch}
                      </TableCell>
                      <TableCell className="max-w-[28ch] truncate text-xs text-muted-foreground">
                        <span className="font-mono">{r.commit.slice(0, 7)}</span>
                        {r.message ? ` ${r.message}` : ""}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {r.actor}
                      </TableCell>
                      <TableCell>
                        <RunBadge run={r} />
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {formatAge(r.started_at)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </Card>
      )}

      {/* ------------------------------------------------------------------ */}
      {activeTab === "parametres" && (
        <AppSettings
          app={app}
          environments={envs.length}
          baseUrl={publicApiUrl}
          templates={templates}
          folders={folders}
        />
      )}

      {activeTab === "apercu" && <AutoRefresh />}
    </>
  );
}

/** Carte d'un environnement : son état courant et l'accès à son détail. */
function EnvCard({
  appId,
  appName,
  deployment: d,
  revisions,
}: {
  appId: string;
  appName: string;
  deployment: Deployment;
  revisions: number;
}) {
  const failed = d.status === "failed";
  const href = `/apps/${appId}/${encodeURIComponent(d.environment)}`;

  return (
    <ShadcnCard
      className={cn(
        "gap-0 py-0 transition-colors hover:border-primary/40",
        failed && "border-destructive/30",
      )}
    >
      <CardContent className="flex h-full flex-col p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <Link
              href={href}
              className="group flex items-center gap-1.5 font-medium transition-colors hover:text-primary"
            >
              <span className="truncate font-mono">{d.environment}</span>
              <ArrowRight className="size-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
            </Link>
            <p className="flex items-center gap-1 truncate font-mono text-xs text-muted-foreground">
              <Boxes className="size-3 shrink-0" />
              {appName}-{d.environment}
            </p>
          </div>

          <StatusBadge status={d.status} />
        </div>

        <dl className="mt-4 space-y-1.5 text-xs">
          <Row label="Image" value={d.image} mono />
          <Row
            label="Révision"
            value={`rev${d.revision} · ${revisions} au total`}
          />
          <Row label="Replicas" value={String(d.replicas)} />
          <Row label="Mis à jour" value={formatAge(d.updated_at)} />
        </dl>

        {failed && (d.reason || d.message) && (
          <p className="mt-3 rounded-md bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
            {d.reason || d.message}
          </p>
        )}

        <div className="mt-4 flex items-center justify-between gap-2">
          {d.url ? (
            <a
              href={d.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-w-0 items-center gap-1 text-xs text-primary hover:underline"
            >
              <ExternalLink className="size-3 shrink-0" />
              <span className="truncate">{d.url}</span>
            </a>
          ) : (
            <span />
          )}
          <Button
            variant="outline"
            size="sm"
            nativeButton={false}
            render={<Link href={href} />}
          >
            Ouvrir
          </Button>
        </div>
      </CardContent>
    </ShadcnCard>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className={cn("truncate", mono && "font-mono")}>{value}</dd>
    </div>
  );
}
