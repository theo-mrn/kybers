"use client";

import * as React from "react";
import { useState, useTransition } from "react";
import {
  Boxes,
  ChevronRight,
  CircleDot,
  Cpu,
  Download,
  FileCode,
  Hexagon,
  Loader2,
  Network,
  Plus,
  SquareCode,
  Timer,
  XCircle,
} from "lucide-react";

import type {
  BuiltinGoldenPath,
  FileTemplate,
  TemplateFolder,
} from "@/lib/api";
import { installGoldenPathAction, type ActionState } from "@/app/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FolderDialog, DeleteFolderButton } from "@/components/folder-dialog";
import { TemplateDialog, EditTemplateButton } from "@/components/template-dialog";
import { DeleteTemplateButton } from "@/components/delete-template-button";
import { cn } from "@/lib/utils";

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  hexagon: Hexagon,
  "circle-dot": CircleDot,
  "square-code": SquareCode,
  boxes: Boxes,
};

const split = (csv: string) =>
  csv
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

/**
 * Types d'application de l'organisation.
 *
 * Un type porte ses fichiers : ils ne vivent pas parmi les fichiers libres, où
 * un `server.js` isolé n'aurait aucun sens. On les lit et on les corrige donc
 * ici, sous le type qui les produit.
 */
export function GoldenPathsPanel({
  paths,
  builtin,
  templates = [],
}: {
  /** Types de l'organisation, déjà installés. */
  paths: TemplateFolder[];
  /** Types fournis avec Kybers, installables. */
  builtin: BuiltinGoldenPath[];
  /** Fichiers appartenant aux types, à répartir entre eux. */
  templates?: FileTemplate[];
}) {
  const [state, setState] = useState<ActionState>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // Un préfait déjà installé n'est plus proposé : il figure au-dessus, avec
  // les modifications de l'équipe.
  const installed = new Set(paths.map((p) => p.name));
  const offers = builtin.filter((b) => !installed.has(b.folder.name));

  function install(key: string) {
    setBusy(key);
    setState(null);
    startTransition(async () => {
      const res = await installGoldenPathAction(key);
      setState(res);
      setBusy(null);
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            Proposés en tête du parcours de création. Leurs réglages sont
            recopiés dans l&apos;application, jamais imposés après coup.
          </p>
          <FolderDialog />
        </div>

        {paths.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            Aucun type. Installez-en un ci-dessous, ou créez-en un.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {paths.map((p) => (
              <PathCard
                key={p.id}
                folder={p}
                files={templates.filter((t) => t.folder_id === p.id)}
              />
            ))}
          </div>
        )}
      </section>

      {offers.length > 0 && (
        <section className="flex flex-col gap-3">
          <div>
            <h2 className="text-sm font-medium">Fournis avec Kybers</h2>
            <p className="text-xs text-muted-foreground">
              Serveur minimal, Dockerfile et pipeline prêts à démarrer.
              Modifiables une fois installés.
            </p>
          </div>

          {state && !state.ok && (
            <p
              className="flex items-start gap-1.5 text-xs text-destructive"
              role="alert"
            >
              <XCircle className="mt-0.5 size-3.5 shrink-0" />
              {state.message}
            </p>
          )}

          <div className="grid gap-2 sm:grid-cols-2">
            {offers.map((b) => {
              const Icon = ICONS[b.folder.icon] ?? Boxes;
              return (
                <div
                  key={b.key}
                  className="flex flex-col gap-2 rounded-lg border border-dashed border-border bg-muted/20 p-3"
                >
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <Icon className="size-4 shrink-0 text-muted-foreground" />
                    {b.folder.name}
                    <Badge variant="outline" className="ml-auto">
                      {b.files.length} fichiers
                    </Badge>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {b.folder.description}
                  </span>
                  <Traits folder={b.folder} />
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    disabled={busy !== null}
                    onClick={() => install(b.key)}
                    className="self-start"
                  >
                    {busy === b.key ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <Download className="size-3" />
                    )}
                    Installer
                  </Button>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

/** Un type et les fichiers qu'il produit. */
function PathCard({
  folder: p,
  files,
}: {
  folder: TemplateFolder;
  files: FileTemplate[];
}) {
  const [open, setOpen] = useState(false);
  const Icon = ICONS[p.icon] ?? Boxes;

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="flex flex-wrap items-center gap-2 p-3">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ChevronRight
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
          <Icon className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{p.name}</span>
            {p.description && (
              <span className="block truncate text-xs text-muted-foreground">
                {p.description}
              </span>
            )}
          </span>
        </button>

        <Badge variant="outline" className="shrink-0">
          <FileCode className="size-3" />
          {files.length}
        </Badge>

        <FolderDialog
          folder={p}
          templates={files}
          trigger={
            <Button variant="ghost" size="xs">
              Configurer
            </Button>
          }
        />
        <DeleteFolderButton folder={p} />
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border bg-muted/20 px-3 py-2">
        <Traits folder={p} />
      </div>

      {open && (
        <div className="flex flex-col gap-1 border-t border-border p-3">
          {files.length === 0 ? (
            <p className="py-2 text-center text-xs text-muted-foreground">
              Aucun fichier — ce type produirait un dépôt vide.
            </p>
          ) : (
            files.map((t) => (
              <div
                key={t.id}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/60"
              >
                <FileCode className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-mono text-xs">
                  {t.path}
                </span>
                <EditTemplateButton template={t} />
                <DeleteTemplateButton template={t} />
              </div>
            ))
          )}

          <TemplateDialog
            defaultFolderId={p.id}
            trigger={
              <Button variant="ghost" size="xs" className="mt-1 self-start">
                <Plus className="size-3" />
                Ajouter un fichier
              </Button>
            }
          />
        </div>
      )}
    </div>
  );
}

/** Ce qu'un type prérègle, en une ligne. */
function Traits({ folder: p }: { folder: TemplateFolder }) {
  const versions = split(p.versions);

  return (
    <>
      {p.runtime_image && (
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <Boxes className="size-3" />
          <span className="font-mono">{p.runtime_image}</span>
          {versions.length > 0 ? (
            <span>
              · {versions.length === 1 ? "branche" : "branches"}{" "}
              {versions.join(", ")}
            </span>
          ) : (
            <span>· toutes versions</span>
          )}
        </span>
      )}
      {p.default_port > 0 && (
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <Network className="size-3" />
          port {p.default_port}
        </span>
      )}
      {p.memory_request && (
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <Cpu className="size-3" />
          {p.memory_request}
        </span>
      )}
      {p.probe_path && (
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <Timer className="size-3" />
          <span className="font-mono">{p.probe_path}</span>
        </span>
      )}
    </>
  );
}
