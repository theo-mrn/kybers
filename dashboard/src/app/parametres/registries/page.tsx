import { redirect } from "next/navigation";
import { Fragment } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Boxes,
  ChevronDown,
  ChevronRight,
  Container,
  Download,
  Globe,
  Lock,
  Rocket,
  Search,
  Tags,
  X,
} from "lucide-react";

import { api, type App, type Registry, type Repository, type Tag } from "@/lib/api";
import { RegistryDialog } from "@/components/registry-dialog";
import { RegistriesDialog } from "@/components/registries-dialog";
import { DeployDialog } from "@/components/deploy-dialog";
import {
  Card,
  EmptyState,
  formatAge,
  formatCount,
  formatSize,
} from "@/components/ui";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

/** Une image, rattachée au compte d'où elle provient. */
type Image = Repository & { registry: Registry };

export default async function RegistriesPage({
  searchParams,
}: {
  searchParams: Promise<{ repo?: string; from?: string; q?: string }>;
}) {
  const { repo, from, q } = await searchParams;
  const query = (q ?? "").trim().toLowerCase();

  if (!(await api.me().catch(() => null))) redirect("/login");

  // Les applications servent de cible aux boutons « Déployer » du catalogue.
  const [registries, apps] = await Promise.all([
    api.listRegistries().catch(() => []),
    api.listApps().catch(() => []),
  ]);

  // Les catalogues de tous les comptes sont fusionnés : chercher une image ne
  // doit pas obliger à savoir dans quel registry elle se trouve.
  const catalogs = await Promise.all(
    registries.map(async (r) => {
      const res = await api
        .listRepositories(r.id)
        .catch((e: Error) => ({ error: e.message }) as const);
      return { registry: r, res };
    }),
  );

  const images: Image[] = [];
  const failed: { registry: Registry; error: string }[] = [];
  let partial = false;

  for (const { registry, res } of catalogs) {
    if ("error" in res) {
      failed.push({ registry, error: res.error });
      continue;
    }
    if (!res.authenticated) partial = true;
    for (const image of res.repositories) images.push({ ...image, registry });
  }

  const filtered = query
    ? images.filter(
        (i) =>
          i.name.toLowerCase().includes(query) ||
          i.registry.name.toLowerCase().includes(query) ||
          (i.description ?? "").toLowerCase().includes(query),
      )
    : images;

  // Les plus récemment publiées d'abord : c'est ce qu'on cherche à déployer.
  const sorted = [...filtered].sort(
    (a, b) =>
      new Date(b.last_updated).getTime() - new Date(a.last_updated).getTime(),
  );
  const shown = sorted.slice(0, 60);

  // Les tags ne sont chargés que pour le dépôt déplié : c'est un appel réseau
  // par dépôt, inutile sinon.
  const openRegistry = registries.find((r) => r.id === from);
  const tags =
    openRegistry && repo
      ? await api
          .listTags(openRegistry.id, repo)
          .catch((e: Error) => ({ error: e.message }) as const)
      : null;

  const href = (extra: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    if (q) p.set("q", q);
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined) p.delete(k);
      else p.set(k, v);
    }
    const s = p.toString();
    return s ? `/registries?${s}` : "/registries";
  };

  return (
    <>
      {failed.length > 0 && (
        <p className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {failed.map((f) => `${f.registry.name} : ${f.error}`).join(" · ")}
          </span>
        </p>
      )}

      {partial && (
        <p className="flex items-start gap-2 rounded-md bg-warning/10 px-3 py-2 text-xs text-warning">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          Certains comptes n&apos;ont pas pu être authentifiés : seules leurs
          images publiques sont listées.
        </p>
      )}

      <div className="flex justify-end">
        <RegistriesDialog registries={registries} />
      </div>

      {registries.length === 0 ? (
        <Card title="Images" icon={Boxes}>
          <EmptyState
            icon={Container}
            title="Aucun registry connecté"
            description="Connectez un compte Docker Hub, GHCR ou GitLab pour voir vos images ici."
          >
            <RegistryDialog />
          </EmptyState>
        </Card>
      ) : (
        <Card
          title="Catalogue"
          description={
            query
              ? `${sorted.length} résultat(s) sur ${images.length} image(s).`
              : `${images.length} image(s) sur ${registries.length} compte(s).`
          }
          icon={Boxes}
          action={
            images.length > 0 && (
              // Recherche côté serveur : le filtre reste dans l'URL, donc
              // partageable et conservé au rafraîchissement.
              <form method="get" className="flex items-center gap-2">
                <div className="relative w-full sm:w-72">
                  <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    name="q"
                    key={q ?? ""}
                    defaultValue={q ?? ""}
                    placeholder="Rechercher une image…"
                    aria-label="Rechercher une image par nom ou compte"
                    className="h-8 pl-8.5"
                  />
                </div>
                {query && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Effacer la recherche"
                    nativeButton={false}
                    render={<Link href="/parametres/registries" />}
                  >
                    <X className="size-3.5" />
                  </Button>
                )}
              </form>
            )
          }
          contentClassName="px-0"
        >
          {shown.length === 0 ? (
            <div className="px-6">
              <EmptyState
                icon={query ? Search : Boxes}
                title={
                  query
                    ? "Aucune image ne correspond"
                    : "Aucune image sur vos comptes"
                }
                description={
                  query ? `Rien ne correspond à « ${q} ».` : undefined
                }
              />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Image</TableHead>
                    <TableHead>Compte</TableHead>
                    <TableHead>Visibilité</TableHead>
                    <TableHead className="text-right">Pulls</TableHead>
                    <TableHead>Publiée</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shown.map((i) => {
                    const isOpen = repo === i.name && from === i.registry.id;
                    const ref = `${i.name}:${i.default_tag ?? "latest"}`;

                    return (
                      <Fragment key={`${i.registry.id}/${i.name}`}>
                      <TableRow className={cn(isOpen && "bg-muted/60")}>
                        <TableCell>
                          <p className="font-mono text-xs font-medium">
                            {i.name}
                          </p>
                          {i.description && (
                            <p className="max-w-[40ch] truncate text-xs text-muted-foreground">
                              {i.description}
                            </p>
                          )}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {i.registry.name}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant="secondary"
                            className={cn(
                              "gap-1 border-transparent",
                              i.private
                                ? "bg-warning/15 text-warning"
                                : "bg-muted text-muted-foreground",
                            )}
                          >
                            {i.private ? (
                              <Lock className="size-3" />
                            ) : (
                              <Globe className="size-3" />
                            )}
                            {i.private ? "privé" : "public"}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right text-xs text-muted-foreground">
                          {formatCount(i.pull_count)}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                          {formatAge(i.last_updated)}
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          <div className="flex items-center justify-end gap-2">
                            <DeployDialog
                              apps={apps}
                              defaultImage={ref}
                              source="catalogue"
                              trigger={
                                <Button variant="outline" size="sm">
                                  <Rocket className="size-3.5" />
                                  Déployer
                                </Button>
                              }
                            />
                            <Button
                              variant="ghost"
                              size="sm"
                              nativeButton={false}
                              render={
                                <Link
                                  href={
                                    isOpen
                                      ? href({ repo: undefined, from: undefined })
                                      : href({ repo: i.name, from: i.registry.id })
                                  }
                                />
                              }
                            >
                              {isOpen ? (
                                <ChevronDown className="size-3.5" />
                              ) : (
                                <ChevronRight className="size-3.5" />
                              )}
                              tags
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>

                      {/* Les tags s'insèrent sous leur image plutôt que dans
                          une carte séparée en bas de page. */}
                      {isOpen && tags && (
                        <TableRow className="bg-muted/40 hover:bg-muted/40">
                          <TableCell colSpan={6} className="p-3">
                            <TagList tags={tags} apps={apps} />
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                    );
                  })}
                </TableBody>
              </Table>

              {sorted.length > shown.length && (
                <p className="px-6 pt-3 text-xs text-muted-foreground">
                  {sorted.length - shown.length} image(s) supplémentaire(s) —
                  affinez la recherche pour les voir.
                </p>
              )}
            </div>
          )}
        </Card>
      )}
    </>
  );
}

/** Liste des tags d'une image, chacun déployable directement. */
function TagList({
  tags,
  apps,
}: {
  tags: Tag[] | { error: string };
  apps: App[];
}) {
  if ("error" in tags) {
    return (
      <p className="flex items-center gap-2 text-sm text-destructive">
        <AlertTriangle className="size-4 shrink-0" />
        {tags.error}
      </p>
    );
  }
  if (tags.length === 0) {
    return <p className="text-sm text-muted-foreground">Aucun tag publié.</p>;
  }

  // Beaucoup de dépôts publient un tag par commit (hash hexadécimal) en plus
  // des versions nommées. Sans tri, « latest » se retrouve noyé au milieu de
  // dizaines de hashs — on remonte donc les tags lisibles en premier.
  const isHash = (name: string) =>
    name.startsWith("sha256") || /^[0-9a-f]{7,}$/i.test(name);

  const sorted = [...tags].sort((a, b) => {
    const ha = isHash(a.name) ? 1 : 0;
    const hb = isHash(b.name) ? 1 : 0;
    if (ha !== hb) return ha - hb;
    // À égalité, le plus récemment publié d'abord.
    return new Date(b.last_updated).getTime() - new Date(a.last_updated).getTime();
  });

  const shown = sorted.slice(0, 25);
  const hidden = tags.length - shown.length;

  return (
    <div className="flex flex-col gap-2">
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Tags className="size-3.5" />
        {tags.length} tag(s)
      </p>
      {shown.map((t) => (
        <div
          key={t.name}
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-background px-3 py-2"
        >
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <span
              className={cn(
                "font-mono text-xs",
                isHash(t.name)
                  ? "text-muted-foreground"
                  : "font-medium text-foreground",
              )}
            >
              {t.name}
            </span>
            <span className="text-xs text-muted-foreground">
              {formatAge(t.last_updated)}
            </span>
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Download className="size-3" />
              {formatSize(t.size)}
            </span>
          </div>
          <DeployDialog
            apps={apps}
            defaultImage={t.image}
            source="catalogue"
            trigger={
              <Button variant="outline" size="sm">
                <Rocket className="size-3.5" />
                Déployer
              </Button>
            }
          />
        </div>
      ))}
      {hidden > 0 && (
        <p className="text-xs text-muted-foreground">
          {hidden} tag(s) supplémentaire(s) masqué(s) (digests et au-delà des 40
          premiers).
        </p>
      )}
    </div>
  );
}
