import { redirect } from "next/navigation";
import { api } from "@/lib/api";
import { PageHeader } from "@/components/ui";
import {
  SettingsNav,
  type SettingsNavItem,
} from "@/components/settings-nav";

export const dynamic = "force-dynamic";

/**
 * Coquille des paramètres.
 *
 * Registries, jetons, organisation et administration étaient autant d'entrées
 * de la barre latérale alors qu'ils relèvent tous de la configuration : les
 * regrouper dégage la navigation pour ce qu'on consulte vraiment, les
 * applications.
 */
export default async function SettingsLayout({
  children,
}: LayoutProps<"/parametres">) {
  const me = await api.me().catch(() => null);
  if (!me) redirect("/login");

  // Seules des données sérialisables traversent vers le composant client :
  // l'icône est désignée par une clé, résolue de l'autre côté.
  const items: SettingsNavItem[] = [
    { href: "/parametres", label: "Profil", icon: "profil", exact: true },
    { href: "/parametres/registries", label: "Registries", icon: "registries" },
    { href: "/parametres/jetons", label: "Jetons d'API", icon: "jetons" },
    {
      href: "/parametres/organisations",
      label: "Organisations",
      icon: "organisations",
    },
    // L'administration de la plateforme ne concerne que ses administrateurs.
    ...(me.user.is_admin
      ? [
          {
            href: "/parametres/comptes",
            label: "Comptes",
            icon: "comptes" as const,
          },
        ]
      : []),
  ];

  return (
    <>
      <PageHeader
        title="Paramètres"
        description="Votre compte, vos accès et la configuration de la plateforme."
      />

      <div className="flex flex-col gap-6 lg:flex-row">
        <SettingsNav items={items} />
        <div className="flex min-w-0 flex-1 flex-col gap-6">{children}</div>
      </div>
    </>
  );
}
