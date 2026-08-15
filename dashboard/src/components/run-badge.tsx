import { CheckCircle2, Loader2, XCircle } from "lucide-react";

import type { GitRun } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * État d'une exécution de pipeline.
 *
 * Le statut prime tant que le run n'est pas terminé : une conclusion vide sur
 * un run en cours ne signifie pas qu'il a échoué.
 */
export function RunBadge({ run }: { run: GitRun }) {
  if (run.status !== "completed") {
    return (
      <Badge
        variant="secondary"
        className="gap-1 border-transparent bg-warning/15 text-warning"
      >
        <Loader2 className="size-3 animate-spin" />
        {run.status === "queued" ? "en attente" : "en cours"}
      </Badge>
    );
  }

  const ok = run.conclusion === "success";
  return (
    <Badge
      variant="secondary"
      className={cn(
        "gap-1 border-transparent",
        ok ? "bg-success/12 text-success" : "bg-destructive/15 text-destructive",
      )}
    >
      {ok ? <CheckCircle2 className="size-3" /> : <XCircle className="size-3" />}
      {run.conclusion || "inconnu"}
    </Badge>
  );
}
