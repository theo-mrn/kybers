"use client";

import { useActionState } from "react";
import {
  deleteClusterAction,
  type ActionState,
} from "@/app/actions";
import { Trash2 } from "lucide-react";

import { SubmitButton, Feedback } from "@/components/forms";

export function DeleteClusterButton({ clusterId }: { clusterId: string }) {
  const [state, action] = useActionState<ActionState, FormData>(
    deleteClusterAction,
    null,
  );
  return (
    <form action={action} className="inline-flex items-center gap-2">
      <input type="hidden" name="cluster_id" value={clusterId} />
      <SubmitButton
        label="Supprimer"
        pendingLabel="…"
        variant="destructive"
        size="sm"
        icon={Trash2}
        confirm="Supprimer ce cluster ? Son agent ne pourra plus se connecter."
      />
      <Feedback state={state} />
    </form>
  );
}
