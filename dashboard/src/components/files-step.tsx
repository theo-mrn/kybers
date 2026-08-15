"use client";

import * as React from "react";
import { FileCode, TriangleAlert } from "lucide-react";

import type { FileTemplate, TemplateFolder } from "@/lib/api";
import { FilePicker } from "@/components/file-picker";

/**
 * Applique les substitutions d'un modèle.
 *
 * Elles portent sur le chemin comme sur le contenu : un modèle peut viser
 * `.github/workflows/{{app}}.yml`.
 */
export function render(
  text: string,
  vars: { app: string; repo: string; env: string; endpoint: string },
) {
  return text
    .replaceAll("{{app}}", vars.app)
    .replaceAll("{{repo}}", vars.repo)
    .replaceAll("{{env}}", vars.env)
    .replaceAll("{{endpoint}}", vars.endpoint);
}

/**
 * Choix des fichiers à créer dans le dépôt.
 *
 * L'étape ne montre que ce qui a été retenu ; le choix lui-même se fait dans
 * un navigateur dédié, où l'on parcourt les dossiers de modèles. Une liste à
 * plat devenait illisible dès qu'une organisation dépassait quelques modèles.
 */
export function FilesStep({
  repo,
  appId,
  appName,
  baseUrl,
  templates,
  folders = [],
  selected,
  onChange,
}: {
  repo: string;
  appId: string;
  appName: string;
  baseUrl: string;
  templates: FileTemplate[];
  folders?: TemplateFolder[];
  /** Identifiants retenus, portés par le parent qui déclenche l'écriture. */
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  if (!repo) {
    return (
      <p className="flex items-start gap-2 rounded-md border border-border bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
        Aucun dépôt rattaché : les fichiers pourront être créés plus tard,
        depuis l&apos;application.
      </p>
    );
  }

  if (templates.length === 0) {
    return (
      <p className="flex items-start gap-2 rounded-md border border-border bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
        <FileCode className="mt-0.5 size-3.5 shrink-0" />
        Aucun modèle dans votre organisation. Créez-en dans{" "}
        <strong className="text-foreground">Modèles</strong> pour qu&apos;ils
        soient proposés ici.
      </p>
    );
  }

  const vars = {
    app: appName,
    repo,
    env: "production",
    endpoint: `${baseUrl}/api/v1/apps/${appId}/deploy`,
  };

  return (
    <div className="flex flex-col gap-3">
      <FilePicker
        templates={templates}
        folders={folders}
        selected={selected}
        onChange={onChange}
        renderPath={(p) => render(p, vars)}
        renderContent={(c) => render(c, vars)}
      />

      {selected.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Écrits dans{" "}
          <span className="font-mono text-foreground">{repo}</span> à la
          validation. Modifiables ensuite depuis l&apos;application.
        </p>
      )}
    </div>
  );
}

/** Prépare la charge utile : contenus substitués, jeton si un workflow est là. */
export function buildFiles(
  templates: FileTemplate[],
  selected: string[],
  vars: { app: string; repo: string; env: string; endpoint: string },
) {
  const chosen = templates.filter((t) => selected.includes(t.id));
  return {
    files: chosen.map((t) => ({
      path: render(t.path, vars),
      content: render(t.content, vars),
    })),
    // Seul un workflow a besoin du jeton : le créer sans raison encombrerait
    // la liste des jetons.
    needsToken: chosen.some((t) => t.kind === "pipeline"),
  };
}
