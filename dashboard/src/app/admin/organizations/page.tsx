import { redirect } from "next/navigation";

/**
 * Ancienne URL conservée pour les signets.
 *
 * L'URL reste valide pour les liens et signets existants.
 */
export default function Page() {
  redirect("/parametres/organisations");
}
