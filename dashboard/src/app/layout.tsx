import type { Metadata } from "next";
import { cookies } from "next/headers";
import { api } from "@/lib/api";
import { logoutAction, switchOrgAction } from "@/app/auth-actions";
import { Plus_Jakarta_Sans, JetBrains_Mono } from "next/font/google";
import { AppSidebar } from "@/components/app-sidebar";
import { Topbar } from "@/components/topbar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

// Plus Jakarta Sans : formes ouvertes et terminaisons douces, plus accueillante
// qu'une géométrique stricte tout en restant lisible dans les tableaux denses.
const jakarta = Plus_Jakarta_Sans({
  variable: "--font-sans",
  subsets: ["latin"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Kybers",
  description: "PaaS souverain sur Kubernetes",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // L'identité est résolue une fois pour toute la navigation : la coquille
  // (sidebar + barre haute) n'apparaît que pour une session valide.
  const me = await api.me().catch(() => null);

  // Organisation active. Le cookie peut manquer — session ouverte avant que la
  // connexion ne le pose, ou appartenance révoquée depuis — auquel cas le
  // Control Plane refuse toute requête dès qu'il y a plusieurs organisations,
  // et les pages se vident sans expliquer pourquoi. On retombe alors sur la
  // première, celle que l'API choisirait si elle était seule.
  const stored = me ? (await cookies()).get("kybers_org")?.value : undefined;
  const activeOrg =
    me?.organizations.find((o) => o.slug === stored)?.slug ??
    me?.organizations[0]?.slug;

  return (
    <html
      lang="fr"
      className={`dark ${jakarta.variable} ${jetbrainsMono.variable} h-full antialiased`}
      style={{ colorScheme: "dark" }}
      suppressHydrationWarning
    >
      <body className="min-h-full bg-background text-foreground">
        <TooltipProvider>
          {me ? (
            <SidebarProvider>
              <AppSidebar
                user={{
                  name: me.user.name,
                  email: me.user.email,
                  isAdmin: me.user.is_admin,
                  organization: me.organizations.find((o) => o.slug === activeOrg)
                    ?.name,
                }}
                organizations={me.organizations.map((o) => ({
                  slug: o.slug,
                  name: o.name,
                  role: o.role,
                }))}
                activeOrg={activeOrg}
                switchOrgAction={switchOrgAction}
                logoutAction={logoutAction}
              />
              <SidebarInset>
                <Topbar />
                <div className="flex flex-1 flex-col gap-6 p-4 md:p-6 lg:p-8">
                  {children}
                </div>
              </SidebarInset>
            </SidebarProvider>
          ) : (
            // Écran de connexion : aucune navigation à afficher.
            children
          )}
        </TooltipProvider>
      </body>
    </html>
  );
}
