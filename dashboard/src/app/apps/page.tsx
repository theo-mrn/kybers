import { redirect } from "next/navigation";
import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  GitBranch,
  Layers,
  LayoutGrid,
  Network,
  Rocket,
  Search,
  X,
} from "lucide-react";

import {
  api,
  publicApiUrl,
  type App,
  type Deployment,
  type GitStatus,
} from "@/lib/api";
import { CreateAppDialog } from "@/components/create-app-dialog";
import {
  Card,
  EmptyState,
  PageHeader,
  StatusBadge,
  formatAge,
} from "@/components/ui";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Card as ShadcnCard, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function AppsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const query = (q ?? "").trim().toLowerCase();

  if (!(await api.me().catch(() => null))) redirect("/login");

  const [apps, deployments, gitStatus, templates, folders] = await Promise.all([
    api.listApps().catch(() => []),
    api.listDeployments().catch(() => []),
    // Conditionne ce que l'étape « dépôt » du parcours de création propose :
    // rattacher, créer, ou prévenir que rien ne sera lu.
    api.gitStatus().catch(() => ({ configured: false }) as GitStatus),
    // Les modèles de l'organisation priment sur ceux de Kybers dans le
    // parcours de création.
    api.listTemplates().catch(() => []),
    api.listFolders().catch(() => []),
  ]);

  // Dernière révision de chaque environnement, par application : c'est ce qui
  // décrit l'état réel de l'application.
  const latest = new Map<string, Deployment>();
  for (const d of deployments) {
    const key = `${d.app_id}/${d.environment}`;
    const seen = latest.get(key);
    if (!seen || d.revision > seen.revision) latest.set(key, d);
  }
  const current = [...latest.values()];

  const visibleApps = query
    ? apps.filter(
        (a) =>
          a.name.toLowerCase().includes(query) ||
          (a.git_repo ?? "").toLowerCase().includes(query),
      )
    : apps;

  const running = current.filter((d) => d.status === "running").length;
  const failed = current.filter((d) => d.status === "failed").length;
  const deployed = new Set(current.map((d) => d.app_id)).size;

  return (
    <>
      <PageHeader
        title="Applications"
        description="Vos services, leur dépôt et l'état de leurs environnements."
      >
        <CreateAppDialog
            gitStatus={gitStatus}
            baseUrl={publicApiUrl}
            templates={templates}
            folders={folders}
          />
      </PageHeader>

      {apps.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Applications" value={apps.length} icon={Layers} tone="default" />
          <Stat label="Déployées" value={deployed} icon={Rocket} tone="default" />
          <Stat label="Environnements en ligne" value={running} icon={CheckCircle2} tone="success" />
          <Stat label="En échec" value={failed} icon={AlertTriangle} tone="danger" />
        </div>
      )}

      <Card
        title="Catalogue"
        description={
          query
            ? `${visibleApps.length} résultat(s) sur ${apps.length} application(s).`
            : "Une application se déploie dans un namespace par environnement."
        }
        icon={LayoutGrid}
        action={
          apps.length > 0 && (
            <form method="get" className="flex items-center gap-2">
              <div className="relative w-full sm:w-64">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  name="q"
                  key={q ?? ""}
                  defaultValue={q ?? ""}
                  placeholder="Rechercher une application…"
                  aria-label="Rechercher une application par nom ou dépôt"
                  className="h-8 pl-8.5"
                />
              </div>
              {query && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Effacer la recherche"
                  nativeButton={false}
                  render={<Link href="/apps" />}
                >
                  <X className="size-3.5" />
                </Button>
              )}
            </form>
          )
        }
      >
        {visibleApps.length === 0 ? (
          query ? (
            <EmptyState
              icon={Search}
              title="Aucune application ne correspond"
              description={`Rien ne correspond à « ${q} ».`}
            />
          ) : (
            <EmptyState
              icon={LayoutGrid}
              title="Aucune application"
              description="Déclarez votre premier service : son nom, son dépôt et ses ports. Les déploiements viendront ensuite."
            >
              <CreateAppDialog
            gitStatus={gitStatus}
            baseUrl={publicApiUrl}
            templates={templates}
            folders={folders}
          />
            </EmptyState>
          )
        ) : (
          /* Grille : une carte par application. En liste pleine largeur, une
             seule application laissait un bandeau vide sur tout l'écran. */
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {visibleApps.map((a) => (
              <AppCard
                key={a.id}
                app={a}
                envs={current.filter((d) => d.app_id === a.id)}
              />
            ))}
          </div>
        )}
      </Card>
    </>
  );
}

/** Carte d'une application : identité, environnements, actions. */
function AppCard({
  app,
  envs,
}: {
  app: App;
  envs: Deployment[];
}) {
  // Un environnement en échec doit se voir sur la carte, sans l'ouvrir.
  const broken = envs.some((d) => d.status === "failed");
  // L'URL publique la plus récente : le raccourci le plus utile depuis ici.
  const live = envs.find((d) => d.url && d.status === "running");

  return (
    <ShadcnCard
      className={cn(
        "gap-0 py-0 transition-colors hover:border-primary/40",
        broken && "border-destructive/30",
      )}
    >
      <CardContent className="flex h-full flex-col p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <Link
              href={`/apps/${app.id}`}
              className="group flex items-center gap-1.5 font-medium transition-colors hover:text-primary"
            >
              <span className="truncate">{app.name}</span>
              <ArrowRight className="size-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
            </Link>

            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-1 font-mono">
                <Network className="size-3" />
                {app.container_port}
              </span>
              {app.git_repo && (
                <span className="flex min-w-0 items-center gap-1 font-mono">
                  <GitBranch className="size-3 shrink-0" />
                  <span className="truncate">{app.git_repo}</span>
                </span>
              )}
            </div>
          </div>

          {live && (
            <a
              href={live.url}
              target="_blank"
              rel="noreferrer"
              aria-label={`Ouvrir ${app.name}`}
              title={live.url}
              className="shrink-0 text-muted-foreground transition-colors hover:text-primary"
            >
              <ExternalLink className="size-4" />
            </a>
          )}
        </div>

        <Separator className="my-3" />

        {envs.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            {envs.map((d) => (
              <Link
                key={d.id}
                href={`/apps/${app.id}/${encodeURIComponent(d.environment)}`}
                className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-muted"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-mono font-medium">
                    {d.environment}
                  </span>
                  <StatusBadge status={d.status} />
                </span>
                <span className="flex shrink-0 items-center gap-2 text-muted-foreground">
                  <span className="font-mono">rev{d.revision}</span>
                  <span>{formatAge(d.updated_at)}</span>
                </span>
              </Link>
            ))}
          </div>
        ) : (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Activity className="size-3.5" />
            Jamais déployée.
          </p>
        )}

        {/* La carte mène au service ; le déploiement se fait depuis lui, où
            l'on voit ses environnements. */}
        <div className="mt-4 flex justify-end pt-0">
          <Button
            variant="outline"
            size="sm"
            nativeButton={false}
            render={<Link href={`/apps/${app.id}`} />}
          >
            Ouvrir
            <ArrowRight className="size-3.5" />
          </Button>
        </div>
      </CardContent>
    </ShadcnCard>
  );
}

/** Tuile de synthèse. */
function Stat({
  label,
  value,
  icon: Icon,
  tone,
}: {
  label: string;
  value: number;
  icon: React.ComponentType<{ className?: string }>;
  tone: "default" | "success" | "danger";
}) {
  const tones = {
    default: "text-muted-foreground bg-muted",
    success: "text-success bg-success/10",
    danger: "text-destructive bg-destructive/10",
  } as const;

  return (
    <ShadcnCard>
      <CardContent className="flex items-center gap-4">
        <div
          className={cn(
            "flex size-10 shrink-0 items-center justify-center rounded-lg",
            tones[tone],
          )}
        >
          <Icon className="size-5" />
        </div>
        <div className="min-w-0">
          <p className="text-2xl font-semibold tracking-tight tabular">{value}</p>
          <p className="truncate text-xs text-muted-foreground">{label}</p>
        </div>
      </CardContent>
    </ShadcnCard>
  );
}
