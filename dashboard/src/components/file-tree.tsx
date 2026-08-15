"use client";

import * as React from "react";
import { useState } from "react";
import { ChevronRight, FileText, Folder, FolderOpen } from "lucide-react";

import { cn } from "@/lib/utils";
import { highlight } from "@/lib/highlight";
import { dirname } from "@/lib/repo-path";

/** Élément affichable dans l'arborescence : un chemin et de quoi l'identifier. */
export type TreeEntry = { id: string; path: string };

/** Nœud d'arborescence, reconstruit à partir des chemins. */
export type TreeNode<T extends TreeEntry> = {
  name: string;
  /** Chemin du segment, unique dans l'arbre. */
  key: string;
  entry?: T;
  children: TreeNode<T>[];
};

/**
 * Reconstruit une arborescence à partir de chemins plats.
 *
 * Les modèles portent un chemin complet — `.github/workflows/deploy.yml` — mais
 * ce qu'on veut montrer, c'est le dépôt tel qu'il sera. Les dossiers n'existent
 * donc que déduits des segments.
 *
 * Deux entrées peuvent viser le même chemin : dans la bibliothèque de modèles,
 * deux dossiers proposent chacun leur `README.md`. Les feuilles sont donc
 * clefées sur l'identifiant, pas sur le chemin, faute de quoi l'une écraserait
 * l'autre à l'affichage.
 */
export function buildTree<T extends TreeEntry>(entries: T[]): TreeNode<T>[] {
  const root: TreeNode<T> = { name: "", key: "", children: [] };

  for (const entry of entries) {
    const parts = entry.path.split("/").filter(Boolean);
    if (parts.length === 0) continue;
    let node = root;

    parts.forEach((part, i) => {
      const isLeaf = i === parts.length - 1;
      const path = parts.slice(0, i + 1).join("/");

      if (isLeaf) {
        node.children.push({
          name: part,
          key: `${path}::${entry.id}`,
          entry,
          children: [],
        });
        return;
      }

      let child = node.children.find((c) => c.name === part && !c.entry);
      if (!child) {
        child = { name: part, key: path, children: [] };
        node.children.push(child);
      }
      node = child;
    });
  }

  // Dossiers d'abord, puis alphabétique : l'ordre d'un explorateur de fichiers.
  const sort = (nodes: TreeNode<T>[]): TreeNode<T>[] =>
    nodes
      .map((n) => ({ ...n, children: sort(n.children) }))
      .sort((a, b) => {
        const aDir = !a.entry;
        const bDir = !b.entry;
        if (aDir !== bDir) return aDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

  return sort(root.children);
}

/** Une ligne d'arborescence : dossier repliable ou fichier sélectionnable. */
export function TreeRow<T extends TreeEntry>({
  node,
  depth,
  selectedId,
  onSelect,
  /** Décoration optionnelle d'une feuille : icône et teinte. */
  decorate,
  /** Déplacement par glisser-déposer ; absent = arbre en lecture seule. */
  onMove,
  dragging,
  onDragChange,
  dragRef,
}: {
  node: TreeNode<T>;
  depth: number;
  selectedId: string | null;
  onSelect: (entry: T) => void;
  decorate?: (entry: T) => { icon?: React.ReactNode; className?: string };
  onMove?: (entry: T, dir: string) => void;
  /** Entrée en cours de déplacement, partagée par tout l'arbre. */
  dragging?: T | null;
  onDragChange?: (entry: T | null) => void;
  /**
   * Entrée saisie, lisible sans attendre un rendu.
   *
   * L'état React est publié après le tick — le poser pendant `dragstart`
   * annule le geste — mais les zones de dépôt doivent savoir immédiatement ce
   * qu'elles reçoivent, y compris si le curseur les atteint avant.
   */
  dragRef?: React.RefObject<T | null>;
}) {
  // Les dossiers sont ouverts d'emblée : replier masquerait ce qu'on vient
  // consulter, et les arbres restent petits.
  const [open, setOpen] = useState(true);
  const [over, setOver] = useState(false);
  const indent = { paddingLeft: `${depth * 12 + 8}px` };

  if (node.entry) {
    const entry = node.entry;
    const active = selectedId === entry.id;
    const deco = decorate?.(entry);

    const draggable = Boolean(onMove);
    return (
      <button
        type="button"
        onClick={() => onSelect(entry)}
        style={indent}
        draggable={draggable}
        onDragStart={(e) => {
          // `move` donne le bon curseur ; la donnée n'est pas lue au drop, le
          // survol d'un autre onglet ne doit pas pouvoir déclencher un
          // déplacement.
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", entry.path);
          // L'état est publié après le tick : le poser pendant `dragstart`
          // re-rend l'arbre, l'élément saisi est remplacé et le navigateur
          // annule le geste — ce qui ne se voyait que sur les feuilles
          // imbriquées, dont le parent se re-rend aussi.
          const picked = entry;
          if (dragRef) dragRef.current = picked;
          setTimeout(() => onDragChange?.(picked), 0);
        }}
        // `drop` s'exécute avant `dragend` : le déplacement a donc déjà lu
        // `dragging` quand on le remet à zéro ici.
        onDragEnd={() => {
          if (dragRef) dragRef.current = null;
          onDragChange?.(null);
        }}
        className={cn(
          "flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-sm transition-colors",
          active
            ? "bg-primary/10 text-primary"
            : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
          !active && deco?.className,
          draggable && "cursor-grab active:cursor-grabbing",
          dragging?.id === entry.id && "opacity-40",
        )}
      >
        {deco?.icon ?? <FileText className="size-3.5 shrink-0" />}
        <span className="truncate">{node.name}</span>
      </button>
    );
  }

  /**
   * Entrée saisie au moment de l'événement.
   *
   * Lue dans les gestionnaires et non pendant le rendu : la ref est à jour dès
   * `dragstart`, l'état seulement au rendu suivant, et un dépôt rapide
   * arriverait avant lui.
   */
  const heldNow = () => dragRef?.current ?? dragging ?? null;

  /** Un dossier ne peut pas recevoir le fichier qu'il contient déjà. */
  const accepts = (held: T | null) =>
    Boolean(onMove) && Boolean(held) && dirname(held!.path) !== node.key;

  /**
   * La zone de dépôt englobe le dossier *et* son contenu.
   *
   * Le bouton du dossier ne couvre que son libellé, ses enfants étant rendus
   * en frères : viser cette seule ligne en remontant depuis un sous-dossier
   * était quasi impossible. Le survol d'un enfant compte donc pour le parent,
   * et `stopPropagation` laisse le nœud le plus profond l'emporter.
   */
  return (
    <div
      onDragOver={(e) => {
        if (!accepts(heldNow())) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        setOver(true);
      }}
      onDragLeave={(e) => {
        // `dragleave` se déclenche aussi en passant sur un enfant : ne réagir
        // qu'en quittant réellement la zone.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setOver(false);
      }}
      onDrop={(e) => {
        const held = heldNow();
        if (!accepts(held)) return;
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        onMove!(held!, node.key);
        if (dragRef) dragRef.current = null;
        onDragChange?.(null);
      }}
      className={cn(
        "rounded-md transition-colors",
        over && "bg-primary/10 ring-1 ring-primary/40",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={indent}
        className={cn(
          "flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-sm transition-colors",
          over
            ? "text-primary"
            : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
        )}
      >
        <ChevronRight
          className={cn(
            "size-3 shrink-0 transition-transform",
            open && "rotate-90",
          )}
        />
        {open ? (
          <FolderOpen className="size-3.5 shrink-0" />
        ) : (
          <Folder className="size-3.5 shrink-0" />
        )}
        <span className="truncate">{node.name}</span>
      </button>

      {open &&
        node.children.map((child) => (
          <TreeRow
            key={child.key}
            node={child}
            depth={depth + 1}
            selectedId={selectedId}
            onSelect={onSelect}
            decorate={decorate}
            onMove={onMove}
            dragging={dragging}
            onDragChange={onDragChange}
            dragRef={dragRef}
          />
        ))}
    </div>
  );
}

/** Contenu colorisé, avec gouttière de numéros de ligne. */
export function CodeBlock({
  code,
  language,
}: {
  code: string;
  language: string;
}) {
  const lines = code.split("\n");

  return (
    <div className="flex min-w-0 font-mono text-xs leading-[1.6]">
      <div
        aria-hidden
        className="shrink-0 border-r border-border bg-muted/40 py-2 text-right select-none"
      >
        {lines.map((_, i) => (
          <div key={i} className="px-2 text-muted-foreground/60 tabular">
            {i + 1}
          </div>
        ))}
      </div>
      <pre className="min-w-0 flex-1 overflow-x-auto px-3 py-2 whitespace-pre">
        <code>
          {lines.map((line, i) => (
            <div key={i}>
              {highlight(line, language).map((tok, j) => (
                <span key={j} className={tok.className}>
                  {tok.text}
                </span>
              ))}
              {line === "" && " "}
            </div>
          ))}
        </code>
      </pre>
    </div>
  );
}
