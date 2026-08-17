"use client";

import { useActionState, useState } from "react";
import { Boxes, FileCode, FolderPlus, Plus, Save, Trash2 } from "lucide-react";

import {
  saveFolderAction,
  deleteFolderAction,
  type ActionState,
} from "@/app/actions";
import type { FileTemplate, TemplateFolder } from "@/lib/api";
import { TemplateDialog } from "@/components/template-dialog";
import { VersionFilter } from "@/components/version-filter";
import { FileWorkbench } from "@/components/file-workbench";
import { cn } from "@/lib/utils";
import { SubmitButton, Feedback } from "@/components/forms";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** Création ou renommage d'un dossier de modèles. */
export function FolderDialog({
  folder,
  templates = [],
  trigger,
}: {
  folder?: TemplateFolder;
  /** Fichiers du dossier, éditables ici. */
  templates?: FileTemplate[];
  trigger?: React.ReactNode;
}) {
  // Les réglages n'ont de sens que pour un type : les afficher toujours
  // encombrerait la création d'un dossier ordinaire.
  const [golden, setGolden] = useState(folder?.is_golden_path ?? false);
  const [image, setImage] = useState(folder?.runtime_image ?? "");
  const [versions, setVersions] = useState(folder?.versions ?? "");
  const [open, setOpen] = useState(false);
  // Les réglages et les fichiers répondent à deux questions distinctes :
  // comment le type se comporte, et ce qu'il produit.
  const [tab, setTab] = useState<"infos" | "fichiers">("infos");
  const [state, action] = useActionState<ActionState, FormData>(
    saveFolderAction,
    null,
  );

  const isOpen = open && !state?.ok;

  return (
    <>
      {trigger ? (
        <span onClick={() => setOpen(true)}>{trigger}</span>
      ) : (
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          <FolderPlus className="size-3.5" />
          Nouveau dossier
        </Button>
      )}

      <Dialog open={isOpen} onOpenChange={setOpen}>
        <DialogContent
          className={cn(
            "flex flex-col",
            // Le visualiseur affiche deux panneaux : il lui faut de la largeur
            // et une hauteur bornée.
            folder && tab === "fichiers"
              ? "h-[88vh] max-h-[88vh] sm:max-w-5xl"
              : "max-h-[85vh] sm:max-w-2xl",
          )}
        >
          <DialogHeader>
            <DialogTitle>
              {folder ? "Renommer le dossier" : "Nouveau dossier"}
            </DialogTitle>
            <DialogDescription>
              Un dossier regroupe les fichiers d&apos;un même usage et s&apos;ajoute
              en bloc à la création d&apos;une application.
            </DialogDescription>
          </DialogHeader>

          {/* Les onglets n'ont de sens que sur un type existant : à la
              création, il n'y a pas encore de fichier à montrer. */}
          {folder && (
            <nav className="flex shrink-0 items-center gap-1 border-b border-border">
              {(
                [
                  ["infos", "Informations", Boxes],
                  ["fichiers", `Fichiers (${templates.length})`, FileCode],
                ] as const
              ).map(([key, label, Icon]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setTab(key)}
                  aria-current={tab === key ? "page" : undefined}
                  className={cn(
                    "-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors",
                    tab === key
                      ? "border-primary font-medium text-primary"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Icon className="size-3.5" />
                  {label}
                </button>
              ))}
            </nav>
          )}

          <form
            action={action}
            className={cn(
              "flex max-h-[70vh] flex-col gap-4 overflow-y-auto pr-1",
              folder && tab === "fichiers" && "hidden",
            )}
          >
            <input type="hidden" name="id" value={folder?.id ?? ""} />

            <div className="space-y-1.5">
              <Label htmlFor="folder_name">Nom</Label>
              <Input
                id="folder_name"
                name="name"
                required
                defaultValue={folder?.name}
                placeholder="Service Go"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="folder_description">
                Description <span className="text-muted-foreground">(optionnel)</span>
              </Label>
              <Input
                id="folder_description"
                name="description"
                defaultValue={folder?.description}
                placeholder="Pipeline, Dockerfile et conventions de nos services Go."
              />
            </div>

            <Feedback state={state} />

            {/* --- Golden path ------------------------------------------ */}
            <label className="flex items-start gap-2.5 rounded-lg border border-border p-3 text-sm">
              <input
                type="checkbox"
                name="is_golden_path"
                value="true"
                defaultChecked={folder?.is_golden_path}
                onChange={(e) => setGolden(e.target.checked)}
                className="mt-0.5 size-4 accent-primary"
              />
              <span>
                <span className="flex items-center gap-1.5 font-medium">
                  <Boxes className="size-3.5" />
                  Proposer comme type d&apos;application
                </span>
                <span className="block text-xs text-muted-foreground">
                  Le dossier ouvre le parcours de création : ses fichiers sont
                  cochés d&apos;office et ses réglages recopiés dans
                  l&apos;application.
                </span>
              </span>
            </label>

            {golden && (
              <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
                <p className="text-xs text-muted-foreground">
                  Recopiés dans l&apos;application à sa création. La modifier
                  ensuite ne retouche rien d&apos;existant.
                </p>

                <div className="space-y-1.5">
                  <Label htmlFor="gp_image" className="text-xs">
                    Image du runtime
                  </Label>
                  <Input
                    id="gp_image"
                    name="runtime_image"
                    value={image}
                    onChange={(e) => setImage(e.target.value)}
                    placeholder="node"
                    className="h-8 font-mono text-xs"
                  />
                  <p className="text-xs text-muted-foreground">
                    Ses tags publiés alimentent le choix de version.
                  </p>
                </div>

                <VersionFilter
                  folderId={folder?.id}
                  image={image}
                  value={versions}
                  onChange={setVersions}
                />

                <div className="grid gap-3 sm:grid-cols-2">
                  <Small label="Port écouté" name="default_port"
                    value={folder?.default_port} placeholder="3000" />
                  <Small label="Chemin de sonde" name="probe_path" text
                    value={folder?.probe_path} placeholder="/health" />
                  <Small label="Mémoire demandée" name="memory_request" text
                    value={folder?.memory_request} placeholder="256Mi" />
                  <Small label="Mémoire maximum" name="memory_limit" text
                    value={folder?.memory_limit} placeholder="512Mi" />
                </div>
              </div>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Annuler
              </Button>
              <SubmitButton
                label={folder ? "Enregistrer" : "Créer le dossier"}
                pendingLabel="Enregistrement…"
                icon={folder ? Save : FolderPlus}
              />
            </DialogFooter>
          </form>
          {/* Onglet fichiers : l'arborescence et le contenu, comme à
              l'aperçu de création. */}
          {folder && tab === "fichiers" && (
            <div className="flex min-h-0 flex-1 flex-col gap-3">
              <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">
                  Ce que ce type écrira dans le dépôt.{" "}
                  <code className="font-mono">{"{{app}}"}</code> et{" "}
                  <code className="font-mono">{"{{version}}"}</code> sont
                  substitués à la création.
                </p>
                <TemplateDialog
                  defaultFolderId={folder.id}
                  trigger={
                    <Button type="button" variant="outline" size="sm">
                      <Plus className="size-3.5" />
                      Ajouter un fichier
                    </Button>
                  }
                />
              </div>

              <FileWorkbench folderId={folder.id} templates={templates} />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Suppression d'un dossier ; ses modèles retournent à la racine. */
/**
 * Suppression d'un dossier ou d'un type.
 *
 * Le résultat était ignoré : un refus du serveur — droits manquants, dossier
 * déjà supprimé — ne produisait rien à l'écran, et le geste semblait sans
 * effet. Il est désormais affiché.
 */
export function DeleteFolderButton({ folder }: { folder: TemplateFolder }) {
  const [state, action] = useActionState<ActionState, FormData>(
    deleteFolderAction,
    null,
  );

  const what = folder.is_golden_path ? "le type" : "le dossier";
  const label = folder.is_golden_path
    ? "Supprimer le type"
    : "Supprimer le dossier";

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <form action={action} className="inline-flex">
        <input type="hidden" name="id" value={folder.id} />
        <SubmitButton
          label=""
          ariaLabel={label}
          variant="ghost"
          size="icon-sm"
          icon={Trash2}
          className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          confirm={
            folder.file_count > 0
              ? `Supprimer ${what} « ${folder.name} » ? Ses ${folder.file_count} fichier(s) reviennent aux fichiers libres, ils ne sont pas effacés.`
              : `Supprimer ${what} « ${folder.name} » ?`
          }
          confirmTitle={label}
          confirmLabel={label}
        />
      </form>

      {state && !state.ok && (
        <span className="text-xs text-destructive" role="alert">
          {state.message}
        </span>
      )}
    </span>
  );
}

/** Champ compact des réglages d'un type. */
function Small({
  label,
  name,
  value,
  placeholder,
  text = false,
}: {
  label: string;
  name: string;
  value?: string | number;
  placeholder: string;
  /** Les valeurs Kubernetes ('256Mi', '100m') ne sont pas numériques. */
  text?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={`gp_${name}`} className="text-xs">
        {label}
      </Label>
      <Input
        id={`gp_${name}`}
        name={name}
        type={text ? "text" : "number"}
        // 0 signifie « non renseigné » : l'afficher inviterait à le garder.
        defaultValue={value === 0 ? "" : (value ?? "")}
        placeholder={placeholder}
        className="h-8 font-mono text-xs"
      />
    </div>
  );
}
