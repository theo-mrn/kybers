"use client";

import * as React from "react";
import { useMemo, useState } from "react";
import {
  ArrowLeft,
  BookText,
  Check,
  ChevronRight,
  FileCode,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Layers,
  Search,
  Star,
  Trash2,
} from "lucide-react";

import type { FileTemplate, TemplateFolder } from "@/lib/api";
import {
  CustomFileDialog,
  EditCustomFileButton,
  type CustomFile,
} from "@/components/custom-file-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FileEditor } from "@/components/file-editor";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const KIND_ICONS = {
  pipeline: FileCode,
  readme: BookText,
  fichier: FileText,
} as const;

const ROOT = "__root";

/**
 * Sélecteur de fichiers issus des modèles.
 *
 * Une liste à plat oblige à tout parcourir dès qu'une organisation a quelques
 * dizaines de modèles. On navigue donc dans les dossiers, avec un fil
 * d'Ariane pour revenir, une recherche qui traverse toute la bibliothèque, et
 * un aperçu du contenu — choisir un fichier sans voir ce qu'il contient
 * revient à choisir à l'aveugle.
 */
export function FilePicker({
  templates,
  folders,
  selected,
  onChange,
  /** Substitutions appliquées à l'aperçu, pour montrer le fichier final. */
  renderPath,
  renderContent,
  /** Fichiers saisis à la main, hors bibliothèque. */
  custom = [],
  onCustomChange,
  compact = false,
}: {
  templates: FileTemplate[];
  folders: TemplateFolder[];
  selected: string[];
  onChange: (ids: string[]) => void;
  renderPath: (path: string) => string;
  renderContent: (content: string) => string;
  custom?: CustomFile[];
  onCustomChange?: (files: CustomFile[]) => void;
  /** N'affiche que les actions : la liste est rendue ailleurs. */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // `null` = racine de la navigation ; sinon l'id du dossier ouvert.
  const [folderId, setFolderId] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [preview, setPreview] = useState<FileTemplate | null>(null);
  // Sélection provisoire : on ne valide qu'à la fermeture, pour pouvoir
  // annuler un parcours entier.
  const [draft, setDraft] = useState<string[]>(selected);

  const needle = q.trim().toLowerCase();
  const byId = useMemo(
    () => new Map(templates.map((t) => [t.id, t])),
    [templates],
  );
  const folderById = useMemo(
    () => new Map(folders.map((f) => [f.id, f])),
    [folders],
  );

  const inFolder = (id: string | null) =>
    templates.filter((t) => (t.folder_id || ROOT) === (id ?? ROOT));

  // La recherche traverse toute la bibliothèque : on cherche un fichier, pas
  // l'endroit où il est rangé.
  const results = useMemo(() => {
    if (!needle) return null;
    return templates.filter((t) => {
      const folder = folderById.get(t.folder_id ?? "")?.name ?? "";
      return `${t.name} ${t.path} ${t.description} ${folder}`
        .toLowerCase()
        .includes(needle);
    });
  }, [templates, folderById, needle]);

  const rootFiles = inFolder(null);
  const current = folderId ? inFolder(folderId) : rootFiles;
  const visible = results ?? current;

  function toggle(id: string) {
    setDraft((d) => (d.includes(id) ? d.filter((x) => x !== id) : [...d, id]));
  }

  function toggleAll(items: FileTemplate[], allChecked: boolean) {
    const ids = items.map((t) => t.id);
    setDraft((d) =>
      allChecked
        ? d.filter((x) => !ids.includes(x))
        : [...new Set([...d, ...ids])],
    );
  }

  function openPicker() {
    setDraft(selected);
    setFolderId(null);
    setQ("");
    setPreview(null);
    setOpen(true);
  }

  function confirm() {
    onChange(draft);
    setOpen(false);
  }

  const chosen = selected
    .map((id) => byId.get(id))
    .filter((t): t is FileTemplate => Boolean(t));

  const empty = chosen.length === 0 && custom.length === 0;

  /** Chemins déjà retenus : un fichier ponctuel ne doit pas en doubler un. */
  const takenPaths = [
    ...chosen.map((t) => renderPath(t.path)),
    ...custom.map((f) => f.path),
  ];

  function saveCustom(file: CustomFile) {
    const others = custom.filter((f) => f.id !== file.id);
    onCustomChange?.([...others, file]);
  }

  // Le navigateur est le même dans les deux rendus : l'extraire évite de le
  // dupliquer, et donc de le laisser diverger.
  const picker = (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="flex h-[85vh] max-h-[85vh] flex-col sm:max-w-5xl">
        <DialogHeader className="shrink-0">
          <DialogTitle>Ajouter des fichiers</DialogTitle>
          <DialogDescription>
            Parcourez vos dossiers de modèles ou cherchez un fichier. Un
            dossier entier s&apos;ajoute d&apos;un seul geste.
          </DialogDescription>
        </DialogHeader>

        <div className="relative shrink-0">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Rechercher dans tous les dossiers…"
            className="pl-9"
          />
        </div>

        <div className="flex min-h-0 flex-1 gap-4">
          {/* Colonne gauche : dossiers. */}
          <div className="hidden w-56 shrink-0 flex-col gap-1 overflow-y-auto border-r border-border pr-3 sm:flex">
            <FolderRow
              label="Tous les fichiers"
              icon={Layers}
              count={templates.length}
              active={folderId === null && !needle}
              onClick={() => {
                setFolderId(null);
                setQ("");
              }}
            />
            {folders.map((f) => (
              <FolderRow
                key={f.id}
                label={f.name}
                icon={folderId === f.id ? FolderOpen : Folder}
                count={inFolder(f.id).length}
                active={folderId === f.id && !needle}
                onClick={() => {
                  setFolderId(f.id);
                  setQ("");
                }}
              />
            ))}
          </div>

          {/* Colonne centrale : fichiers. */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
            <div className="flex shrink-0 items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                {needle ? (
                  <span>
                    {visible.length} résultat{visible.length > 1 ? "s" : ""}{" "}
                    pour « {q} »
                  </span>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => setFolderId(null)}
                      className="hover:text-foreground"
                    >
                      Modèles
                    </button>
                    {folderId && (
                      <>
                        <ChevronRight className="size-3" />
                        <span className="truncate text-foreground">
                          {folderById.get(folderId)?.name}
                        </span>
                      </>
                    )}
                  </>
                )}
              </div>

              {visible.length > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() =>
                    toggleAll(
                      visible,
                      visible.every((t) => draft.includes(t.id)),
                    )
                  }
                >
                  {visible.every((t) => draft.includes(t.id))
                    ? "Tout retirer"
                    : "Tout ajouter"}
                </Button>
              )}
            </div>

            <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto pr-1">
              {/* En racine, les dossiers apparaissent comme des entrées :
                  c'est ainsi qu'on navigue sans la colonne de gauche. */}
              {!needle &&
                !folderId &&
                folders.map((f) => {
                  const items = inFolder(f.id);
                  const all =
                    items.length > 0 &&
                    items.every((t) => draft.includes(t.id));
                  return (
                    <div
                      key={f.id}
                      className="flex items-center gap-2 rounded-lg border border-border px-3 py-2.5 sm:hidden"
                    >
                      <button
                        type="button"
                        onClick={() => setFolderId(f.id)}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      >
                        <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate text-sm">{f.name}</span>
                        <Badge variant="outline">{items.length}</Badge>
                      </button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        disabled={items.length === 0}
                        onClick={() => toggleAll(items, all)}
                      >
                        {all ? (
                          <Check className="size-3" />
                        ) : (
                          <FolderPlus className="size-3" />
                        )}
                        {all ? "Retirer" : "Tout ajouter"}
                      </Button>
                    </div>
                  );
                })}

              {visible.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border px-3 py-8 text-center text-sm text-muted-foreground">
                  {needle
                    ? `Aucun fichier ne correspond à « ${q} ».`
                    : "Ce dossier est vide."}
                </p>
              ) : (
                visible.map((t) => {
                  const Icon = KIND_ICONS[t.kind] ?? FileText;
                  const checked = draft.includes(t.id);
                  const folder = folderById.get(t.folder_id ?? "");
                  return (
                    <div
                      key={t.id}
                      className={cn(
                        "flex items-start gap-3 rounded-lg border p-3 transition-colors",
                        checked
                          ? "border-primary/50 bg-primary/5"
                          : "border-border hover:bg-muted/60",
                        preview?.id === t.id && "ring-1 ring-ring/40",
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggle(t.id)}
                        aria-label={t.name}
                        className="mt-0.5 size-4 shrink-0 accent-primary"
                      />
                      <button
                        type="button"
                        onClick={() => setPreview(t)}
                        className="min-w-0 flex-1 text-left"
                      >
                        <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                          <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                          {t.name}
                          {t.is_default && (
                            <Badge
                              variant="secondary"
                              className="gap-1 border-transparent bg-primary/15 text-primary"
                            >
                              <Star className="size-3" />
                              recommandé
                            </Badge>
                          )}
                          {needle && folder && (
                            <Badge variant="outline">{folder.name}</Badge>
                          )}
                        </p>
                        <p className="truncate font-mono text-xs text-muted-foreground">
                          {renderPath(t.path)}
                        </p>
                        {t.description && (
                          <p className="mt-0.5 truncate text-xs text-muted-foreground">
                            {t.description}
                          </p>
                        )}
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Colonne droite : aperçu du fichier tel qu'il sera écrit. */}
          <div className="hidden min-h-0 w-[22rem] shrink-0 flex-col gap-2 border-l border-border pl-4 lg:flex">
            {preview ? (
              <>
                <div className="flex shrink-0 items-start justify-between gap-2">
                  <p className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                    {renderPath(preview.path)}
                  </p>
                  <Button
                    type="button"
                    variant={
                      draft.includes(preview.id) ? "secondary" : "outline"
                    }
                    size="xs"
                    onClick={() => toggle(preview.id)}
                  >
                    {draft.includes(preview.id) ? (
                      <>
                        <Check className="size-3" />
                        Ajouté
                      </>
                    ) : (
                      "Ajouter"
                    )}
                  </Button>
                </div>
                <FileEditor
                  value={renderContent(preview.content)}
                  readOnly
                  className="min-h-0 flex-1"
                />
              </>
            ) : (
              <p className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-border px-4 text-center text-xs text-muted-foreground">
                Sélectionnez un fichier pour en voir le contenu.
              </p>
            )}
          </div>
        </div>

        <DialogFooter className="shrink-0 items-center border-t border-border pt-3 sm:justify-between">
          <p className="text-xs text-muted-foreground">
            {draft.length} fichier{draft.length > 1 ? "s" : ""} sélectionné
            {draft.length > 1 ? "s" : ""}
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
            >
              <ArrowLeft className="size-3.5" />
              Annuler
            </Button>
            <Button type="button" onClick={confirm}>
              <Check className="size-3.5" />
              Valider la sélection
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  if (compact) {
    return (
      <>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={openPicker}>
            <FilePlus2 className="size-3.5" />
            Ajouter un fichier
          </Button>
          {onCustomChange && (
            <CustomFileDialog onSave={saveCustom} taken={takenPaths} />
          )}
        </div>
        {picker}
      </>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* ---- Fichiers retenus -------------------------------------------- */}
      {empty ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-4 py-8 text-center">
          <FilePlus2 className="size-6 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium">Aucun fichier</p>
            <p className="text-xs text-muted-foreground">
              Le dépôt sera créé vide. Vous pourrez ajouter des fichiers plus
              tard depuis l&apos;application.
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={openPicker}
            >
              <FilePlus2 className="size-3.5" />
              Ajouter des fichiers
            </Button>

            {onCustomChange && (
              <CustomFileDialog onSave={saveCustom} taken={takenPaths} />
            )}

            <FolderShortcuts
              folders={folders}
              templates={templates}
              selected={selected}
              onChange={onChange}
            />
          </div>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            {chosen.map((t) => {
              const Icon = KIND_ICONS[t.kind] ?? FileText;
              const folder = folderById.get(t.folder_id ?? "");
              return (
                <div
                  key={t.id}
                  className="flex items-center gap-2 rounded-lg border border-border px-3 py-2"
                >
                  <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">
                    {renderPath(t.path)}
                  </span>
                  {folder && (
                    <Badge variant="outline" className="shrink-0">
                      {folder.name}
                    </Badge>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Retirer ${t.name}`}
                    title="Retirer"
                    onClick={() => onChange(selected.filter((x) => x !== t.id))}
                    className="shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              );
            })}
            {custom.map((f) => (
              <div
                key={f.id}
                className="flex items-center gap-2 rounded-lg border border-border px-3 py-2"
              >
                <FilePlus2 className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-mono text-xs">
                  {renderPath(f.path)}
                </span>
                <Badge variant="outline" className="shrink-0">
                  personnalisé
                </Badge>
                <EditCustomFileButton
                  file={f}
                  onSave={saveCustom}
                  taken={takenPaths.filter(
                    (p) => p !== f.path && p !== renderPath(f.path),
                  )}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Retirer ${f.path}`}
                  title="Retirer"
                  onClick={() =>
                    onCustomChange?.(custom.filter((x) => x.id !== f.id))
                  }
                  className="shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={openPicker}
            >
              <FilePlus2 className="size-3.5" />
              Ajouter des fichiers
            </Button>

            {onCustomChange && (
              <CustomFileDialog onSave={saveCustom} taken={takenPaths} />
            )}

            <FolderShortcuts
              folders={folders}
              templates={templates}
              selected={selected}
              onChange={onChange}
            />
          </div>
        </>
      )}

      {picker}
    </div>
  );
}

/**
 * Ajout d'un dossier entier, sans passer par le navigateur.
 *
 * Les conventions d'équipe tiennent souvent dans un dossier — « service Go »,
 * « conformité » — et on les veut au complet. Ouvrir le sélecteur pour cocher
 * cinq fichiers un à un était le chemin le plus long vers le cas le plus
 * fréquent. Le bouton bascule : un second clic retire ce qu'il a ajouté.
 */
function FolderShortcuts({
  folders,
  templates,
  selected,
  onChange,
}: {
  folders: TemplateFolder[];
  templates: FileTemplate[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const withFiles = folders
    .map((f) => ({
      folder: f,
      ids: templates.filter((t) => t.folder_id === f.id).map((t) => t.id),
    }))
    .filter((x) => x.ids.length > 0);

  if (withFiles.length === 0) return null;

  return (
    <>
      <span className="text-xs text-muted-foreground">ou tout un dossier :</span>

      {withFiles.map(({ folder, ids }) => {
        const all = ids.every((id) => selected.includes(id));
        return (
          <Button
            key={folder.id}
            type="button"
            variant={all ? "secondary" : "outline"}
            size="sm"
            title={
              all
                ? `Retirer les ${ids.length} fichiers de ${folder.name}`
                : `Ajouter les ${ids.length} fichiers de ${folder.name}`
            }
            onClick={() =>
              onChange(
                all
                  ? selected.filter((x) => !ids.includes(x))
                  : [...new Set([...selected, ...ids])],
              )
            }
          >
            {all ? (
              <Check className="size-3.5" />
            ) : (
              <FolderPlus className="size-3.5" />
            )}
            {folder.name}
            <Badge variant="outline">{ids.length}</Badge>
          </Button>
        );
      })}
    </>
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
