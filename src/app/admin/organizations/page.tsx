import { redirect } from "next/navigation";

/** Les organisations ont leur propre section, hors de l'administration. */
export default function AdminOrganizationsPage() {
  redirect("/organisations");
}
