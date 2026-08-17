"use client";

import * as React from "react";
import { useMemo, useState, useTransition } from "react";
import {
  BookText,
  Check,
  Copy,
  FileCode,
  FileText,
  Boxes,
  FolderOpen,
  Layers,
  Search,
  Star,
  TriangleAlert,
} from "lucide-react";

import type { FileTemplate, TemplateFolder } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import { buildTree, CodeBlock, TreeRow } from "@/components/file-tree";
import { EditTemplateButton, TemplateDialog } from "@/components/template-dialog";
import { DeleteTemplateButton } from "@/components/delete-template-button";
import { FolderDialog, DeleteFolderButton } from "@/components/folder-dialog";
import { languageOf } from "@/lib/highlight";
import { canMove, dirname, moveTo } from "@/lib/repo-path";
import { moveTemplateAction } from "@/app/actions";
import { cn } from "@/lib/utils";

const KIND_ICONS = {
  pipeline: FileCode,
  readme: BookText,
  fichier: FileText,
} as const;

const ALL = "__all";

/**
 * Explorateur de la bibliothèque de modèles.
 *
 * Une liste de cartes montrait le nom des modèles, pas la forme du dépôt
 * qu'ils produisent. L'arborescence rend visible ce que le chemin de chaque
 * modèle implique — un `.github/workflows/` qui apparaît là où on l'attend —
 * et la même lecture que l'aperçu de création : même arbre, même coloration.
 *
 * Les dossiers de modèles ne sont pas des dossiers du dépôt : ils groupent par
 * intention. On choisit donc d'abord un dossier, puis on lit l'arborescence
 * des chemins qu'il contient.
 */
export function TemplateExplorer({
  templates,
  folders,
}: {
  templates: FileTemplate[];
  folders: TemplateFolder[];
}) {
  const [folderId, setFolderId] = useState<string>(ALL);
  const [q, setQ] = useState("");
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [dragging, setDragging] = useState<FileTemplate | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [overRoot, setOverRoot] = useState(false);
  // Doublon volontaire de `dragging` : lisible dès `dragstart`, quand l'état
  // React ne l'est pas encore.
  const dragRef = React.useRef<FileTemplate | null>(null);
  const [moving, startMove] = useTransition();

  const needle = q.trim().toLowerCase();
  const folderById = useMemo(
    () => new Map(folders.map((f) => [f.id, f])),
    [folders],
  );

  const visible = useMemo(() => {
    const scoped =
      folderId === ALL
        ? templates
        : templates.filter((t) => (t.folder_id ?? "") === folderId);

    if (!needle) return scoped;
    return scoped.filter((t) => {
      const folder = folderById.get(t.folder_id ?? "")?.name ?? "";
      return `${t.name} ${t.path} ${t.description} ${folder}`
        .toLowerCase()
        .includes(needle);
    });
  }, [templates, folderId, needle, folderById]);

  const tree = useMemo(() => buildTree(visible), [visible]);

  /**
   * Déplace un modèle vers un dossier du dépôt.
   *
   * La vérification porte sur les modèles du même dossier de bibliothèque :
   * l'unicité du chemin est contrainte par `(org_id, folder_id, path)`, deux
   * bundles pouvant légitimement proposer le même fichier.
   */
  function move(template: FileTemplate, dir: string) {
    const siblings = templates
      .filter(
        (t) =>
          t.id !== template.id &&
          (t.folder_id ?? "") === (template.folder_id ?? ""),
      )
      .map((t) => t.path);

    const refusal = canMove(template.path, dir, siblings);
    if (refusal) {
      setMoveError(refusal);
      setDragging(null);
      return;
    }

    setMoveError(null);
    startMove(async () => {
      const res = await moveTemplateAction(template, moveTo(template.path, dir));
      if (!res?.ok) setMoveError(res?.message ?? "Échec du déplacement.");
    });
  }

  // Sélection dérivée : si le modèle ouvert sort du filtre, on retombe sur le
  // premier visible plutôt que d'afficher un panneau vide.
  const current = visible.find((t) => t.id === pickedId) ?? visible[0];

  async function copy() {
    if (!current) return;
    try {
      await navigator.clipboard.writeText(current.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Presse-papiers refusé : le contenu reste sélectionnable à la main.
    }
  }

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of templates) {
      const k = t.folder_id || "";
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  }, [templates]);

  const rootCount = counts.get("") ?? 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Rechercher un fichier…"
            className="pl-9"
          />
        </div>
        <FolderDialog />
        <TemplateDialog
          folders={folders}
          defaultFolderId={folderId === ALL ? undefined : folderId}
        />
      </div>

      <ResizablePanelGroup
        orientation="horizontal"
        className="min-h-[32rem] overflow-hidden rounded-lg border border-border"
      >
        {/* ---- Dossiers de modèles ------------------------------------- */}
        <ResizablePanel defaultSize="22%" minSize="15%" maxSize="40%">
          <div className="flex h-full min-h-0 flex-col bg-muted/20">
            <p className="shrink-0 border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">
              Dossiers
            </p>
            <ScrollArea className="min-h-0 flex-1">
              <div className="flex flex-col gap-0.5 p-2">
                <FolderRow
                  label="Tous les fichiers"
                  icon={Layers}
                  count={templates.length}
                  active={folderId === ALL}
                  onClick={() => setFolderId(ALL)}
                />

                {folders.map((f) => (
                  <FolderRow
                    key={f.id}
                    label={f.name}
                    // Un type se distingue au premier regard : il ouvre un
                    // parcours de création, pas seulement un rangement.
                    icon={f.is_golden_path ? Boxes : FolderOpen}
                    count={counts.get(f.id) ?? 0}
                    active={folderId === f.id}
                    onClick={() => setFolderId(f.id)}
                  />
                ))}

                {rootCount > 0 && (
                  <FolderRow
                    label="Sans dossier"
                    icon={FileText}
                    count={rootCount}
                    active={folderId === ""}
                    onClick={() => setFolderId("")}
                  />
                )}
              </div>
            </ScrollArea>

            {/* Les actions portent sur le dossier ouvert : les répéter sur
                chaque ligne encombrerait la colonne. */}
            {folderId !== ALL && folderId !== "" && folderById.has(folderId) && (
              <div className="flex shrink-0 items-center gap-1 border-t border-border p-2">
                <FolderDialog
                  folder={folderById.get(folderId)}
                  templates={templates.filter((t) => t.folder_id === folderId)}
                  trigger={
                    <Button variant="ghost" size="xs">
                      Renommer
                    </Button>
                  }
                />
                <DeleteFolderButton folder={folderById.get(folderId)!} />
              </div>
            )}
          </div>
        </ResizablePanel>

        <ResizableHandle withHandle />

        {/* ---- Arborescence des chemins -------------------------------- */}
        <ResizablePanel defaultSize="30%" minSize="20%" maxSize="45%">
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2 text-xs text-muted-foreground">
              <span>
                {visible.length} fichier{visible.length > 1 ? "s" : ""}
                {needle && ` pour « ${q} »`}
              </span>
              {moving && <span>Déplacement…</span>}
            </div>

            {moveError && (
              <p
                role="alert"
                className="flex shrink-0 items-start gap-1.5 border-b border-destructive/30 bg-destructive/5 px-3 py-1.5 text-xs text-destructive"
              >
                <TriangleAlert className="mt-0.5 size-3 shrink-0" />
                {moveError}
              </p>
            )}

            {/* Remonter un fichier à la racine demande une cible dédiée : les
                nœuds de l'arbre ne représentent que les sous-dossiers. Elle
                reste hors du défilement, pour être atteignable où qu'on soit
                dans l'arborescence. */}
            {dragging && dirname(dragging.path) !== "" && (
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  setOverRoot(true);
                }}
                onDragLeave={(e) => {
                  if (e.currentTarget.contains(e.relatedTarget as Node | null))
                    return;
                  setOverRoot(false);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  setOverRoot(false);
                  const held = dragRef.current ?? dragging;
                  if (held) move(held, "");
                  dragRef.current = null;
                  setDragging(null);
                }}
                className={cn(
                  "mx-2 mt-2 shrink-0 rounded-md border border-dashed px-3 py-2 text-center text-xs transition-colors",
                  overRoot
                    ? "border-primary bg-primary/15 text-primary"
                    : "border-primary/40 bg-primary/5 text-primary/80",
                )}
              >
                Déposer ici pour remonter à la racine du dépôt
              </div>
            )}

            <ScrollArea className="min-h-0 flex-1">
              <div className="p-2">
                {tree.length === 0 ? (
                  <p className="px-2 py-8 text-center text-xs text-muted-foreground">
                    {needle
                      ? "Aucun fichier ne correspond."
                      : "Ce dossier est vide."}
                  </p>
                ) : (
                  tree.map((node) => (
                    <TreeRow
                      key={node.key}
                      node={node}
                      depth={0}
                      selectedId={current?.id ?? null}
                      onSelect={(t) => setPickedId(t.id)}
                      onMove={move}
                      dragging={dragging}
                      onDragChange={setDragging}
                      dragRef={dragRef}
                      decorate={(t) => ({
                        icon: React.createElement(
                          KIND_ICONS[t.kind] ?? FileText,
                          { className: "size-3.5 shrink-0" },
                        ),
                      })}
                    />
                  ))
                )}
              </div>
            </ScrollArea>
          </div>
        </ResizablePanel>

        <ResizableHandle withHandle />

        {/* ---- Contenu du modèle --------------------------------------- */}
        <ResizablePanel defaultSize="48%" minSize="30%">
          {current ? (
            <div className="flex h-full min-h-0 flex-col">
              <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-1.5">
                <div className="flex min-w-0 items-center gap-2">
                  <Badge variant="outline" className="font-mono">
                    {languageOf(current.path)}
                  </Badge>
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {current.path}
                  </span>
                  {current.is_default && (
                    <Badge
                      variant="secondary"
                      className="gap-1 border-transparent bg-primary/15 text-primary"
                    >
                      <Star className="size-3" />
                      recommandé
                    </Badge>
                  )}
                </div>

                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    onClick={copy}
                    aria-label="Copier le contenu"
                    title="Copier"
                  >
                    {copied ? (
                      <Check className="size-3.5 text-success" />
                    ) : (
                      <Copy className="size-3.5" />
                    )}
                  </Button>
                  <EditTemplateButton template={current} folders={folders} />
                  <DeleteTemplateButton template={current} />
                </div>
              </div>

              {current.description && (
                <p className="shrink-0 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
                  {current.description}
                </p>
              )}

              <ScrollArea className="min-h-0 flex-1">
                {current.content.trim() ? (
                  <CodeBlock
                    code={current.content}
                    language={languageOf(current.path)}
                  />
                ) : (
                  <p className="px-3 py-8 text-center text-xs text-muted-foreground">
                    Ce modèle est vide.
                  </p>
                )}
              </ScrollArea>
            </div>
          ) : (
            <p className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground">
              Sélectionnez un fichier pour en voir le contenu.
            </p>
          )}
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}

function FolderRow({
  label,
  icon: Icon,
  count,
  active,
  onClick,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
        active
          ? "bg-primary/10 text-primary"
          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
      )}
    >
      <Icon className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="shrink-0 text-xs tabular">{count}</span>
    </button>
  );
}
