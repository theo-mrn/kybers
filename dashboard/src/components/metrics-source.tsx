"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { setMetricsSourceAction, type ActionState } from "@/app/actions";
import { Feedback } from "@/components/forms";

/**
 * Choix de la source des métriques, proposé seulement quand plusieurs sont
 * exploitables : imposer une priorité sans laisser la main serait arbitraire.
 */
export function MetricsSourceSelect({
  clusterId,
  available,
  preference,
  active,
}: {
  clusterId: string;
  available: string[];
  preference: string;
  active: string;
}) {
  const [state, action] = useActionState<ActionState, FormData>(
    setMetricsSourceAction,
    null,
  );

  // Une seule source disponible : le choix n'a pas de sens.
  if (available.length < 2) return null;

  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="cluster_id" value={clusterId} />
      <SourceSelect available={available} preference={preference} active={active} />
      <Feedback state={state} />
    </form>
  );
}

function SourceSelect({
  available,
  preference,
  active,
}: {
  available: string[];
  preference: string;
  active: string;
}) {
  // useFormStatus doit être appelé dans un enfant du <form>.
  const { pending } = useFormStatus();

  return (
    <>
      <select
        name="source"
        defaultValue={preference}
        disabled={pending}
        // La soumission se fait au changement : un bouton « Appliquer »
        // séparé n'apporterait rien pour un choix unique.
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        className="h-8 rounded-md border border-input bg-transparent px-2 text-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50"
        aria-label="Source des métriques"
      >
        <option value="">
          automatique{active ? ` (${active})` : ""}
        </option>
        {available.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      {pending && <span className="text-xs text-muted-foreground">…</span>}
    </>
  );
}
