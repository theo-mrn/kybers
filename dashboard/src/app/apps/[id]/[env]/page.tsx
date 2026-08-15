import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  ArrowLeft,
  Boxes,
  ExternalLink,
  FileText,
  History,
  KeyRound,
  Network,
  Rocket,
  RotateCcw,
  ScrollText,
  Settings2,
  Variable,
} from "lucide-react";

import { api, publicApiUrl } from "@/lib/api";
import {
  LifecycleBar,
  RollbackButton,
  LogFollowButton,
  VarsForm,
} from "@/components/forms";
import { ConfigForm } from "@/components/config-form";
import { PortsForm } from "@/components/ports-form";
import { DeployDialog } from "@/components/deploy-dialog";
import { Provenance, SourceBadge } from "@/components/provenance";
import { CiOnboardingDialog } from "@/components/ci-onboarding";
import { AutoRefresh } from "@/components/auto-refresh";
import {
  Card,
  EmptyState,
  Field,
  PageHeader,
  StatusBadge,
  formatAge,
} from "@/components/ui";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
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
  ["etat", "État", Rocket],
  ["config", "Configuration", Settings2],
  ["variables", "Variables", Variable],
  ["logs", "Logs & events", ScrollText],
  ["revisions", "Révisions", History],
] as const;

/**
 * Un environnement d'une application.
 *
 * C'est l'unité que l'on manipule réellement : un namespace Kubernetes, sa
 * configuration, ses variables et sa suite de révisions. L'application n'est
 * qu'un regroupement au-dessus.
 */
export default async function EnvironmentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; env: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id, env } = await params;
  const environment = decodeURIComponent(env);
  const { tab } = await searchParams;
  const activeTab = TABS.some(([k]) => k === tab) ? tab! : "etat";

  if (!(await api.me().catch(() => null))) redirect("/login");

  const app = await api.getApp(id).catch(() => null);
  if (!app) notFound();

  const allDeployments = await api.listAppDeployments(id).catch(() => []);
  const revisions = allDeployments
    .filter((d) => d.environment === environment)
    .sort((a, b) => b.revision - a.revision);

  // Un environnement n'existe que par ses déploiements : sans révision, il n'y
  // a rien à afficher.
  if (revisions.length === 0) notFound();
  const current = revisions[0];

  const [config, registries, secretKeys, envVars] = await Promise.all([
    api.getConfig(id, environment).catch(() => null),
    api.listRegistries().catch(() => []),
    api.listSecretKeys(id, environment).catch(() => ({ keys: [] })),
    api.getEnv(id, environment).catch(() => ({}) as Record<string, string>),
  ]);

  // Logs et events ne sont chargés que sur l'onglet correspondant : ce sont
  // les requêtes les plus lourdes.
  const [logs, events] =
    activeTab === "logs"
      ? await Promise.all([
          api.getLogs(current.id, 200).catch(() => []),
          api.getEvents(current.id, 50).catch(() => []),
        ])
      : [[], []];

  const namespace = `${app.name}-${environment}`;
  const href = (t: string) =>
    `/apps/${id}/${encodeURIComponent(environment)}?tab=${t}`;

  return (
    <>
      <PageHeader title={`${app.name} / ${environment}`}>
        <Button
          variant="ghost"
          size="sm"
          nativeButton={false}
          render={<Link href={`/apps/${id}`} />}
        >
          <ArrowLeft className="size-3.5" />
          {app.name}
        </Button>
        <CiOnboardingDialog
          baseUrl={publicApiUrl}
          appId={id}
          appName={app.name}
          environment={environment}
        />
        <DeployDialog
          apps={[app]}
          defaultAppId={app.id}
          defaultEnvironment={environment}
          defaultImage={current.image}
        />
      </PageHeader>

      {/* Le namespace est ce que l'environnement produit concrètement sur le
          cluster : l'afficher lève l'ambiguïté du nom court. */}
      <div className="-mt-4 flex flex-wrap items-center gap-2">
        <StatusBadge status={current.status} />
        <Badge variant="outline" className="gap-1 font-mono">
          <Boxes className="size-3" />
          {namespace}
        </Badge>
        <Badge variant="outline" className="font-mono">
          rev{current.revision}
        </Badge>
        {current.url && (
          <a
            href={current.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
          >
            <ExternalLink className="size-3" />
            {current.url}
          </a>
        )}
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
            {key === "revisions" && (
              <Badge variant="secondary" className="ml-1">
                {revisions.length}
              </Badge>
            )}
          </Link>
        ))}
      </nav>

      {/* ------------------------------------------------------------------ */}
      {activeTab === "etat" && (
        <Card title="État courant" icon={Rocket}>
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Statut" value={<StatusBadge status={current.status} />} />
            <Field label="Révision" value={current.revision} mono />
            <Field label="Replicas" value={current.replicas} mono />
            <Field label="Namespace" value={namespace} mono />
            <Field label="Image" value={current.image} mono />
            <Field
              label="URL"
              value={
                current.url ? (
                  <a
                    href={current.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-primary hover:underline"
                  >
                    <ExternalLink className="size-3" />
                    {current.url}
                  </a>
                ) : (
                  "—"
                )
              }
            />
            <Field label="Mis à jour" value={formatAge(current.updated_at)} />
            <Field
              label="Déclenché par"
              value={current.source ? <SourceBadge source={current.source} /> : "—"}
            />
            <Field
              label="Registry"
              value={config?.registry_name || "aucun (public)"}
            />
          </div>

          {(current.git_commit || current.git_ref) && (
            <div className="mt-5 rounded-lg border border-border p-3">
              <p className="mb-1.5 text-xs font-medium text-muted-foreground">
                Code déployé
              </p>
              <Provenance deployment={current} gitRepo={app.git_repo} />
            </div>
          )}

          {(current.reason || current.message) && (
            <p
              className={cn(
                "mt-5 rounded-md px-3 py-2 text-xs",
                current.status === "failed"
                  ? "bg-destructive/10 text-destructive"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {current.reason || current.message}
            </p>
          )}

          <Separator className="my-5" />

          <LifecycleBar
            deploymentId={current.id}
            replicas={current.replicas}
            stopped={current.status === "stopped" || current.replicas === 0}
          />
        </Card>
      )}

      {/* ------------------------------------------------------------------ */}
      {activeTab === "config" && (
        <div className="flex flex-col gap-6">
          <Card
            title="Ports"
            description="Les ports ouverts par l'image. Un seul reçoit le trafic public ; les autres restent joignables dans le cluster."
            icon={Network}
          >
            <PortsForm appId={id} ports={app.ports ?? []} />
          </Card>

        <Card title="Configuration d'exécution" icon={Settings2}>
          {config ? (
            <ConfigForm
              appId={id}
              environment={environment}
              config={config}
              registries={registries}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              Configuration indisponible.
            </p>
          )}
        </Card>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {activeTab === "variables" && (
        <div className="grid items-start gap-6 lg:grid-cols-2">
          <Card
            title="Variables"
            description="Injectées via une ConfigMap."
            icon={Variable}
          >
            {Object.keys(envVars).length > 0 && (
              <ul className="mb-4 space-y-1.5 rounded-md border border-border bg-muted/40 p-3">
                {Object.entries(envVars).map(([k, v]) => (
                  <li key={k} className="font-mono text-xs break-all">
                    <span className="text-foreground">{k}</span>
                    <span className="text-muted-foreground">={v}</span>
                  </li>
                ))}
              </ul>
            )}
            <VarsForm appId={id} environment={environment} kind="env" />
          </Card>

          <Card
            title="Secrets"
            description="Chiffrés en base, injectés via un Secret Kubernetes. Les valeurs ne sont jamais relues par l'interface."
            icon={KeyRound}
          >
            {secretKeys.keys.length > 0 ? (
              <ul className="mb-4 space-y-1.5 rounded-md border border-border bg-muted/40 p-3">
                {secretKeys.keys.map((k) => (
                  <li key={k} className="flex items-center gap-2 font-mono text-xs">
                    <KeyRound className="size-3 text-muted-foreground" />
                    {k}
                    <span className="text-muted-foreground">••••••</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mb-4 text-xs text-muted-foreground">
                Aucun secret défini.
              </p>
            )}
            <VarsForm appId={id} environment={environment} kind="secret" />
          </Card>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {activeTab === "logs" && (
        <div className="flex flex-col gap-6">
          <Card
            title="Logs"
            icon={ScrollText}
            action={<LogFollowButton deploymentId={current.id} following={false} />}
          >
            {logs.length === 0 ? (
              <EmptyState
                icon={ScrollText}
                title="Aucun log"
                description="Démarrez le suivi pour recevoir les lignes en continu."
              />
            ) : (
              <pre className="max-h-96 overflow-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
                {logs.map((l, i) => (
                  <div key={i}>
                    <span className="text-muted-foreground">{l.pod_name} </span>
                    {l.line}
                  </div>
                ))}
              </pre>
            )}
          </Card>

          <Card title="Events Kubernetes" icon={FileText}>
            {events.length === 0 ? (
              <p className="text-sm text-muted-foreground">Aucun event.</p>
            ) : (
              <ul className="space-y-2">
                {events.map((e, i) => (
                  <li key={i} className="flex flex-wrap items-baseline gap-2 text-xs">
                    <Badge
                      variant="secondary"
                      className={cn(
                        "border-transparent",
                        e.type === "Warning"
                          ? "bg-warning/15 text-warning"
                          : "bg-muted text-muted-foreground",
                      )}
                    >
                      {e.type}
                    </Badge>
                    <span className="font-medium">{e.reason}</span>
                    <span className="text-muted-foreground">{e.message}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {activeTab === "revisions" && (
        <Card
          title="Révisions"
          description="Chaque déploiement crée une révision ; revenir en arrière en crée une nouvelle."
          icon={History}
          contentClassName="px-0"
        >
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Rév.</TableHead>
                  <TableHead>Image</TableHead>
                  <TableHead>Provenance</TableHead>
                  <TableHead className="text-right">Replicas</TableHead>
                  <TableHead>Statut</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {revisions.map((d, i) => (
                  <TableRow key={d.id} className={cn(i > 0 && "opacity-70")}>
                    <TableCell className="font-mono text-xs">
                      <span className="inline-flex items-center gap-1.5">
                        {d.revision}
                        {d.rolled_back_from ? (
                          <RotateCcw className="size-3 text-warning" />
                        ) : null}
                        {i === 0 ? (
                          <Badge
                            variant="secondary"
                            className="border-transparent bg-primary/15 text-primary"
                          >
                            courante
                          </Badge>
                        ) : null}
                      </span>
                    </TableCell>
                    <TableCell className="max-w-[26ch] truncate font-mono text-xs text-muted-foreground">
                      {d.image}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        <SourceBadge source={d.source} />
                        <Provenance deployment={d} gitRepo={app.git_repo} />
                      </div>
                    </TableCell>
                    <TableCell className="text-right">{d.replicas}</TableCell>
                    <TableCell>
                      <StatusBadge status={d.status} />
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {formatAge(d.created_at)}
                    </TableCell>
                    <TableCell className="text-right">
                      {i > 0 ? (
                        <RollbackButton
                          deploymentId={d.id}
                          revision={d.revision}
                        />
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Card>
      )}

      {activeTab === "etat" || activeTab === "logs" ? <AutoRefresh /> : null}
    </>
  );
}
