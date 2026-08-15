"use client";

import { useFormStatus } from "react-dom";
import { ArrowLeftRight, Loader2 } from "lucide-react";

import { switchOrgAction } from "@/app/auth-actions";
import { Button } from "@/components/ui/button";

function Submit() {
  // useFormStatus doit être appelé dans un enfant du <form>.
  const { pending } = useFormStatus();

  return (
    <Button type="submit" variant="outline" size="sm" disabled={pending}>
      {pending ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : (
        <ArrowLeftRight className="size-3.5" />
      )}
      Activer
    </Button>
  );
}

/**
 * Bascule l'organisation active, mémorisée dans un cookie.
 *
 * Tout le dashboard — applications, clusters, registries — est lu dans le
 * périmètre de cette organisation : en changer rejoue les pages entières.
 */
export function SwitchOrgButton({ slug }: { slug: string }) {
  return (
    <form action={switchOrgAction}>
      <input type="hidden" name="org" value={slug} />
      <Submit />
    </form>
  );
}
