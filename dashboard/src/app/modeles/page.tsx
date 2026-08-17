import Link from "next/link";
import { redirect } from "next/navigation";
import { Boxes, FileCode } from "lucide-react";

import { api, type BuiltinGoldenPath } from "@/lib/api";
import { TemplateExplorer } from "@/components/template-explorer";
import { GoldenPathsPanel } from "@/components/golden-paths-panel";
import { PageHeader } from "@/components/ui";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

const TABS = [
  ["types", "Types d'application", Boxes],
  ["fichiers", "Fichiers libres", FileCode],
] as const;

/**
 * Bibliothèque de modèles de l'organisation.
 *
 * Deux matières distinctes, deux onglets : les types d'application, qui
 * produisent un dépôt complet et portent leurs propres fichiers ; les fichiers
 * libres, ajoutés à la demande à n'importe quelle application.
 *
 * Les fichiers d'un type n'apparaissent pas dans les fichiers libres : ils
 * n'ont de sens qu'avec le type qui les accompagne, et les mélanger rendait
 * les deux listes illisibles.
 */
export default async function TemplatesPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;
  const activeTab = TABS.some(([k]) => k === tab) ? tab! : "types";

  if (!(await api.me().catch(() => null))) redirect("/login");

  const [templates, folders, builtin] = await Promise.all([
    api.listTemplates().catch(() => []),
    api.listFolders().catch(() => []),
    api.listBuiltinGoldenPaths().catch(() => [] as BuiltinGoldenPath[]),
  ]);

  const goldenPaths = folders.filter((f) => f.is_golden_path);
  const goldenIds = new Set(goldenPaths.map((f) => f.id));

  // Ce qui appartient à un type lui reste attaché ; le reste est libre.
  const goldenFiles = templates.filter((t) => goldenIds.has(t.folder_id ?? ""));
  const freeFiles = templates.filter((t) => !goldenIds.has(t.folder_id ?? ""));
  const freeFolders = folders.filter((f) => !f.is_golden_path);

  const counts: Record<string, number> = {
    types: goldenPaths.length,
    fichiers: freeFiles.length,
  };

  return (
    <>
      <PageHeader
        title="Modèles"
        description="Les types d'application qui produisent un dépôt prêt à démarrer, et les fichiers que vous ajoutez à la demande."
      />

      <nav className="flex items-center gap-1 border-b border-border">
        {TABS.map(([key, label, Icon]) => (
          <Link
            key={key}
            href={`/modeles?tab=${key}`}
            aria-current={activeTab === key ? "page" : undefined}
            className={cn(
              "-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors",
              activeTab === key
                ? "border-primary font-medium text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-3.5" />
            {label}
            {counts[key] > 0 && (
              <Badge variant="secondary" className="ml-1">
                {counts[key]}
              </Badge>
            )}
          </Link>
        ))}
      </nav>

      {activeTab === "types" ? (
        <GoldenPathsPanel
          paths={goldenPaths}
          builtin={builtin}
          templates={goldenFiles}
        />
      ) : (
        <TemplateExplorer templates={freeFiles} folders={freeFolders} />
      )}
    </>
  );
}
