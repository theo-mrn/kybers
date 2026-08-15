import type { DeploymentStatus } from "@/lib/api";
import {
  CheckCircle2,
  CircleDashed,
  CircleSlash,
  Loader2,
  Send,
  Trash2,
  XCircle,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Card as ShadcnCard,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

// Classes partagées : conservées pour les champs non encore migrés vers les
// primitives shadcn, alignées sur les tokens du thème.
export const inputClass =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm " +
  "transition-colors outline-none placeholder:text-muted-foreground " +
  "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40 " +
  "disabled:cursor-not-allowed disabled:opacity-50";

export const labelClass =
  "block text-xs font-medium text-muted-foreground mb-1.5";

export const btnClass =
  "inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-primary px-4 text-sm " +
  "font-medium text-primary-foreground transition-colors hover:bg-primary/85 " +
  "focus-visible:ring-[3px] focus-visible:ring-ring/40 outline-none " +
  "disabled:pointer-events-none disabled:opacity-50";

export const btnSecondaryClass =
  "inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-border " +
  "px-3 text-xs font-medium transition-colors hover:bg-muted " +
  "focus-visible:ring-[3px] focus-visible:ring-ring/40 outline-none " +
  "disabled:pointer-events-none disabled:opacity-50";

/**
 * Statuts : la couleur seule ne suffit pas (daltonisme), chaque état porte donc
 * aussi une icône distincte.
 */
const STATUS_STYLES: Record<
  DeploymentStatus,
  { className: string; icon: React.ComponentType<{ className?: string }>; spin?: boolean }
> = {
  pending: {
    className: "bg-muted text-muted-foreground",
    icon: CircleDashed,
  },
  dispatched: {
    className: "bg-info/15 text-info",
    icon: Send,
  },
  provisioning: {
    className: "bg-warning/15 text-warning",
    icon: Loader2,
    spin: true,
  },
  running: {
    className: "bg-success/15 text-success",
    icon: CheckCircle2,
  },
  failed: {
    className: "bg-destructive/15 text-destructive",
    icon: XCircle,
  },
  stopped: {
    className: "bg-muted text-muted-foreground",
    icon: CircleSlash,
  },
  deleted: {
    className: "bg-muted text-muted-foreground",
    icon: Trash2,
  },
};

export function StatusBadge({
  status,
  className,
}: {
  status: DeploymentStatus;
  className?: string;
}) {
  const style = STATUS_STYLES[status] ?? STATUS_STYLES.pending;
  const Icon = style.icon;

  return (
    <Badge
      variant="secondary"
      className={cn("gap-1 border-transparent", style.className, className)}
    >
      <Icon className={cn("size-3", style.spin && "animate-spin")} aria-hidden />
      {status}
    </Badge>
  );
}

/** Point d'état coloré, doublé d'un libellé textuel. */
export function StatusDot({
  tone,
  className,
}: {
  tone: "success" | "warning" | "danger" | "muted";
  className?: string;
}) {
  const colors = {
    success: "bg-success",
    warning: "bg-warning",
    danger: "bg-destructive",
    muted: "bg-muted-foreground",
  } as const;

  return (
    <span className={cn("relative flex size-2", className)} aria-hidden>
      {tone === "success" && (
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60" />
      )}
      <span
        className={cn(
          "relative inline-flex size-2 rounded-full",
          colors[tone],
        )}
      />
    </span>
  );
}

/**
 * Carte de section. L'ancienne signature (`title` + `action`) est conservée
 * pour que toutes les pages restent compatibles.
 */
export function Card({
  title,
  description,
  action,
  icon: Icon,
  className,
  contentClassName,
  children,
}: {
  title?: string;
  description?: string;
  action?: React.ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
  className?: string;
  contentClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <ShadcnCard className={className}>
      {title && (
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {Icon && <Icon className="size-4 text-muted-foreground" />}
            {title}
          </CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
          {action && <CardAction>{action}</CardAction>}
        </CardHeader>
      )}
      <CardContent className={contentClassName}>{children}</CardContent>
    </ShadcnCard>
  );
}

/** En-tête de page : titre, sous-titre et actions alignées à droite. */
export function PageHeader({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {children && (
        <div className="flex flex-wrap items-center gap-2">{children}</div>
      )}
    </div>
  );
}

/** État vide : explique et propose une action plutôt qu'une ligne grise. */
export function EmptyState({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border px-6 py-12 text-center">
      {Icon && (
        <div className="flex size-10 items-center justify-center rounded-full bg-muted">
          <Icon className="size-5 text-muted-foreground" />
        </div>
      )}
      <div className="space-y-1">
        <p className="text-sm font-medium">{title}</p>
        {description && (
          <p className="mx-auto max-w-sm text-sm text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {children}
    </div>
  );
}

/** Couple libellé / valeur, brique des grilles de métadonnées. */
export function Field({
  label,
  value,
  mono,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  tone?: "warning" | "danger" | "success";
}) {
  const tones = {
    warning: "text-warning",
    danger: "text-destructive",
    success: "text-success",
  } as const;

  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p
        className={cn(
          "text-sm",
          mono && "font-mono text-xs",
          tone && tones[tone],
        )}
      >
        {value}
      </p>
    </div>
  );
}

/** Âge relatif, plus lisible qu'un horodatage complet dans un tableau. */
export function formatAge(iso: string) {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return "—";
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return "à l'instant";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  const days = Math.floor(hours / 24);
  return `il y a ${days} j`;
}

export function formatSize(bytes: number) {
  if (!bytes) return "—";
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb.toFixed(1)} Mo`;
  return `${(mb / 1024).toFixed(2)} Go`;
}

export function formatCount(n: number) {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)} Md`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)} k`;
  return String(n);
}
