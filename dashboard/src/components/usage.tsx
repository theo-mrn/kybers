"use client";

import type { NodeUsage, AppUsage } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

/** Convertit des millicores en libellé lisible : 1105m → « 1.1 ». */
export function formatCPU(millis: number) {
  if (millis < 1000) return `${millis}m`;
  return `${(millis / 1000).toFixed(1)}`;
}

export function formatBytes(bytes: number) {
  const gi = 1024 ** 3;
  if (bytes >= gi) return `${(bytes / gi).toFixed(1)} Gi`;
  return `${Math.round(bytes / 1024 ** 2)} Mi`;
}

function pct(used: number, total: number) {
  if (!total) return 0;
  return Math.min(100, Math.round((used / total) * 100));
}

/** Une jauge passe à l'ambre puis au rouge à mesure que la marge se réduit. */
function toneOf(percent: number) {
  if (percent >= 90) return "danger" as const;
  if (percent >= 75) return "warning" as const;
  return "ok" as const;
}

// `Progress` compose sa piste et son indicateur en interne : la couleur se
// cible via le data-slot plutôt que par une prop dédiée.
const INDICATOR = {
  ok: "[&_[data-slot=progress-indicator]]:bg-primary",
  warning: "[&_[data-slot=progress-indicator]]:bg-warning",
  danger: "[&_[data-slot=progress-indicator]]:bg-destructive",
} as const;

const TEXT = {
  ok: "text-foreground",
  warning: "text-warning",
  danger: "text-destructive",
} as const;

export function UsageBar({
  label,
  used,
  total,
  format,
}: {
  label: string;
  used: number;
  total: number;
  format: (n: number) => string;
}) {
  const percent = pct(used, total);
  const tone = toneOf(percent);

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <span className="text-xs text-muted-foreground tabular">
          {format(used)} / {format(total)}
          <span className={cn("ml-2 font-medium", TEXT[tone])}>{percent}%</span>
        </span>
      </div>
      {/* `aria-valuetext` est fourni explicitement : laissé à Base UI, il est
          formaté via Intl et diffère entre le serveur (« 29 % », espace
          insécable) et le navigateur, ce qui casse l'hydratation. */}
      <Progress
        value={percent}
        aria-label={`${label} : ${percent}%`}
        aria-valuetext={`${percent}%`}
        className={INDICATOR[tone]}
      />
    </div>
  );
}

/**
 * Occupation des GPU, tous nœuds confondus.
 *
 * Le GPU n'est pas historisé côté Control Plane (`usage_samples` ne stocke que
 * CPU et mémoire) : cette vue est donc un instantané, sans courbe possible.
 */
export function GpuUsage({ nodes }: { nodes: NodeUsage[] }) {
  const withGpu = nodes.filter((n) => n.gpu_count > 0);
  if (withGpu.length === 0) return null;

  const total = withGpu.reduce((a, n) => a + n.gpu_count, 0);
  const used = withGpu.reduce((a, n) => a + n.gpu_allocated, 0);

  return (
    <div className="space-y-3">
      <UsageBar
        label="GPU alloués"
        used={used}
        total={total}
        format={(n) => `${n}`}
      />

      <div className="grid gap-2 sm:grid-cols-2">
        {withGpu.map((n) => (
          <div
            key={n.name}
            className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
          >
            <span className="truncate font-mono text-xs text-muted-foreground">
              {n.name}
            </span>
            <Badge variant="outline" className="font-mono">
              {n.gpu_allocated}/{n.gpu_count}
            </Badge>
          </div>
        ))}
      </div>
    </div>
  );
}

export function NodeUsageRows({ nodes }: { nodes: NodeUsage[] }) {
  if (nodes.length === 0) return null;

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {nodes.map((n) => (
        <div key={n.name} className="rounded-lg border border-border p-4">
          <p className="mb-3 flex flex-wrap items-center gap-2 font-mono text-xs text-muted-foreground">
            {n.name}
            {n.gpu_count > 0 && (
              <Badge variant="outline" className="font-mono">
                {n.gpu_allocated}/{n.gpu_count} GPU
              </Badge>
            )}
          </p>
          <div className="space-y-3">
            <UsageBar
              label="CPU"
              used={n.cpu_millis}
              total={n.cpu_capacity}
              format={formatCPU}
            />
            <UsageBar
              label="Mémoire"
              used={n.memory_bytes}
              total={n.memory_capacity}
              format={formatBytes}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Consommation par application, la plus gourmande en premier. */
export function AppUsageTable({ apps }: { apps: AppUsage[] }) {
  if (apps.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Aucune application en cours d&apos;exécution.
      </p>
    );
  }

  const sorted = [...apps].sort((a, b) => b.memory_bytes - a.memory_bytes);

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Application</TableHead>
            <TableHead>Namespace</TableHead>
            <TableHead className="text-right">Pods</TableHead>
            <TableHead className="text-right">CPU</TableHead>
            <TableHead className="text-right">Mémoire</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((a) => (
            <TableRow key={a.namespace}>
              <TableCell className="font-medium">{a.app_name || "—"}</TableCell>
              <TableCell className="font-mono text-xs text-muted-foreground">
                {a.namespace}
              </TableCell>
              <TableCell className="text-right">{a.pod_count}</TableCell>
              <TableCell className="text-right font-mono text-xs">
                {formatCPU(a.cpu_millis)}
              </TableCell>
              <TableCell className="text-right font-mono text-xs">
                {formatBytes(a.memory_bytes)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
