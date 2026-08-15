import { redirect } from "next/navigation";

/**
 * Les organisations relèvent des paramètres.
 *
 * L'URL reste valide pour les liens et signets existants.
 */
export default function Page() {
  redirect("/parametres/organisations");
}
