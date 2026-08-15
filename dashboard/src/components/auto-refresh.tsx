"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Rafraîchit les Server Components à intervalle régulier pour suivre
 * l'avancement des déploiements (pending → provisioning → running).
 *
 * router.refresh() re-rend le serveur sans remonter le DOM : la saisie en
 * cours dans les formulaires est préservée, contrairement à un rechargement.
 */
export function AutoRefresh({ intervalMs = 5000 }: { intervalMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    const id = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(id);
  }, [router, intervalMs]);

  return null;
}
