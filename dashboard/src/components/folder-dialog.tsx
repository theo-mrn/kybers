"use client";

import { useActionState, useState } from "react";
import { FolderPlus, Save, Trash2 } from "lucide-react";

import {
  saveFolderAction,
  deleteFolderAction,
  type ActionState,
} from "@/app/actions";
import type { TemplateFolder } from "@/lib/api";
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
  trigger,
}: {
  folder?: TemplateFolder;
  trigger?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
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
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {folder ? "Renommer le dossier" : "Nouveau dossier"}
            </DialogTitle>
            <DialogDescription>
              Un dossier regroupe les fichiers d&apos;un même usage et s&apos;ajoute
              en bloc à la création d&apos;une application.
            </DialogDescription>
          </DialogHeader>

          <form action={action} className="flex flex-col gap-4">
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
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Suppression d'un dossier ; ses modèles retournent à la racine. */
export function DeleteFolderButton({ folder }: { folder: TemplateFolder }) {
  const [, action] = useActionState<ActionState, FormData>(
    deleteFolderAction,
    null,
  );

  return (
    <form action={action} className="inline-flex">
      <input type="hidden" name="id" value={folder.id} />
      <SubmitButton
        label=""
        variant="ghost"
        size="sm"
        icon={Trash2}
        confirm={`Supprimer « ${folder.name} » ? Ses ${folder.file_count} modèle(s) reviennent à la racine, ils ne sont pas effacés.`}
        confirmTitle="Supprimer le dossier"
        confirmLabel="Supprimer le dossier"
      />
    </form>
  );
}
