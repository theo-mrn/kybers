import { redirect } from "next/navigation";

/**
 * L'administration rejoint les paramètres.
 *
 * L'URL reste valide pour les liens et signets existants.
 */
export default function Page() {
  redirect("/parametres/comptes");
}
