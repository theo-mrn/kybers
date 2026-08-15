"use client";

import { useActionState, useTransition } from "react";
import { Trash2 } from "lucide-react";

import { deleteTemplateAction, type ActionState } from "@/app/actions";
import type { FileTemplate } from "@/lib/api";
import { ConfirmButton } from "@/components/confirm-button";

export function DeleteTemplateButton({ template }: { template: FileTemplate }) {
  const [, action] = useActionState<ActionState, FormData>(
    deleteTemplateAction,
    null,
  );
  const [pending, startTransition] = useTransition();

  return (
    <ConfirmButton
      icon={Trash2}
      ariaLabel={`Supprimer ${template.name}`}
      pending={pending}
      title={`Supprimer « ${template.name} » ?`}
      description="Les applications déjà créées ne sont pas affectées : un modèle sert de point de départ, pas de source de vérité."
      confirmLabel="Supprimer le modèle"
      onConfirm={() => {
        const data = new FormData();
        data.set("id", template.id);
        startTransition(() => action(data));
      }}
    />
  );
}
