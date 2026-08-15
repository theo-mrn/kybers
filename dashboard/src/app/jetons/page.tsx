import { redirect } from "next/navigation";

/**
 * Les jetons relèvent des paramètres du compte.
 *
 * L'URL reste valide pour les liens et signets existants.
 */
export default function Page() {
  redirect("/parametres/jetons");
}
