import {
  Boxes,
  GitCommit,
  MonitorSmartphone,
  RotateCcw,
  Terminal,
} from "lucide-react";

import type { Deployment } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/** Origine du déclenchement, telle que déclarée par l'appelant. */
const SOURCES: Record<
  string,
  { label: string; icon: React.ComponentType<{ className?: string }>; className: string }
> = {
  ci: {
    label: "CI",
    icon: Terminal,
    className: "bg-info/15 text-info",
  },
  cli: {
    label: "CLI",
    icon: Terminal,
    className: "bg-muted text-muted-foreground",
  },
  dashboard: {
    label: "manuel",
    icon: MonitorSmartphone,
    className: "bg-muted text-muted-foreground",
  },
  catalogue: {
    label: "catalogue",
    icon: Boxes,
    className: "bg-muted text-muted-foreground",
  },
  rollback: {
    label: "rollback",
    icon: RotateCcw,
    className: "bg-warning/15 text-warning",
  },
};

export function SourceBadge({ source }: { source?: string }) {
  if (!source) return null;
  const s = SOURCES[source];
  if (!s) return <Badge variant="outline">{source}</Badge>;

  const Icon = s.icon;
  return (
    <Badge variant="secondary" className={cn("gap-1 border-transparent", s.className)}>
      <Icon className="size-3" />
      {s.label}
    </Badge>
  );
}

/**
 * Construit l'URL du commit à partir du dépôt déclaré sur l'application.
 *
 * Seuls les hébergeurs dont le format d'URL est connu sont liés ; ailleurs, le
 * SHA reste affiché sans lien plutôt que de produire une adresse fausse.
 */
function commitUrl(repo: string | undefined, sha: string) {
  if (!repo || !sha) return null;
  const clean = repo.replace(/\.git$/, "").replace(/\/$/, "");

  if (/github\.com|gitlab\.com/.test(clean)) {
    const path = clean.startsWith("http") ? clean : `https://${clean}`;
    return /gitlab\.com/.test(clean)
      ? `${path}/-/commit/${sha}`
      : `${path}/commit/${sha}`;
  }
  return null;
}

/** Provenance d'une révision : quel code tourne, et d'où il vient. */
export function Provenance({
  deployment: d,
  gitRepo,
  className,
}: {
  deployment: Deployment;
  gitRepo?: string;
  className?: string;
}) {
  if (!d.git_commit && !d.git_ref) return null;

  const short = d.git_commit?.slice(0, 7);
  const url = d.git_commit ? commitUrl(gitRepo, d.git_commit) : null;

  return (
    <div className={cn("flex flex-wrap items-center gap-2 text-xs", className)}>
      {short &&
        (url ? (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-mono text-primary hover:underline"
          >
            <GitCommit className="size-3" />
            {short}
          </a>
        ) : (
          <span className="inline-flex items-center gap-1 font-mono text-muted-foreground">
            <GitCommit className="size-3" />
            {short}
          </span>
        ))}

      {d.git_ref && (
        <Badge variant="outline" className="font-mono">
          {d.git_ref}
        </Badge>
      )}

      {d.git_message && (
        <span className="min-w-0 truncate text-muted-foreground">
          {d.git_message}
        </span>
      )}
    </div>
  );
}
