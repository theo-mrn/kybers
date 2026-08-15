import { redirect } from "next/navigation";

/**
 * « Équipe » et « Organisation » désignaient la même appartenance (une ligne
 * de `org_members`) : la notion d'équipe a disparu au profit de la seule
 * organisation. L'ancienne URL reste valide pour les signets.
 */
export default function TeamPage() {
  redirect("/organisations");
}
