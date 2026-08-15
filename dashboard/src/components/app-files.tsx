"use client";

import { useState, useTransition } from "react";
import { Check, Loader2, Upload, XCircle } from "lucide-react";

import { writeRepoFilesAction, type ActionState } from "@/app/actions";
import type { FileTemplate, TemplateFolder } from "@/lib/api";
import { FilesStep, buildFiles } from "@/components/files-step";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Écriture de fichiers dans le dépôt d'une application existante.
 *
 * Même liste que le parcours de création : ce qu'on choisit, c'est quels
 * fichiers écrire. Ils sont réécrits à chaque fois, ce qui permet de propager
 * un modèle mis à jour.
 */
export function AppFiles({
  repo,
  appId,
  appName,
  baseUrl,
  templates,
  folders,
}: {
  repo: string;
  appId: string;
  appName: string;
  baseUrl: string;
  templates: FileTemplate[];
  folders: TemplateFolder[];
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [state, setState] = useState<ActionState>(null);
  const [pending, startTransition] = useTransition();

  function write() {
    const { files, needsToken } = buildFiles(templates, selected, {
      app: appName,
      repo,
      env: "production",
      endpoint: `${baseUrl}/api/v1/apps/${appId}/deploy`,
    });

    const data = new FormData();
    data.set("repo", repo);
    data.set("files", JSON.stringify(files));
    data.set("needs_token", String(needsToken));
    data.set("app_name", appName);

    startTransition(async () => setState(await writeRepoFilesAction(null, data)));
  }

  return (
    <div className="flex flex-col gap-4">
      <FilesStep
        repo={repo}
        appId={appId}
        appName={appName}
        baseUrl={baseUrl}
        templates={templates}
        folders={folders}
        selected={selected}
        onChange={setSelected}
      />

      {templates.length > 0 && (
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending || selected.length === 0}
            onClick={write}
          >
            {pending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Upload className="size-3.5" />
            )}
            Écrire dans le dépôt
          </Button>
        </div>
      )}

      {state && (
        <p
          className={cn(
            "flex items-start gap-1.5 text-xs",
            state.ok ? "text-success" : "text-destructive",
          )}
          role="status"
        >
          {state.ok ? (
            <Check className="mt-0.5 size-3.5 shrink-0" />
          ) : (
            <XCircle className="mt-0.5 size-3.5 shrink-0" />
          )}
          {state.message}
        </p>
      )}
    </div>
  );
}
