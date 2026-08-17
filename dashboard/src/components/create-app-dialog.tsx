"use client";

import * as React from "react";
import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  GitBranch,
  Info,
  Loader2,
  Plus,
  FileCode,
  Variable,
  Boxes,
  Tag,
  XCircle,
} from "lucide-react";

import { createAppBundleAction, type ActionState } from "@/app/actions";
import type {
  BuiltinGoldenPath,
  FileTemplate,
  TemplateFolder,
  GitStatus,
} from "@/lib/api";
import { GitStep } from "@/components/git-step";
import { buildFiles, render } from "@/components/files-step";
import { FilePicker } from "@/components/file-picker";
import { FilePreview } from "@/components/file-preview";
import type { CustomFile } from "@/components/custom-file-dialog";
import { EnvStep, splitEnv, type EnvEntry } from "@/components/env-step";
import { GoldenPathStep, presetOf } from "@/components/golden-path-step";
import { findCollisions } from "@/lib/repo-path";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const STEPS = [
  { key: "type", label: "Type", icon: Boxes },
  { key: "identite", label: "Identité", icon: Tag },
  { key: "depot", label: "Dépôt Git", icon: GitBranch },
  { key: "config", label: "Configuration", icon: Variable },
  { key: "fichiers", label: "Fichiers", icon: FileCode },
] as const;

/** Nom Kubernetes valide : il devient le préfixe des namespaces. */
function sanitizeName(v: string) {
  return v
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+/, "")
    .slice(0, 40);
}

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/**
 * Création guidée d'une application.
 *
 * Une application n'est pas un déploiement : c'est le service lui-même, son
 * dépôt et sa forme d'exécution. Les déploiements viennent après, dans ses
 * environnements — d'où ce parcours qui ne demande aucune image.
 *
 * Les étapes restent montées, masquées en CSS : le FormData soumis doit porter
 * tous les champs quelle que soit l'étape affichée.
 */
export function CreateAppDialog({
  gitStatus,
  baseUrl,
  templates = [],
  folders = [],
  builtinPaths = [],
}: {
  /** État de l'intégration : conditionne ce que l'étape « dépôt » propose. */
  gitStatus: GitStatus;
  /** URL publique appelée par le workflow depuis le CI. */
  baseUrl: string;
  /** Modèles de l'organisation, proposés avant ceux de Kybers. */
  templates?: FileTemplate[];
  folders?: TemplateFolder[];
  /** Types fournis avec Kybers, installables depuis le parcours. */
  builtinPaths?: BuiltinGoldenPath[];
}) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [repo, setRepo] = React.useState("");
  const [createRepo, setCreateRepo] = React.useState<{
    owner: string;
    name: string;
    private: boolean;
  } | null>(null);
  const [running, setRunning] = React.useState(false);
  // Vérification du dépôt, déclenchée par « Continuer » : l'étape n'a pas de
  // bouton propre, résoudre le dépôt fait partie du fait de la quitter.
  const probeGit = React.useRef<(() => Promise<boolean>) | null>(null);
  const [checking, setChecking] = React.useState(false);
  // Stable : une lambda inline relancerait l'effet de GitStep à chaque rendu.
  const registerProbe = React.useCallback((fn: () => Promise<boolean>) => {
    probeGit.current = fn;
  }, []);
  const [state, setState] = React.useState<ActionState>(null);
  const router = useRouter();

  // Les modèles marqués par défaut sont cochés d'emblée : c'est la convention
  // de l'équipe, on la suit sauf décision contraire.
  // Vide au départ : c'est le type choisi qui garnit la sélection.
  const [files, setFiles] = React.useState<string[]>([]);
  // Fichiers saisis pour cette application seulement : ils ne rejoignent pas
  // la bibliothèque de modèles.
  const [custom, setCustom] = React.useState<CustomFile[]>([]);
  const [pathId, setPathId] = React.useState<string | null>(null);
  const [env, setEnv] = React.useState<EnvEntry[]>([]);
  const [version, setVersion] = React.useState("");

  // Les dossiers marqués comme types : les autres restent de simples
  // regroupements, sans vocation à ouvrir un parcours.
  const goldenPaths = React.useMemo(
    () => folders.filter((f) => f.is_golden_path),
    [folders],
  );

  /**
   * Retient un type et coche ses fichiers.
   *
   * La sélection précédente est remplacée, pas complétée : changer d'avis sur
   * le type ne doit pas laisser traîner le Dockerfile du précédent.
   */
  function pickPath(id: string | null) {
    setPathId(id);
    // Le sélecteur retient la première version proposée dès qu'il a répondu :
    // la version par défaut n'est plus saisie à la main, elle se déduit de ce
    // que le registre publie sous les branches autorisées.
    setVersion(folders.find((f) => f.id === id)?.default_version ?? "");
    setFiles(
      id ? templates.filter((t) => t.folder_id === id).map((t) => t.id) : [],
    );
  }

  const slug = sanitizeName(name);

  // `{{endpoint}}` reste tel quel : il porte l'identifiant de l'application,
  // qui n'existera qu'au moment de l'écriture. Le serveur le substituera.
  const payload = React.useMemo(
    () =>
      buildFiles(templates, files, {
        app: slug,
        repo,
        env: "production",
        endpoint: "{{endpoint}}",
        version,
      }, custom),
    [templates, files, slug, repo, custom, version],
  );

  const vars = React.useMemo(
    () => ({
      app: slug,
      repo,
      env: "production",
      // Substitué côté serveur : l'identifiant n'existe pas encore.
      endpoint: "{{endpoint}}",
      version,
    }),
    [slug, repo, version],
  );

  // Deux fichiers visant le même chemin ne produiraient qu'un seul fichier :
  // mieux vaut bloquer que d'écrire un résultat que personne n'a choisi.
  const collisions = React.useMemo(
    () => findCollisions(payload.files),
    [payload.files],
  );

  const preset = React.useMemo(
    () => presetOf(goldenPaths, pathId),
    [goldenPaths, pathId],
  );

  /**
   * Joue tout le parcours en une fois.
   *
   * Dépôt, application et fichiers naissent ensemble : abandonner avant cette
   * validation ne laisse rien derrière soi.
   */
  async function finish() {
    setRunning(true);
    setState(null);
    try {
      const res = await createAppBundleAction({
        name: slug,
        // Le type sait quel port son écosystème écoute — 3000 pour Node,
        // 8000 pour Python. Sans type, une valeur par défaut ajustable.
        containerPort: preset?.containerPort || 8080,
        extraPorts: [],
        repo,
        createRepo: createRepo
          ? { ...createRepo, description: "" }
          : undefined,
        files: payload.files,
        needsToken: payload.needsToken,
        baseUrl,
        envVars: splitEnv(env).vars,
        secrets: splitEnv(env).secrets,
      });

      setState(res);
      if (!res?.ok) return;

      setOpen(false);
      setStep(0);
      if (res.id) router.push(`/apps/${res.id}`);
      else router.refresh();
    } finally {
      setRunning(false);
    }
  }

  // Une version doit être retenue avant de quitter l'étape du type : sans
  // elle, les fichiers partiraient avec un `{{version}}` non substitué.
  const canNext =
    step === 0
      ? pathId === null || version !== ""
      : step === 1
        ? slug.length > 0
        : true;

  /** Referme et remet le parcours à zéro : rien n'a été écrit. */
  function close() {
    setOpen(false);
    setStep(0);
    setState(null);
    // Le parcours abandonné ne doit rien laisser au suivant.
    setCustom([]);
    setPathId(null);
    setVersion("");
    setEnv([]);
    setFiles([]);
  }

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="size-3.5" />
        Nouvelle application
      </Button>

      <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
        <DialogContent
          className={cn(
            "flex flex-col",
            // L'aperçu affiche deux panneaux : il lui faut de la largeur et une
            // hauteur bornée, sinon l'arborescence et le code s'effondrent.
            // L'aperçu affiche deux panneaux, le choix du type une grille de
            // cartes : les deux étouffaient dans une modale étroite.
            step === 4
              ? "h-[88vh] max-h-[88vh] sm:max-w-5xl"
              : "h-[85vh] max-h-[85vh] sm:max-w-3xl",
          )}
        >
          <DialogHeader>
            <DialogTitle>Nouvelle application</DialogTitle>
            <DialogDescription>
              Déclarez le service. Ses environnements et ses déploiements
              viendront ensuite.
            </DialogDescription>
          </DialogHeader>

          <ol className="flex items-center gap-2">
            {STEPS.map((s, i) => {
              const done = i < step;
              const current = i === step;
              return (
                <li key={s.key} className="flex flex-1 items-center gap-2">
                  <span
                    className={cn(
                      "flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium transition-colors",
                      done && "border-primary bg-primary text-primary-foreground",
                      current && "border-primary text-primary",
                      !done && !current && "border-border text-muted-foreground",
                    )}
                  >
                    {done ? <Check className="size-3" /> : i + 1}
                  </span>
                  <span
                    className={cn(
                      "truncate text-xs",
                      current
                        ? "font-medium text-foreground"
                        : "text-muted-foreground",
                    )}
                  >
                    {s.label}
                  </span>
                  {i < STEPS.length - 1 && (
                    <span className="h-px flex-1 bg-border" aria-hidden />
                  )}
                </li>
              );
            })}
          </ol>

          <Separator />

          <div className="flex min-h-0 flex-1 flex-col gap-4">
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
            {/* --- 0. Type ----------------------------------------------- */}
            <div className={cn("flex flex-col gap-4", step !== 0 && "hidden")}>
              <GoldenPathStep
                paths={goldenPaths}
                builtin={builtinPaths}
                selected={pathId}
                onChange={pickPath}
                version={version}
                onVersionChange={setVersion}
                // La liste vient du serveur : sans rechargement, le type
                // installé n'apparaîtrait qu'à la prochaine visite.
                onInstalled={() => router.refresh()}
              />
            </div>

            {/* --- 1. Identité ------------------------------------------- */}
            <div className={cn("flex flex-col gap-4", step !== 1 && "hidden")}>
              <Field
                label="Nom de l'application"
                htmlFor="app_name"
                hint="Il préfixe les namespaces Kubernetes et ne pourra plus changer."
              >
                <Input
                  id="app_name"
                  name="name"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="billing-api"
                />
              </Field>

              {name && slug !== name && (
                <p className="rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
                  Enregistrée sous{" "}
                  <span className="font-mono text-foreground">{slug}</span> —
                  seuls les minuscules, chiffres et tirets sont acceptés.
                </p>
              )}

              {slug && (
                <p className="flex items-start gap-2 rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
                  <Info className="mt-0.5 size-3.5 shrink-0" />
                  Chaque environnement deviendra un namespace{" "}
                  <span className="font-mono text-foreground">
                    {slug}-&lt;env&gt;
                  </span>
                  .
                </p>
              )}
            </div>

            {/* --- 2. Dépôt ---------------------------------------------- */}
            <div className={cn("flex flex-col gap-4", step !== 2 && "hidden")}>
              <GitStep
                status={gitStatus}
                appName={slug}
                onResolved={setRepo}
                onCreateRequest={setCreateRepo}
                onReady={registerProbe}
              />
            </div>

            {step === 2 && (
              <p className="flex items-start gap-2 rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
                <Info className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  L&apos;application est créée à cette étape : le workflow de la
                  suivante référence son identifiant.
                </span>
              </p>
            )}

            {/* --- 3. Fichiers ------------------------------------------- */}
            {/* --- 3. Configuration -------------------------------------- */}
            <div className={cn("flex flex-col gap-4", step !== 3 && "hidden")}>
              <EnvStep entries={env} onChange={setEnv} repo={repo} />
            </div>

            {/* --- 4. Fichiers et aperçu --------------------------------- */}
            <div
              className={cn(
                "flex min-h-0 flex-1 flex-col gap-3",
                step !== 4 && "hidden",
              )}
            >
              {/* Les fichiers du type sont là d'emblée : on les lit, et on en
                  ajoute au même endroit plutôt que dans une étape séparée. */}
              <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">
                  Écrits dans{" "}
                  <span className="font-mono text-foreground">
                    {repo || "le dépôt"}
                  </span>{" "}
                  à la validation.
                </p>

                <FilePicker
                  templates={templates}
                  folders={folders}
                  selected={files}
                  onChange={setFiles}
                  renderPath={(pt) => render(pt, vars)}
                  renderContent={(c) => render(c, vars)}
                  custom={custom}
                  onCustomChange={setCustom}
                  compact
                />
              </div>

              <FilePreview files={payload.files} className="min-h-0 flex-1" />

              {payload.needsToken && (
                <p className="flex shrink-0 items-start gap-2 rounded-md border border-border bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
                  <Info className="mt-0.5 size-3.5 shrink-0" />
                  Un workflow est inclus : votre jeton GitHub doit porter le
                  scope <code className="font-mono">workflow</code>.
                </p>
              )}
            </div>

            {state && !state.ok && (
              <p
                className="flex items-center gap-1.5 text-sm text-destructive"
                role="alert"
              >
                <XCircle className="size-3.5 shrink-0" />
                {state.message}
              </p>
            )}

            </div>

            <DialogFooter className="shrink-0 border-t border-border pt-4">
              {/* Rien n'est écrit avant la validation finale : revenir en
                  arrière est sans conséquence à toutes les étapes. */}
              {step > 0 ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={running}
                  onClick={() => setStep((s) => s - 1)}
                >
                  <ArrowLeft className="size-3.5" />
                  Retour
                </Button>
              ) : (
                <Button type="button" variant="outline" onClick={close}>
                  Annuler
                </Button>
              )}

              {step < STEPS.length - 1 ? (
                <Button
                  type="button"
                  disabled={!canNext || checking}
                  onClick={async () => {
                    // L'étape « dépôt » ne se quitte qu'une fois la référence
                    // résolue : un dépôt introuvable laisse sur place, avec le
                    // message d'erreur affiché par l'étape.
                    if (step === 2 && probeGit.current) {
                      setChecking(true);
                      const ok = await probeGit.current().finally(() =>
                        setChecking(false),
                      );
                      if (!ok) return;
                    }
                    setStep((s) => s + 1);
                  }}
                >
                  {checking ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : null}
                  {checking ? "Vérification…" : "Continuer"}
                  {!checking && <ArrowRight className="size-3.5" />}
                </Button>
              ) : (
                <Button
                  type="button"
                  disabled={running || collisions.length > 0}
                  title={
                    collisions.length > 0
                      ? "Deux fichiers visent le même chemin."
                      : undefined
                  }
                  onClick={finish}
                >
                  {running ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Check className="size-3.5" />
                  )}
                  {running ? "Création…" : "Créer l'application"}
                </Button>
              )}
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
