import { redirect } from "next/navigation";
import {
  Activity,
  AlertTriangle,
  Boxes,
  CheckCircle2,
  CircleDashed,
  Cpu,
  Database,
  Globe,
  HardDrive,
  Lock,
  MemoryStick,
  Network,
  Plug,
  Server,
  ServerCrash,
} from "lucide-react";

import { api, type InfraCluster, type ClusterInfo } from "@/lib/api";
import { ClusterDialog } from "@/components/cluster-dialog";
import { ClusterTabs } from "@/components/cluster-tabs";
import { DeleteClusterButton } from "@/components/cluster-form";
import { AutoRefresh } from "@/components/auto-refresh";
import {
  Card,
  EmptyState,
  Field,
  PageHeader,
  StatusDot,
  formatAge,
} from "@/components/ui";
import { MetricsSourceSelect } from "@/components/metrics-source";
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
import { UsageChart } from "@/components/usage-chart";
import {
  UsageBar,
  GpuUsage,
  NodeUsageRows,
  AppUsageTable,
  formatCPU,
  formatBytes,
} from "@/components/usage";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function InfraPage() {
  if (!(await api.me().catch(() => null))) redirect("/login");

  const infra = await api.getInfra().catch(() => null);

  const controlPlaneAddr =
    process.env.KYBERS_AGENT_ADDR ?? "CONTROL_PLANE_HOST:9090";

  if (!infra) {
    return (
      <>
        <PageHeader
          title="Infrastructure"
          description="État du plan de contrôle et des clusters pilotés."
        />
        <Card title="Control Plane injoignable" icon={ServerCrash}>
          <p className="text-sm text-muted-foreground">
            L&apos;API ne répond pas. Vérifiez que la stack est démarrée :
          </p>
          <pre className="mt-3 rounded-lg border border-border bg-muted/40 p-3 font-mono text-xs select-all">
            docker compose up -d
          </pre>
        </Card>
        <AutoRefresh />
      </>
    );
  }

  const cp = infra.control_plane;
  const connected = infra.clusters.filter((c) => c.connected).length;

  // Capacité cumulée : ce dont on dispose réellement, tous clusters confondus.
  const totals = infra.clusters.reduce(
    (acc, c) => {
      const u = c.usage;
      if (u) {
        acc.cpu += u.cpu_millis;
        acc.cpuCap += u.cpu_capacity;
        acc.mem += u.memory_bytes;
        acc.memCap += u.memory_capacity;
      }
      acc.nodes += c.info?.node_count ?? 0;
      acc.pods += c.info?.managed_pods ?? 0;
      return acc;
    },
    { cpu: 0, cpuCap: 0, mem: 0, memCap: 0, nodes: 0, pods: 0 },
  );

  return (
    <>
      <PageHeader
        title="Infrastructure"
        description="Le plan de contrôle et les clusters qu'il pilote."
      >
        <ClusterDialog controlPlaneAddr={controlPlaneAddr} />
      </PageHeader>

      {/* Vue d'ensemble : l'état global se lit sans dérouler les clusters. */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label={`Cluster${infra.clusters.length > 1 ? "s" : ""} connecté${connected > 1 ? "s" : ""}`}
          value={`${connected}/${infra.clusters.length}`}
          icon={Boxes}
          tone={
            infra.clusters.length === 0
              ? "default"
              : connected === infra.clusters.length
                ? "success"
                : "danger"
          }
        />
        <Stat label="Nœuds" value={totals.nodes} icon={Server} tone="default" />
        <Stat
          label="CPU utilisé"
          value={
            totals.cpuCap
              ? `${Math.round((totals.cpu / totals.cpuCap) * 100)}%`
              : "—"
          }
          icon={Cpu}
          tone="default"
        />
        <Stat
          label="Mémoire utilisée"
          value={
            totals.memCap
              ? `${Math.round((totals.mem / totals.memCap) * 100)}%`
              : "—"
          }
          icon={MemoryStick}
          tone="default"
        />
      </div>

      {/* Plan de contrôle : ce qui tourne de votre côté. */}
      <Card
        title="Plan de contrôle"
        description="Les briques dont dépend le pilotage de vos clusters."
        icon={Server}
      >
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          <Health
            label="Base de données"
            icon={Database}
            ok={cp.database_ok}
            okText="connectée"
            koText="injoignable"
          />
          <Health
            label="Agents connectés"
            icon={Plug}
            ok={cp.agents_connected > 0}
            okText={`${cp.agents_connected} agent(s)`}
            koText="aucun"
          />
          <Health
            label="URL automatiques"
            icon={Globe}
            ok={cp.url_generation}
            okText={cp.url_tls ? "domaine + TLS" : "nip.io (HTTP)"}
            koText="non configurées"
            warn={cp.url_generation && !cp.url_tls}
          />
          <Health
            label="Authentification API"
            icon={Lock}
            ok={cp.api_auth}
            okText="active"
            koText="désactivée"
            warn={!cp.api_auth}
          />
        </div>

        {!cp.url_generation && (
          <p className="mt-5 flex items-start gap-2 rounded-md bg-warning/10 px-3 py-2 text-xs text-warning">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>
              Sans <code className="font-mono">BASE_DOMAIN</code> ni{" "}
              <code className="font-mono">INGRESS_IP</code>, les applications
              déployées n&apos;obtiennent pas d&apos;URL publique.
            </span>
          </p>
        )}
      </Card>

      {/* Clusters. */}
      {infra.clusters.length === 0 ? (
        <Card title="Clusters" icon={Boxes}>
          <EmptyState
            icon={Boxes}
            title="Aucun cluster enregistré"
            description="Enregistrez un cluster, puis installez son agent pour y déployer vos applications."
          >
            <ClusterDialog controlPlaneAddr={controlPlaneAddr} />
          </EmptyState>
        </Card>
      ) : (
        <div className="flex flex-col gap-6">
          {infra.clusters.map((c) => (
            <ClusterCard key={c.id} cluster={c} />
          ))}
        </div>
      )}

      <AutoRefresh />
    </>
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
  value: string | number;
  icon: React.ComponentType<{ className?: string }>;
  tone: "default" | "success" | "warning" | "danger";
}) {
  const tones = {
    default: "text-muted-foreground bg-muted",
    success: "text-success bg-success/10",
    warning: "text-warning bg-warning/10",
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
          <p className="text-2xl font-semibold tracking-tight tabular">
            {value}
          </p>
          <p className="truncate text-xs text-muted-foreground">{label}</p>
        </div>
      </CardContent>
    </ShadcnCard>
  );
}

function Health({
  label,
  icon: Icon,
  ok,
  okText,
  koText,
  warn,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  ok: boolean;
  okText: string;
  koText: string;
  warn?: boolean;
}) {
  const tone = !ok ? "danger" : warn ? "warning" : "success";
  const color = {
    danger: "text-destructive",
    warning: "text-warning",
    success: "text-success",
  }[tone];

  return (
    <div className="space-y-1.5">
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Icon className="size-3.5" />
        {label}
      </p>
      <p className={cn("flex items-center gap-2 text-sm font-medium", color)}>
        <StatusDot tone={tone} />
        {ok ? okText : koText}
      </p>
    </div>
  );
}

function ClusterCard({ cluster }: { cluster: InfraCluster }) {
  const info = cluster.info;

  return (
    <Card
      title={cluster.name}
      icon={Boxes}
      className={cn(!cluster.connected && "border-destructive/30")}
      action={
        <div className="flex items-center gap-3">
          <Badge
            variant="secondary"
            className={cn(
              "gap-2 border-transparent",
              cluster.connected
                ? "bg-success/12 text-success"
                : "bg-destructive/15 text-destructive",
            )}
          >
            <StatusDot tone={cluster.connected ? "success" : "danger"} />
            {cluster.connected ? "connecté" : "déconnecté"}
          </Badge>
          <DeleteClusterButton clusterId={cluster.id} />
        </div>
      }
    >
      {!cluster.connected && <Disconnected cluster={cluster} />}

      {info ? (
        <ClusterTabs
          nodeCount={info.nodes.length}
          hasMetrics={Boolean(cluster.usage)}
          overview={
            <>
              <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Plateforme" value={info.platform} />
            <Field label="Version" value={info.k8s_version} mono />
            <Field
              label="Nœuds"
              value={`${info.nodes_ready}/${info.node_count} prêts`}
              tone={info.nodes_ready < info.node_count ? "warning" : undefined}
            />
            <Field
              label="Capacité"
              value={`${info.total_cpu} vCPU · ${info.total_memory}`}
            />
            <Field label="Agent" value={cluster.agent_version || "—"} mono />
            <Field label="Stockage" value={info.storage_class || "aucun"} mono />
            <Field
              label="Ingress"
              value={(info.ingress_classes ?? []).join(", ") || "aucun"}
              mono
            />
            <Field
              label="Applications"
              value={`${info.managed_pods} pod(s) · ${info.managed_namespaces} env.`}
            />
              </div>

              {cluster.info_updated_at && (
                <p className="mt-4 text-xs text-muted-foreground">
                  relevé {formatAge(cluster.info_updated_at)}
                </p>
              )}
            </>
          }
          metrics={<Usage cluster={cluster} />}
          nodes={<Nodes info={info} />}
          components={<Capabilities info={info} />}
        />
      ) : (
        <EmptyState
          icon={CircleDashed}
          title="Aucune information"
          description="L'agent ne s'est jamais connecté à ce cluster."
        />
      )}
    </Card>
  );
}

/** Diagnostic affiché quand l'agent ne répond plus. */
function Disconnected({ cluster }: { cluster: InfraCluster }) {
  return (
    <div className="mb-5 rounded-lg border border-destructive/25 bg-destructive/10 px-3 py-2.5 text-xs text-destructive">
      <p className="flex items-center gap-1.5 font-medium">
        <AlertTriangle className="size-3.5" />
        Les déploiements sur ce cluster resteront en attente.
      </p>
      <p className="mt-1.5 opacity-90">
        {cluster.last_seen
          ? `Dernier contact ${formatAge(cluster.last_seen)}.`
          : "Ce cluster ne s'est jamais connecté."}{" "}
        Vérifiez que l&apos;agent tourne et qu&apos;il peut joindre le Control
        Plane :
      </p>
      <pre className="mt-2 overflow-x-auto rounded bg-background/60 p-2 font-mono select-all">
        kubectl logs -n kybers-system -l app.kubernetes.io/name=kybers-agent
        --tail=20
      </pre>
    </div>
  );
}

/**
 * Consommation réelle du cluster : valeurs courantes, courbe d'évolution, et
 * détail par nœud puis par application.
 */
function Usage({ cluster }: { cluster: InfraCluster }) {
  const u = cluster.usage;

  if (!u) {
    return (
      <div>
        <SectionLabel icon={Activity}>Consommation</SectionLabel>
        <p className="mt-2 rounded-md bg-warning/10 px-3 py-2 text-xs text-warning">
          Aucune métrique : ni metrics-server ni Prometheus exploitable
          n&apos;ont été trouvés. Installez metrics-server, ou indiquez un
          Prometheus à l&apos;agent avec{" "}
          <code className="font-mono">
            --set metrics.prometheusUrl=http://…:9090
          </code>
          .
        </p>
      </div>
    );
  }

  const nodes = u.nodes ?? [];
  const apps = u.apps ?? [];
  const history = cluster.usage_history ?? [];

  return (
    <div className="mt-6">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <SectionLabel icon={Activity}>Consommation</SectionLabel>
        {cluster.info?.metrics_source && (
          <Badge variant="outline" className="font-mono">
            {cluster.info.metrics_source}
          </Badge>
        )}
        <MetricsSourceSelect
          clusterId={cluster.id}
          available={cluster.info?.available_metrics_sources ?? []}
          preference={cluster.metrics_source_preference ?? ""}
          active={cluster.info?.metrics_source ?? ""}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <UsageBar
          label="CPU du cluster"
          used={u.cpu_millis}
          total={u.cpu_capacity}
          format={formatCPU}
        />
        <UsageBar
          label="Mémoire du cluster"
          used={u.memory_bytes}
          total={u.memory_capacity}
          format={formatBytes}
        />
      </div>

      <div className="mt-5">
        <UsageChart samples={history} />
      </div>

      {nodes.some((n) => n.gpu_count > 0) && (
        <div className="mt-6">
          <SectionLabel icon={Cpu}>GPU</SectionLabel>
          <div className="mt-3">
            <GpuUsage nodes={nodes} />
          </div>
        </div>
      )}

      {nodes.length > 0 && (
        <div className="mt-6">
          <SectionLabel icon={Cpu}>Par nœud</SectionLabel>
          <div className="mt-3">
            <NodeUsageRows nodes={nodes} />
          </div>
        </div>
      )}

      {apps.length > 0 && (
        <div className="mt-6">
          <SectionLabel icon={Boxes}>Par application</SectionLabel>
          <div className="mt-3">
            <AppUsageTable apps={apps} />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Composants dont dépendent certaines fonctions : leur absence explique un HPA
 * inactif ou un certificat qui n'arrive jamais.
 */
function Capabilities({ info }: { info: ClusterInfo }) {
  const items = [
    {
      // La consommation peut venir de Prometheus : metrics-server reste
      // néanmoins requis par l'autoscaling horizontal, que le HPA lit.
      ok: info.has_metrics_server,
      label: "metrics-server",
      hint: "requis par l'autoscaling horizontal (HPA)",
    },
    {
      ok: info.has_cert_manager,
      label: "cert-manager",
      hint: "requis pour les certificats TLS automatiques",
    },
    {
      ok: (info.ingress_classes ?? []).length > 0,
      label: "ingress controller",
      hint: "requis pour exposer les applications",
    },
    {
      ok: Boolean(info.storage_class),
      label: "classe de stockage",
      hint: "requise pour les volumes persistants",
    },
  ];

  return (
    <div>
      <SectionLabel icon={HardDrive}>Composants du cluster</SectionLabel>
      <ul className="mt-3 grid gap-2 sm:grid-cols-2">
        {items.map((it) => (
          <li
            key={it.label}
            className="flex items-start gap-2 rounded-lg border border-border px-3 py-2 text-sm"
          >
            {it.ok ? (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
            ) : (
              <CircleDashed className="mt-0.5 size-4 shrink-0 text-warning" />
            )}
            <span>
              {it.label}
              {!it.ok && (
                <span className="block text-xs text-muted-foreground">
                  absent — {it.hint}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>

      {(info.ingress_ips ?? []).length > 0 && (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Network className="size-3.5" />
          Trafic entrant :{" "}
          <span className="font-mono">{(info.ingress_ips ?? []).join(", ")}</span>
        </p>
      )}
    </div>
  );
}

function Nodes({ info }: { info: ClusterInfo }) {
  if (info.nodes.length === 0) return null;

  return (
    <div>
      <SectionLabel icon={Server}>Nœuds</SectionLabel>
      <div className="mt-3 overflow-x-auto rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nom</TableHead>
              <TableHead>Rôle</TableHead>
              <TableHead>État</TableHead>
              <TableHead>Capacité</TableHead>
              <TableHead>IP</TableHead>
              <TableHead>Système</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {info.nodes.map((n) => (
              <TableRow key={n.name}>
                <TableCell className="font-mono text-xs">{n.name}</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {n.role}
                </TableCell>
                <TableCell>
                  <span
                    className={cn(
                      "inline-flex items-center gap-1.5 text-xs font-medium",
                      n.ready ? "text-success" : "text-destructive",
                    )}
                  >
                    <StatusDot tone={n.ready ? "success" : "danger"} />
                    {n.ready ? "Ready" : "NotReady"}
                  </span>
                  {(n.pressures ?? []).length > 0 && (
                    <span className="ml-2 text-xs text-warning">
                      pression {(n.pressures ?? []).join(", ")}
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {n.cpu_capacity} vCPU · {n.memory_capacity}
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {n.internal_ip}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {n.os_image} · {n.architecture}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

/** Intertitre des sous-sections d'une carte cluster. */
function SectionLabel({
  icon: Icon,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
      <Icon className="size-3.5" />
      {children}
    </p>
  );
}
