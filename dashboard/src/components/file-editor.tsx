"use client";

import * as React from "react";
import { useRef, useState } from "react";
import { Check, Copy, WrapText } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Éditeur de fichier texte.
 *
 * Un `<textarea>` nu ne suffit pas pour du YAML : sans numéros de ligne ni
 * tabulation, on perd le fil dès la vingtième. Les numéros sont rendus dans
 * une gouttière synchronisée au défilement, plutôt que par une bibliothèque
 * de coloration qui pèserait bien plus que le besoin.
 *
 * Par défaut l'éditeur remplit la hauteur que son parent lui donne : c'est le
 * contenu qui compte, pas les champs autour. `minRows` ne s'applique qu'aux
 * usages en flux, où aucune hauteur n'est imposée.
 */
export function FileEditor({
  value,
  onChange,
  readOnly = false,
  language,
  minRows,
  placeholders,
  className,
}: {
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  /** Affiché en étiquette ; purement indicatif. */
  language?: string;
  /** Hauteur minimale en lignes, pour un éditeur non contraint par son parent. */
  minRows?: number;
  /** Jetons insérables au curseur, ex. `{{app}}`. */
  placeholders?: string[];
  className?: string;
}) {
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const [wrap, setWrap] = useState(false);
  const [copied, setCopied] = useState(false);

  const lines = value.split("\n");

  // La gouttière suit le défilement de la zone de saisie : sans cela, les
  // numéros se décalent dès qu'on descend.
  function syncScroll() {
    if (gutterRef.current && areaRef.current) {
      gutterRef.current.scrollTop = areaRef.current.scrollTop;
    }
  }

  /** Remplace la sélection et replace le curseur derrière l'insertion. */
  function insert(text: string) {
    const el = areaRef.current;
    if (!el || readOnly || !onChange) return;

    const { selectionStart: start, selectionEnd: end } = el;
    onChange(value.slice(0, start) + text + value.slice(end));

    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = start + text.length;
    });
  }

  /** Tab insère une indentation plutôt que de quitter le champ. */
  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== "Tab" || readOnly || !onChange) return;
    e.preventDefault();
    insert("  ");
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Presse-papiers refusé : le texte reste sélectionnable à la main.
    }
  }

  return (
    <div
      className={cn(
        "flex flex-col overflow-hidden rounded-lg border border-border bg-muted/30",
        className,
      )}
    >
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-1.5">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {language && (
            <Badge variant="outline" className="font-mono">
              {language}
            </Badge>
          )}
          <span className="tabular">
            {lines.length} ligne{lines.length > 1 ? "s" : ""}
          </span>
          {readOnly && <Badge variant="outline">lecture seule</Badge>}
        </div>

        <div className="flex items-center gap-1">
          {/* Les substitutions s'insèrent au curseur : les lister ailleurs
              obligeait à les recopier à la main. */}
          {!readOnly &&
            placeholders?.map((p) => (
              <Button
                key={p}
                type="button"
                variant="ghost"
                size="xs"
                title={`Insérer ${p}`}
                onClick={() => insert(p)}
                className="font-mono text-xs text-muted-foreground"
              >
                {p}
              </Button>
            ))}

          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Retour à la ligne automatique"
            aria-pressed={wrap}
            title="Retour à la ligne"
            onClick={() => setWrap((w) => !w)}
            className={wrap ? "text-primary" : undefined}
          >
            <WrapText className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Copier"
            title="Copier"
            onClick={copy}
          >
            {copied ? (
              <Check className="size-3.5 text-success" />
            ) : (
              <Copy className="size-3.5" />
            )}
          </Button>
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1 font-mono text-xs leading-[1.6]">
        <div
          ref={gutterRef}
          aria-hidden
          className="shrink-0 overflow-hidden border-r border-border bg-muted/40 py-2 text-right select-none"
        >
          {lines.map((_, i) => (
            <div key={i} className="px-2 text-muted-foreground/60 tabular">
              {i + 1}
            </div>
          ))}
        </div>

        <textarea
          ref={areaRef}
          value={value}
          onChange={(e) => onChange?.(e.target.value)}
          onScroll={syncScroll}
          onKeyDown={onKeyDown}
          readOnly={readOnly}
          rows={minRows}
          spellCheck={false}
          wrap={wrap ? "soft" : "off"}
          className={cn(
            "min-h-0 flex-1 resize-none bg-transparent px-3 py-2 leading-[1.6] outline-none",
            // `off` autorise le défilement horizontal, nécessaire pour du YAML
            // ou des commandes longues.
            wrap ? "whitespace-pre-wrap" : "overflow-x-auto whitespace-pre",
            readOnly && "text-muted-foreground",
          )}
        />
      </div>
    </div>
  );
}
