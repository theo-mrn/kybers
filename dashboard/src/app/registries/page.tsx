import { redirect } from "next/navigation";

/**
 * Les registries sont une configuration, pas une section.
 *
 * L'URL reste valide pour les liens et signets existants.
 */
export default function Page() {
  redirect("/parametres/registries");
}
