"use client";

import * as React from "react";
import { useActionState, useState } from "react";
import { Pencil, Plus, Save } from "lucide-react";

import { saveTemplateAction, type ActionState } from "@/app/actions";
import type { FileTemplate, TemplateFolder } from "@/lib/api";
import { SubmitButton, Feedback } from "@/components/forms";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { FileEditor } from "@/components/file-editor";
import { languageOf } from "@/lib/highlight";
import { validatePath } from "@/lib/repo-path";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const selectClass =
  "h-9 rounded-md border border-input bg-transparent px-2 text-sm outline-none " +
  "transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40";

/**
 * Catégorie déduite du chemin.
 *
 * Elle a une conséquence réelle — un workflow exige un jeton de déploiement,
 * donc le scope `workflow` sur GitHub — mais le chemin la donne sans ambiguïté.
 * La demander en plus, c'était faire ressaisir ce qui était déjà écrit.
 */
function kindOf(path: string): FileTemplate["kind"] {
  const p = path.toLowerCase();
  if (p.startsWith(".github/workflows/") || p.startsWith(".gitlab-ci"))
    return "pipeline";
  if (p.endsWith("readme.md")) return "readme";
  return "fichier";
}

const KIND_LABELS: Record<FileTemplate["kind"], string> = {
  pipeline: "pipeline",
  readme: "readme",
  fichier: "fichier",
};

/** Substitutions appliquées à l'écriture, dans le chemin comme le contenu. */
const PLACEHOLDERS = ["{{app}}", "{{repo}}", "{{env}}", "{{endpoint}}"];

/**
 * Édition d'un modèle de fichier.
 *
 * Un modèle, c'est un chemin et un contenu — le reste est de la paperasse. La
 * modale est donc bâtie autour de l'éditeur, qui prend toute la hauteur
 * disponible ; les métadonnées tiennent sur une ligne au-dessus.
 */
export function TemplateDialog({
  template,
  folders = [],
  defaultFolderId,
  trigger,
}: {
  /** Modèle existant ; absent = création. */
  template?: FileTemplate;
  folders?: TemplateFolder[];
  /** Dossier pré-sélectionné, quand on crée depuis l'un d'eux. */
  defaultFolderId?: string;
  trigger?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState(template?.content ?? "");
  const [path, setPath] = useState(template?.path ?? "");
  // `null` tant que le nom n'a pas été saisi à la main : il suit alors le
  // fichier. Un champ non contrôlé dont on changerait la clé serait remonté à
  // chaque frappe, ce que Base UI refuse.
  const [nameOverride, setNameOverride] = useState<string | null>(
    template?.name ?? null,
  );
  const [state, action] = useActionState<ActionState, FormData>(
    saveTemplateAction,
    null,
  );

  // Un enregistrement réussi referme : la liste rafraîchie derrière le montre.
  const isOpen = open && !state?.ok;

  // Le nom du fichier suffit comme nom de modèle : le saisir deux fois n'avait
  // pas de sens. Il reste modifiable pour les cas où le chemin est cryptique.
  const kind = kindOf(path);
  const fallbackName = path.split("/").pop() ?? "";
  const name = nameOverride ?? fallbackName;
  // Signalé pendant la frappe, mais seulement une fois qu'il y a de quoi juger.
  const pathError = path.trim() ? validatePath(path) : null;

  return (
    <>
      {trigger ? (
        <span onClick={() => setOpen(true)}>{trigger}</span>
      ) : (
        <Button size="sm" onClick={() => setOpen(true)}>
          <Plus className="size-3.5" />
          Nouveau modèle
        </Button>
      )}

      <Dialog open={isOpen} onOpenChange={setOpen}>
        <DialogContent className="flex h-[88vh] max-h-[88vh] flex-col sm:max-w-4xl">
          <DialogHeader className="shrink-0">
            <DialogTitle>
              {template ? "Modifier le modèle" : "Nouveau modèle"}
            </DialogTitle>
            <DialogDescription>
              Un chemin et un contenu. Kybers écrira ce fichier dans le dépôt
              des applications.
            </DialogDescription>
          </DialogHeader>

          <form action={action} className="flex min-h-0 flex-1 flex-col gap-3">
            <input type="hidden" name="id" value={template?.id ?? ""} />
            <input type="hidden" name="kind" value={kind} />
            <input
              type="hidden"
              name="description"
              value={template?.description ?? ""}
            />
            <input
              type="hidden"
              name="is_default"
              value={template?.is_default ? "true" : ""}
            />

            {/* Métadonnées : une seule ligne, pour laisser la place au contenu. */}
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <Input
                name="path"
                required
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="src/app.ts"
                aria-label="Chemin dans le dépôt"
                aria-invalid={Boolean(pathError)}
                className="h-9 min-w-56 flex-1 font-mono"
              />

              <select
                name="folder_id"
                aria-label="Dossier"
                defaultValue={template?.folder_id ?? defaultFolderId ?? ""}
                className={selectClass}
              >
                <option value="">Racine</option>
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>

              <Input
                name="name"
                required
                value={name}
                onChange={(e) => setNameOverride(e.target.value)}
                placeholder="Nom du modèle"
                aria-label="Nom du modèle"
                className="h-9 w-40"
              />

              <Badge variant="outline">{KIND_LABELS[kind]}</Badge>
            </div>

            {pathError && (
              <p className="shrink-0 text-xs text-destructive" role="alert">
                {pathError}
              </p>
            )}

            {/* Le contenu voyage par un champ caché : l'éditeur est un
                composant contrôlé, pas un champ de formulaire. */}
            <input type="hidden" name="content" value={content} />
            <FileEditor
              value={content}
              onChange={setContent}
              language={languageOf(path)}
              className="min-h-0 flex-1"
              placeholders={PLACEHOLDERS}
            />

            <Feedback state={state} />

            <DialogFooter className="shrink-0 border-t border-border pt-3">
              <Button
                type="button"
                variant="outline"
                onClick={() => setOpen(false)}
              >
                Annuler
              </Button>
              <SubmitButton
                label={template ? "Enregistrer" : "Créer le modèle"}
                pendingLabel="Enregistrement…"
                icon={template ? Save : Plus}
                disabled={Boolean(pathError)}
              />
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Déclencheur d'édition, pour une ligne de la liste. */
export function EditTemplateButton({
  template,
  folders = [],
}: {
  template: FileTemplate;
  folders?: TemplateFolder[];
}) {
  return (
    <TemplateDialog
      template={template}
      folders={folders}
      trigger={
        <Button variant="ghost" size="icon-sm" aria-label={`Modifier ${template.name}`}>
          <Pencil className="size-3.5" />
        </Button>
      }
    />
  );
}
