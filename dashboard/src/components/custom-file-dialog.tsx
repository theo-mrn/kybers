"use client";

import * as React from "react";
import { useState } from "react";
import { FilePlus2, Pencil, Save } from "lucide-react";

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
import { languageOf } from "@/lib/highlight";
import { normalizePath, validatePath } from "@/lib/repo-path";

/** Fichier saisi à la main, hors bibliothèque de modèles. */
export type CustomFile = { id: string; path: string; content: string };

/** Substitutions applicables, insérables au curseur. */
const PLACEHOLDERS = ["{{app}}", "{{repo}}", "{{env}}", "{{endpoint}}"];

/**
 * Édition d'un fichier ponctuel.
 *
 * Tout ne mérite pas de devenir un modèle d'organisation : un `.env.example`
 * propre à un service, une note de mise en route. Ces fichiers vivent le temps
 * du parcours de création et ne sont pas conservés dans la bibliothèque.
 *
 * Même éditeur que les modèles, pour que le geste soit identique des deux
 * côtés.
 */
export function CustomFileDialog({
  file,
  onSave,
  /** Chemins déjà retenus, pour refuser un doublon avant l'écriture. */
  taken = [],
  trigger,
}: {
  /** Fichier existant ; absent = création. */
  file?: CustomFile;
  onSave: (file: CustomFile) => void;
  taken?: string[];
  trigger?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState(file?.path ?? "");
  const [content, setContent] = useState(file?.content ?? "");

  const trimmed = path.trim();
  const invalid = trimmed ? validatePath(trimmed) : null;
  const duplicate =
    trimmed && !invalid
      ? taken.some((p) => normalizePath(p) === normalizePath(trimmed))
      : false;
  const error = invalid ?? (duplicate ? "Ce chemin est déjà utilisé." : null);

  function save() {
    if (!trimmed || error) return;
    onSave({
      id: file?.id ?? crypto.randomUUID(),
      path: trimmed,
      content,
    });
    setOpen(false);
  }

  /** Rouvrir doit repartir du fichier, pas d'une saisie abandonnée. */
  function openDialog() {
    setPath(file?.path ?? "");
    setContent(file?.content ?? "");
    setOpen(true);
  }

  return (
    <>
      <span onClick={openDialog}>
        {trigger ?? (
          <Button type="button" variant="outline" size="sm">
            <FilePlus2 className="size-3.5" />
            Fichier personnalisé
          </Button>
        )}
      </span>

      <Dialog open={open} onOpenChange={(o) => (o ? openDialog() : setOpen(false))}>
        <DialogContent className="flex h-[88vh] max-h-[88vh] flex-col sm:max-w-4xl">
          <DialogHeader className="shrink-0">
            <DialogTitle>
              {file ? "Modifier le fichier" : "Nouveau fichier"}
            </DialogTitle>
            <DialogDescription>
              Un chemin et un contenu, écrits dans le dépôt à la validation. Ce
              fichier n&apos;est pas ajouté à la bibliothèque de modèles.
            </DialogDescription>
          </DialogHeader>

          <div className="flex shrink-0 items-center gap-2">
            <Input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="src/app.ts"
              aria-label="Chemin dans le dépôt"
              aria-invalid={Boolean(error)}
              className="h-9 flex-1 font-mono"
            />
            <Badge variant="outline">{languageOf(path)}</Badge>
          </div>

          {error && (
            <p className="shrink-0 text-xs text-destructive" role="alert">
              {error}
            </p>
          )}

          <FileEditor
            value={content}
            onChange={setContent}
            language={languageOf(path)}
            className="min-h-0 flex-1"
            placeholders={PLACEHOLDERS}
          />

          <DialogFooter className="shrink-0 border-t border-border pt-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
            >
              Annuler
            </Button>
            <Button
              type="button"
              disabled={!trimmed || Boolean(error)}
              onClick={save}
            >
              {file ? (
                <Save className="size-3.5" />
              ) : (
                <FilePlus2 className="size-3.5" />
              )}
              {file ? "Enregistrer" : "Ajouter le fichier"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Déclencheur d'édition, pour une ligne de la liste. */
export function EditCustomFileButton({
  file,
  onSave,
  taken,
}: {
  file: CustomFile;
  onSave: (file: CustomFile) => void;
  taken?: string[];
}) {
  return (
    <CustomFileDialog
      file={file}
      onSave={onSave}
      taken={taken}
      trigger={
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Modifier ${file.path}`}
          title="Modifier"
        >
          <Pencil className="size-3.5" />
        </Button>
      }
    />
  );
}
