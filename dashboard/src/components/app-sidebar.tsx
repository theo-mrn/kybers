"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Boxes,
  KeyRound,
  Building2,
  Check,
  ChevronsUpDown,
  FileCode,
  LayoutGrid,
  LogOut,
  Server,
  Settings2,
  ShieldCheck,
  UserCog,
} from "lucide-react";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

type NavItem = {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
};

const NAV: NavItem[] = [
  { href: "/apps", label: "Applications", icon: LayoutGrid },
  { href: "/modeles", label: "Modèles", icon: FileCode },
  { href: "/infra", label: "Infrastructure", icon: Server },
  { href: "/parametres", label: "Paramètres", icon: Settings2 },
];

/**
 * `/` correspondrait à toutes les routes avec un simple `startsWith` : la
 * racine exige donc une égalité stricte.
 */
function useIsActive() {
  const pathname = usePathname();
  return (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);
}

function NavSection({ items }: { items: NavItem[] }) {
  const isActive = useIsActive();

  return (
    <SidebarGroup>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => (
            <SidebarMenuItem key={item.href}>
              <SidebarMenuButton
                render={<Link href={item.href} />}
                isActive={isActive(item.href)}
                tooltip={item.label}
              >
                <item.icon className="size-4" />
                <span>{item.label}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

export type SidebarUser = {
  name: string;
  email: string;
  isAdmin: boolean;
  organization?: string;
};

export type SidebarOrg = { slug: string; name: string; role?: string };

export function AppSidebar({
  user,
  organizations = [],
  activeOrg,
  switchOrgAction,
  logoutAction,
}: {
  user: SidebarUser;
  organizations?: SidebarOrg[];
  /** Slug de l'organisation courante, pour marquer la ligne active. */
  activeOrg?: string;
  switchOrgAction: (formData: FormData) => Promise<void>;
  logoutAction: () => Promise<void>;
}) {
  const initials =
    (user.name || user.email)
      .split(/[\s@.]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "K";

  return (
    <Sidebar collapsible="icon" variant="inset">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            {/* Un seul choix possible : le menu n'apporterait rien. */}
            {organizations.length <= 1 ? (
              <SidebarMenuButton
                size="lg"
                render={<Link href="/apps" />}
                tooltip="Kybers"
              >
                <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                  <Boxes className="size-4.5" />
                </div>
                <div className="grid flex-1 text-left leading-tight">
                  <span className="truncate font-semibold">Kybers</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {user.organization ?? "PaaS Kubernetes"}
                  </span>
                </div>
              </SidebarMenuButton>
            ) : (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <SidebarMenuButton
                      size="lg"
                      tooltip="Changer d'organisation"
                      className="data-[popup-open]:bg-sidebar-accent"
                    />
                  }
                >
                  <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                    <Boxes className="size-4.5" />
                  </div>
                  <div className="grid flex-1 text-left leading-tight">
                    <span className="truncate font-semibold">Kybers</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {user.organization ?? "PaaS Kubernetes"}
                    </span>
                  </div>
                  <ChevronsUpDown className="ml-auto size-4 text-muted-foreground" />
                </DropdownMenuTrigger>

                <DropdownMenuContent
                  align="start"
                  side="right"
                  sideOffset={8}
                  className="w-60"
                >
                  <DropdownMenuGroup>
                    {/* Base UI exige que le libellé vive DANS son groupe :
                        placé au-dessus, il n'a pas de contexte et lève. */}
                    <DropdownMenuLabel className="text-xs text-muted-foreground">
                      Organisations
                    </DropdownMenuLabel>
                    {organizations.map((org) => (
                      <form key={org.slug} action={switchOrgAction}>
                        <input type="hidden" name="org" value={org.slug} />
                        <DropdownMenuItem
                          // Chaque ligne soumet son propre formulaire : la
                          // bascule reste fonctionnelle sans JavaScript.
                          // `nativeButton` prévient Base UI qu'il rend bien un
                          // <button>, sinon il y ajoute role et aria-disabled.
                          render={<button type="submit" className="w-full" />}
                          nativeButton
                          className="gap-2"
                        >
                          <Building2 className="size-4 text-muted-foreground" />
                          <span className="flex-1 truncate text-left">{org.name}</span>
                          {org.slug === activeOrg && (
                            <Check className="size-4 text-primary" />
                          )}
                        </DropdownMenuItem>
                      </form>
                    ))}
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem render={<Link href="/parametres?tab=organisation" />} className="gap-2">
                    <Building2 className="size-4 text-muted-foreground" />
                    Gérer les organisations
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <NavSection items={NAV} />
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <SidebarMenuButton
                    size="lg"
                    className="data-[popup-open]:bg-sidebar-accent"
                  />
                }
              >
                <Avatar className="size-8 rounded-lg">
                  <AvatarFallback className="rounded-lg bg-primary/15 text-xs font-medium text-primary">
                    {initials}
                  </AvatarFallback>
                </Avatar>
                <div className="grid flex-1 text-left leading-tight">
                  <span className="truncate text-sm font-medium">
                    {user.name || user.email}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {user.email}
                  </span>
                </div>
                <ChevronsUpDown className="ml-auto size-4 opacity-60" />
              </DropdownMenuTrigger>

              <DropdownMenuContent
                className="w-(--anchor-width) min-w-56"
                side="top"
                align="end"
                sideOffset={8}
              >
                {/* Base UI exige qu'un GroupLabel soit encadré par un Group. */}
                <DropdownMenuGroup>
                  <DropdownMenuLabel className="font-normal">
                    <div className="grid leading-tight">
                      <span className="truncate text-sm font-medium">
                        {user.name || user.email}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        {user.email}
                      </span>
                    </div>
                  </DropdownMenuLabel>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem render={<Link href="/parametres" />}>
                  <UserCog className="size-4" />
                  Mon profil
                </DropdownMenuItem>
                <DropdownMenuItem render={<Link href="/parametres?tab=organisation" />}>
                  <Building2 className="size-4" />
                  Organisations
                </DropdownMenuItem>
                <DropdownMenuItem render={<Link href="/parametres?tab=jetons" />}>
                  <KeyRound className="size-4" />
                  Jetons d&apos;API
                </DropdownMenuItem>
                {user.isAdmin && (
                  <DropdownMenuItem render={<Link href="/parametres?tab=comptes" />}>
                    <ShieldCheck className="size-4" />
                    Administration
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                {/* La déconnexion est une mutation : elle passe par une server
                    action, pas par un simple lien. */}
                <form action={logoutAction}>
                  <DropdownMenuItem
                    variant="destructive"
                    nativeButton
                    render={<button type="submit" className="w-full" />}
                  >
                    <LogOut className="size-4" />
                    Déconnexion
                  </DropdownMenuItem>
                </form>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}
