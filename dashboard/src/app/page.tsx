import { redirect } from "next/navigation";

/**
 * Les applications sont le point d'entrée : l'accueil n'affichait
 * qu'une vue concurrente des mêmes déploiements.
 *
 * L'URL reste valide pour les liens et signets existants.
 */
export default function Page() {
  redirect("/apps");
}
