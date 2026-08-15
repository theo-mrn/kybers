"use client";

import * as React from "react";
import { useMemo, useState } from "react";
import {
  Check,
  Copy,
  FileCode,
  TriangleAlert,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { languageOf } from "@/lib/highlight";
import { findCollisions, normalizePath } from "@/lib/repo-path";
import { buildTree, CodeBlock, TreeRow } from "@/components/file-tree";

export type PreviewFile = { path: string; content: string };

/**
 * Aperçu des fichiers qui seront écrits dans le dépôt.
 *
 * Avant de valider, on veut voir ce que Kybers va réellement pousser : les
 * substitutions sont déjà appliquées, aux chemins comme aux contenus. La
 * lecture se fait dans une arborescence redimensionnable, parce qu'un chemin
 * long et un fichier large ne tiennent pas dans la même largeur figée.
 */
export function FilePreview({
  files,
  className,
}: {
  files: PreviewFile[];
  className?: string;
}) {
  // Deux fichiers visant le même chemin n'en produisent qu'un : `PutFile` est
  // un upsert, le dernier écrit gagne sans que rien ne le signale.
  const collisions = useMemo(() => findCollisions(files), [files]);
  const conflicting = useMemo(
    () => new Set(collisions.map((c) => c.path)),
    [collisions],
  );
  const [picked, setPicked] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const entries = useMemo(
    () => files.map((f) => ({ ...f, id: f.path })),
    [files],
  );
  const tree = useMemo(() => buildTree(entries), [entries]);

  // La sélection est dérivée, pas stockée : si le fichier choisi disparaît de
  // la sélection amont, on retombe sur le premier sans effet de bord.
  const current = files.find((f) => f.path === picked) ?? files[0];
  const selected = current?.path ?? null;

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

  if (files.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
        Aucun fichier sélectionné — le dépôt sera créé tel quel.
      </p>
    );
  }

  return (
    <div className={cn("flex min-h-0 flex-col gap-2", className)}>
      {collisions.length > 0 && (
        <div
          role="alert"
          className="shrink-0 space-y-1 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs"
        >
          <p className="flex items-center gap-1.5 font-medium text-destructive">
            <TriangleAlert className="size-3.5 shrink-0" />
            {collisions.length} chemin{collisions.length > 1 ? "s" : ""} en
            conflit
          </p>
          {collisions.map((c) => (
            <p key={c.path} className="text-muted-foreground">
              <span className="font-mono text-foreground">{c.path}</span> est
              visé par {c.names.join(", ")} — un seul survivrait.
            </p>
          ))}
          <p className="text-muted-foreground">
            Retirez-en un, ou changez son chemin dans les modèles.
          </p>
        </div>
      )}

      <ResizablePanelGroup
        orientation="horizontal"
        className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border"
      >
        <ResizablePanel defaultSize="32%" minSize="18%" maxSize="55%">
          <div className="flex h-full min-h-0 flex-col bg-muted/20">
            <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2 text-xs text-muted-foreground">
              <FileCode className="size-3.5" />
              {files.length} fichier{files.length > 1 ? "s" : ""}
            </div>
            <ScrollArea className="min-h-0 flex-1">
              <div className="p-2">
                  {tree.map((node) => (
                    <TreeRow
                      key={node.key}
                      node={node}
                      depth={0}
                      selectedId={selected}
                      onSelect={(e) => setPicked(e.path)}
                      decorate={(e) =>
                        conflicting.has(normalizePath(e.path))
                          ? {
                              icon: (
                                <TriangleAlert className="size-3.5 shrink-0 text-destructive" />
                              ),
                              className: "text-destructive",
                            }
                          : {}
                      }
                    />
                  ))}
              </div>
            </ScrollArea>
          </div>
        </ResizablePanel>

        <ResizableHandle withHandle />

        <ResizablePanel defaultSize="68%" minSize="40%">
          {current && (
            <div className="flex h-full min-h-0 flex-col">
              <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-1.5">
                <div className="flex min-w-0 items-center gap-2">
                  <Badge variant="outline" className="font-mono">
                    {languageOf(current.path)}
                  </Badge>
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {current.path}
                  </span>
                </div>
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
              </div>

              <ScrollArea className="min-h-0 flex-1">
                <CodeBlock
                  code={current.content}
                  language={languageOf(current.path)}
                />
              </ScrollArea>
            </div>
          )}
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
