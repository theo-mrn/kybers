"use client";

import * as React from "react";
import { useMemo, useState, useTransition } from "react";
import {
  Check,
  FileCode,
  Loader2,
  Save,
  Trash2,
  Undo2,
  XCircle,
} from "lucide-react";

import type { FileTemplate } from "@/lib/api";
import { saveTemplateAction, deleteTemplateAction } from "@/app/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import { buildTree, TreeRow } from "@/components/file-tree";
import { FileEditor } from "@/components/file-editor";
import { ConfirmButton } from "@/components/confirm-button";
import { languageOf } from "@/lib/highlight";
import { validatePath } from "@/lib/repo-path";

/** Substitutions insérables au curseur. */
const PLACEHOLDERS = ["{{app}}", "{{version}}", "{{repo}}", "{{env}}"];

/**
 * Édition des fichiers d'un type, dans l'arborescence.
 *
 * Consulter et corriger sont le même geste : on ouvre un fichier parce qu'on
 * doute de son contenu, et on le corrige dans la foulée. Passer par une modale
 * séparée pour chaque fichier rompait ce fil.
 *
 * Les modifications ne partent qu'à l'enregistrement explicite : un contenu à
 * moitié saisi ne doit pas se retrouver dans les dépôts créés entre-temps.
 */
export function FileWorkbench({
  folderId,
  templates,
}: {
  folderId: string;
  templates: FileTemplate[];
}) {
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ path: string; content: string } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, startSave] = useTransition();

  const tree = useMemo(() => buildTree(templates), [templates]);

  // Sélection dérivée : un fichier supprimé ailleurs ne laisse pas un panneau
  // pointant dans le vide.
  const current = templates.find((t) => t.id === pickedId) ?? templates[0];

  // Le brouillon n'existe que pendant l'édition ; sinon on lit le modèle.
  const path = draft?.path ?? current?.path ?? "";
  const content = draft?.content ?? current?.content ?? "";
  const dirty =
    draft !== null &&
    (draft.path !== current?.path || draft.content !== current?.content);

  const pathError = path.trim() ? validatePath(path) : "Chemin requis.";
  const conflict = templates.some(
    (t) => t.id !== current?.id && t.path === path.trim(),
  );

  function select(t: FileTemplate) {
    // Changer de fichier abandonne une saisie non enregistrée : la garder
    // l'appliquerait au mauvais fichier.
    setPickedId(t.id);
    setDraft(null);
    setError(null);
  }

  function edit(patch: Partial<{ path: string; content: string }>) {
    setDraft({
      path: draft?.path ?? current?.path ?? "",
      content: draft?.content ?? current?.content ?? "",
      ...patch,
    });
  }

  function save() {
    if (!current || !dirty || pathError || conflict) return;

    const data = new FormData();
    data.set("id", current.id);
    data.set("name", current.name);
    data.set("kind", current.kind);
    data.set("folder_id", folderId);
    data.set("description", current.description);
    data.set("path", path.trim());
    data.set("content", content);
    if (current.is_default) data.set("is_default", "true");

    setError(null);
    startSave(async () => {
      const res = await saveTemplateAction(null, data);
      if (res?.ok) setDraft(null);
      else setError(res?.message ?? "Échec de l'enregistrement.");
    });
  }

  function remove(t: FileTemplate) {
    const data = new FormData();
    data.set("id", t.id);
    startSave(async () => {
      const res = await deleteTemplateAction(null, data);
      if (!res?.ok) setError(res?.message ?? "Échec de la suppression.");
      else if (t.id === current?.id) {
        setPickedId(null);
        setDraft(null);
      }
    });
  }

  if (templates.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
        Aucun fichier — ce type produirait un dépôt vide.
      </p>
    );
  }

  return (
    <ResizablePanelGroup
      orientation="horizontal"
      className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border"
    >
      <ResizablePanel defaultSize="30%" minSize="18%" maxSize="50%">
        <div className="flex h-full min-h-0 flex-col bg-muted/20">
          <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2 text-xs text-muted-foreground">
            <FileCode className="size-3.5" />
            {templates.length} fichier{templates.length > 1 ? "s" : ""}
          </div>

          <ScrollArea className="min-h-0 flex-1">
            <div className="p-2">
              {tree.map((node) => (
                <TreeRow
                  key={node.key}
                  node={node}
                  depth={0}
                  selectedId={current?.id ?? null}
                  onSelect={select}
                  decorate={(t) =>
                    // Un point signale la saisie en cours : quitter le fichier
                    // la perdrait, autant que ça se voie.
                    dirty && t.id === current?.id
                      ? { className: "text-primary" }
                      : {}
                  }
                />
              ))}
            </div>
          </ScrollArea>
        </div>
      </ResizablePanel>

      <ResizableHandle withHandle />

      <ResizablePanel defaultSize="70%" minSize="40%">
        {current && (
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
              <Input
                value={path}
                onChange={(e) => edit({ path: e.target.value })}
                aria-label="Chemin dans le dépôt"
                aria-invalid={Boolean(pathError) || conflict}
                className="h-8 min-w-48 flex-1 font-mono text-xs"
              />

              <Badge variant="outline" className="font-mono">
                {languageOf(path)}
              </Badge>

              {dirty ? (
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => setDraft(null)}
                    disabled={saving}
                  >
                    <Undo2 className="size-3" />
                    Annuler
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    onClick={save}
                    disabled={saving || Boolean(pathError) || conflict}
                  >
                    {saving ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <Save className="size-3" />
                    )}
                    Enregistrer
                  </Button>
                </>
              ) : (
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Check className="size-3" />
                  à jour
                </span>
              )}

              <ConfirmButton
                onConfirm={() => remove(current)}
                title="Supprimer ce fichier"
                description={`« ${current.path} » ne sera plus écrit par ce type.`}
                confirmLabel="Supprimer"
                icon={Trash2}
                ariaLabel={`Supprimer ${current.path}`}
                size="icon-xs"
                className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              />
            </div>

            {(pathError || conflict || error) && (
              <p
                className="flex shrink-0 items-center gap-1.5 border-b border-destructive/30 bg-destructive/5 px-3 py-1.5 text-xs text-destructive"
                role="alert"
              >
                <XCircle className="size-3 shrink-0" />
                {error ??
                  (conflict ? "Ce chemin est déjà utilisé." : pathError)}
              </p>
            )}

            <FileEditor
              value={content}
              onChange={(v) => edit({ content: v })}
              language={languageOf(path)}
              placeholders={PLACEHOLDERS}
              className="min-h-0 flex-1 rounded-none border-0"
            />
          </div>
        )}
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

