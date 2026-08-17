"use client";

import * as React from "react";
import { useEffect, useMemo, useState, useTransition } from "react";
import {
  ArrowLeft,
  Boxes,
  Check,
  ChevronDown,
  CircleDot,
  Cpu,
  Download,
  FileCode,
  Hexagon,
  Loader2,
  Network,
  Pencil,
  SquareCode,
  Timer,
} from "lucide-react";

import type {
  BuiltinGoldenPath,
  RuntimeVersion,
  TemplateFolder,
} from "@/lib/api";
import {
  installGoldenPathAction,
  listRuntimeVersionsAction,
} from "@/app/actions";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Icônes disponibles pour un type.
 *
 * Le dossier ne porte qu'une clé : un composant React ne traverse pas la
 * frontière serveur/client.
 */
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
 * Choix du type d'application, puis de sa version.
 *
 * Deux décisions, deux écrans : afficher les versions de tous les types en même
 * temps noyait le choix principal sous des boutons sans rapport. On choisit un
 * langage, puis on précise sa version — dans cet ordre, parce que c'est celui
 * dans lequel on décide.
 *
 * Les réglages sont recopiés dans l'application, qui les possède ensuite :
 * faire évoluer un type ne retouche donc rien d'existant.
 */
export function GoldenPathStep({
  paths,
  builtin = [],
  selected,
  onChange,
  version,
  onVersionChange,
  onInstalled,
}: {
  /** Dossiers marqués comme types, fournis par l'organisation. */
  paths: TemplateFolder[];
  /** Types fournis avec Kybers, installables sans quitter le parcours. */
  builtin?: BuiltinGoldenPath[];
  /** Identifiant retenu ; `null` = partir de zéro. */
  selected: string | null;
  onChange: (id: string | null) => void;
  /** Version du runtime retenue, substituée dans les fichiers du type. */
  version: string;
  onVersionChange: (v: string) => void;
  /** Averti après installation : la liste des modèles doit être rechargée. */
  onInstalled?: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // Un préfait déjà repris sous le même nom n'est plus proposé : il figure
  // parmi les types de l'organisation, avec ses éventuelles modifications.
  const names = new Set(paths.map((p) => p.name));
  const offers = builtin.filter((b) => !names.has(b.folder.name));

  const current = paths.find((p) => p.id === selected);
  const versions = current ? split(current.versions) : [];

  /**
   * Installe un préfait puis le retient.
   *
   * L'installer depuis le parcours évite d'avoir à l'abandonner pour aller le
   * chercher dans Modèles ; il appartient ensuite à l'organisation.
   */
  function install(key: string) {
    setBusy(key);
    setError(null);
    startTransition(async () => {
      const res = await installGoldenPathAction(key);
      setBusy(null);
      if (!res?.ok) {
        setError(res?.message ?? "Échec de l'installation.");
        return;
      }
      onInstalled?.();
    });
  }

  // --- Écran 2 : la version du type retenu --------------------------------
  if (current && versions.length > 0) {
    const Icon = ICONS[current.icon] ?? Boxes;

    return (
      <div className="flex flex-col gap-4">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => onChange(null)}
          className="self-start"
        >
          <ArrowLeft className="size-3.5" />
          Changer de type
        </Button>

        <div className="flex items-center gap-2 rounded-lg border border-primary/50 bg-primary/5 p-3">
          <Icon className="size-4 shrink-0 text-primary" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {current.name}
          </span>
          <Badge variant="outline">
            {current.file_count} fichier{current.file_count > 1 ? "s" : ""}
          </Badge>
        </div>

        <VersionPicker
          folderId={current.id}
          fallback={versions}
          recommended={current.default_version}
          value={version}
          onChange={onVersionChange}
        />
      </div>
    );
  }

  // --- Écran 1 : le type ---------------------------------------------------
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-2 sm:grid-cols-2">
        {paths.map((p) => {
          const Icon = ICONS[p.icon] ?? Boxes;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => onChange(p.id)}
              className="flex flex-col gap-2 rounded-lg border border-border p-3 text-left transition-colors hover:border-primary/40 hover:bg-muted/60"
            >
              <span className="flex items-center gap-2 text-sm font-medium">
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                {p.name}
                <Badge variant="outline" className="ml-auto">
                  {p.file_count} fichier{p.file_count > 1 ? "s" : ""}
                </Badge>
              </span>

              {p.description && (
                <span className="text-xs text-muted-foreground">
                  {p.description}
                </span>
              )}

              <Traits folder={p} />
            </button>
          );
        })}

        {/* Préfaits Kybers : installables sans quitter le parcours. */}
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
                  {b.files.length} fichier{b.files.length > 1 ? "s" : ""}
                </Badge>
              </span>

              {b.folder.description && (
                <span className="text-xs text-muted-foreground">
                  {b.folder.description}
                </span>
              )}

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
                Installer ce type
              </Button>
            </div>
          );
        })}

        {/* Toujours proposé : un service qui ne rentre dans aucune case ne doit
            pas obliger à défaire un préréglage. */}
        <button
          type="button"
          onClick={() => onChange(null)}
          className="flex flex-col gap-2 rounded-lg border border-border p-3 text-left transition-colors hover:border-primary/40 hover:bg-muted/60"
        >
          <span className="flex items-center gap-2 text-sm font-medium">
            <Pencil className="size-4 shrink-0 text-muted-foreground" />
            Partir de zéro
          </span>
          <span className="text-xs text-muted-foreground">
            Aucun préréglage. Vous choisirez les fichiers vous-même à
            l&apos;étape suivante.
          </span>
        </button>
      </div>

      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}

      {paths.length === 0 && offers.length === 0 && (
        <p className="flex items-start gap-2 rounded-md border border-border bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
          <FileCode className="mt-0.5 size-3.5 shrink-0" />
          Aucun type disponible. Créez-en un depuis{" "}
          <strong className="text-foreground">Modèles</strong>.
        </p>
      )}
    </div>
  );
}


/**
 * Sélecteur de version, alimenté par les tags publiés.
 *
 * Un dropdown plutôt que des boutons : une image publie des dizaines de
 * versions exploitables, et figer trois choix interdit de viser un correctif
 * précis. La recherche filtre la liste, les majeures sont regroupées.
 *
 * Les versions figées du dossier servent de repli tant que le registre n'a pas
 * répondu — ou s'il ne répond pas : un sélecteur vide bloquerait le parcours.
 */
function VersionPicker({
  folderId,
  fallback,
  recommended,
  value,
  onChange,
}: {
  folderId: string;
  /** Versions du dossier, affichées avant et à défaut de réponse. */
  fallback: string[];
  recommended: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [remote, setRemote] = useState<RuntimeVersion[] | null>(null);
  const [source, setSource] = useState("");
  const [loading, setLoading] = useState(true);
  // Lus dans l'effet de chargement sans en être des dépendances : les y mettre
  // relancerait l'appel au registre à chaque changement de version.
  const latest = React.useRef({ value, onChange });
  useEffect(() => {
    latest.current = { value, onChange };
  });

  // Le registre n'est interrogé qu'à la sélection du type : le faire au
  // chargement de la page coûterait un appel réseau souvent inutile.
  useEffect(() => {
    let alive = true;

    // L'état ne bouge qu'après le rendu : le poser en début d'effet déclenche
    // une seconde passe immédiate, que React signale à juste titre.
    (async () => {
      const res = await listRuntimeVersionsAction(folderId);
      if (!alive) return;
      setRemote(res.versions);
      setSource(res.source);
      setLoading(false);

      // Sans version retenue — ou si celle du type ne figure plus parmi les
      // branches autorisées — on prend la première proposée.
      const { value: current, onChange: pick } = latest.current;
      if (res.versions.length > 0 && !res.versions.some((v) => v.name === current)) {
        pick(res.versions[0].name);
      }
    })();

    return () => {
      alive = false;
    };
  }, [folderId]);

  const all = useMemo<RuntimeVersion[]>(
    () =>
      remote && remote.length > 0
        ? remote
        : fallback.map((name) => ({
            name,
            major: Number(name.split(".")[0]) || 0,
            minor: 0,
            patch: 0,
            floating: !name.includes("."),
          })),
    [remote, fallback],
  );

  const shown = useMemo(() => {
    const needle = q.trim();
    if (!needle) return all;
    return all.filter((v) => v.name.startsWith(needle));
  }, [all, q]);

  // Fermer au clic extérieur : sans cela, le menu resterait ouvert par-dessus
  // le reste de l'étape.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [open]);

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium">Version</p>

      <div
        className="relative"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className={cn(
            "flex w-full items-center gap-2 rounded-lg border border-border px-3 py-2 text-left text-sm transition-colors hover:bg-muted/60",
            open && "border-ring ring-[3px] ring-ring/40",
          )}
        >
          <span className="min-w-0 flex-1 font-mono">
            {value || "Choisir une version"}
          </span>
          {value === recommended && value !== "" && (
            <Badge variant="outline">recommandée</Badge>
          )}
          {loading ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
          ) : (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          )}
        </button>

        {open && (
          <div className="absolute z-50 mt-1 flex max-h-96 w-full flex-col overflow-hidden rounded-lg border border-border bg-popover shadow-lg">
            <div className="shrink-0 border-b border-border p-2">
              <Input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Filtrer : 22, 3.12…"
                className="h-9 font-mono"
              />
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-1">
              {shown.length === 0 ? (
                <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                  Aucune version ne commence par « {q} ».
                </p>
              ) : (
                shown.map((v) => (
                  <button
                    key={v.name}
                    type="button"
                    onClick={() => {
                      onChange(v.name);
                      setOpen(false);
                      setQ("");
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors",
                      value === v.name
                        ? "bg-primary/10 text-primary"
                        : "hover:bg-muted",
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate font-mono">
                      {v.name}
                    </span>
                    {v.name === recommended && (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        recommandée
                      </span>
                    )}
                    {v.floating && v.name !== recommended && (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        suit les correctifs
                      </span>
                    )}
                    {value === v.name && (
                      <Check className="size-3.5 shrink-0" />
                    )}
                  </button>
                ))
              )}
            </div>
          </div>
        )}
      </div>

      {/* Une liste figée n'a pas la fraîcheur d'un relevé du registre : le
          signaler évite de croire l'inventaire complet. */}
      {!loading && (source === "liste figée" || source === "registre injoignable") && (
        <p className="text-xs text-muted-foreground">Liste de repli.</p>
      )}
    </div>
  );
}

/** Ce qu'un type prérègle, en une ligne. */
function Traits({ folder: p }: { folder: TemplateFolder }) {
  const versions = split(p.versions);

  return (
    <span className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {versions.length > 0 && (
        <span className="flex items-center gap-1">
          <Boxes className="size-3" />
          {versions.length} version{versions.length > 1 ? "s" : ""}
        </span>
      )}
      {p.default_port > 0 && (
        <span className="flex items-center gap-1">
          <Network className="size-3" />
          port {p.default_port}
        </span>
      )}
      {p.memory_request && (
        <span className="flex items-center gap-1">
          <Cpu className="size-3" />
          {p.memory_request}
        </span>
      )}
      {p.probe_path && (
        <span className="flex items-center gap-1">
          <Timer className="size-3" />
          <span className="font-mono">{p.probe_path}</span>
        </span>
      )}
    </span>
  );
}

/** Réglages qu'un type applique à l'application créée. */
export type GoldenPathPreset = {
  folderId: string;
  containerPort: number;
  /** Versions proposées ; vide si le type n'est pas versionné. */
  versions: string[];
  defaultVersion: string;
};

/** Extrait ce qui sera recopié dans l'application. */
export function presetOf(
  paths: TemplateFolder[],
  id: string | null,
): GoldenPathPreset | null {
  const p = paths.find((x) => x.id === id);
  if (!p) return null;
  return {
    folderId: p.id,
    containerPort: p.default_port,
    versions: split(p.versions),
    defaultVersion: p.default_version,
  };
}
