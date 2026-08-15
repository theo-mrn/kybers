import { redirect } from "next/navigation";

/**
 * Le profil est la page d'accueil des paramètres.
 *
 * L'URL reste valide pour les liens et signets existants.
 */
export default function Page() {
  redirect("/parametres");
}
