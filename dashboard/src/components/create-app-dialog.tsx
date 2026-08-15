"use client";

import * as React from "react";
import { useActionState, useState } from "react";
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
  Eye,
  Tag,
  XCircle,
} from "lucide-react";

import { createAppAction, type ActionState } from "@/app/actions";
import type { FileTemplate, TemplateFolder, GitStatus } from "@/lib/api";
import { GitStep } from "@/components/git-step";
import { FilesStep, buildFiles } from "@/components/files-step";
import { FilePreview } from "@/components/file-preview";
import { findCollisions } from "@/lib/repo-path";
import { writeRepoFilesAction } from "@/app/actions";
import { SubmitButton } from "@/components/forms";
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
  { key: "identite", label: "Identité", icon: Tag },
  { key: "depot", label: "Dépôt Git", icon: GitBranch },
  { key: "fichiers", label: "Fichiers", icon: FileCode },
  { key: "apercu", label: "Aperçu", icon: Eye },
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
}: {
  /** État de l'intégration : conditionne ce que l'étape « dépôt » propose. */
  gitStatus: GitStatus;
  /** URL publique appelée par le workflow depuis le CI. */
  baseUrl: string;
  /** Modèles de l'organisation, proposés avant ceux de Kybers. */
  templates?: FileTemplate[];
  folders?: TemplateFolder[];
}) {
  const [open, setOpen] = useState(false);
  const [rawStep, setStep] = useState(0);
  const [name, setName] = useState("");
  const router = useRouter();

  const [state, action] = useActionState<ActionState, FormData>(
    createAppAction,
    null,
  );

  // L'application est créée à l'étape 2. Son identifiant figure dans l'URL
  // qu'appellera le workflow : l'étape « pipeline » ne peut donc s'afficher
  // qu'ensuite, avec cet identifiant en main.
  const createdId = state?.ok ? state.id : undefined;
  const [repo, setRepo] = React.useState("");
  const [running, setRunning] = React.useState(false);
  const [filesState, setFilesState] = React.useState<ActionState>(null);

  // Les modèles marqués par défaut sont cochés d'emblée : c'est la convention
  // de l'équipe, on la suit sauf décision contraire.
  const [files, setFiles] = React.useState<string[]>(() =>
    templates.filter((t) => t.is_default).map((t) => t.id),
  );


  // L'application créée, seule l'étape « pipeline » a du sens : la déduire
  // évite un rendu en cascade.
  const step = createdId && rawStep < 2 ? 2 : rawStep;

  const slug = sanitizeName(name);

  // Ce que l'aperçu montre est exactement ce qui sera écrit : même appel,
  // mêmes substitutions. Les faire diverger tromperait sur le résultat.
  const payload = React.useMemo(
    () =>
      buildFiles(templates, files, {
        app: slug,
        repo,
        env: "production",
        endpoint: `${baseUrl}/api/v1/apps/${createdId ?? ""}/deploy`,
      }),
    [templates, files, slug, repo, baseUrl, createdId],
  );

  // Deux fichiers visant le même chemin ne produiraient qu'un seul fichier :
  // mieux vaut bloquer que d'écrire un résultat que personne n'a choisi.
  const collisions = React.useMemo(
    () => findCollisions(payload.files),
    [payload.files],
  );

  async function finish() {
    // Rien de coché : on ferme sans appeler l'API.
    if (createdId && repo && files.length > 0) {
      const data = new FormData();
      data.set("repo", repo);
      data.set("files", JSON.stringify(payload.files));
      data.set("needs_token", String(payload.needsToken));
      data.set("app_name", slug);

      setRunning(true);
      try {
        const res = await writeRepoFilesAction(null, data);
        setFilesState(res);
        // Un échec laisse sur place : les fichiers écrits le restent, et le
        // message dit lesquels reprendre.
        if (!res?.ok) return;
      } finally {
        setRunning(false);
      }
    }

    setOpen(false);
    setStep(0);
    // La navigation rafraîchit la liste : l'action de création s'en abstient
    // pour ne pas détruire le parcours en cours.
    if (createdId) router.push(`/apps/${createdId}`);
    else router.refresh();
  }

  const canNext = step === 0 ? slug.length > 0 : true;

  function close() {
    setOpen(false);
    setStep(0);
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
            step === 3
              ? "h-[88vh] max-h-[88vh] sm:max-w-5xl"
              : "max-h-[85vh] sm:max-w-2xl",
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

          <form
            action={action}
            className="flex min-h-0 flex-1 flex-col gap-4"
          >
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
            {/* --- 1. Identité ------------------------------------------- */}
            <div className={cn("flex flex-col gap-4", step !== 0 && "hidden")}>
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
            <div className={cn("flex flex-col gap-4", step !== 1 && "hidden")}>
              <GitStep status={gitStatus} appName={slug} onResolved={setRepo} />
            </div>

            {/* Le port réel dépend de l'image, encore inconnue à ce stade :
                une valeur par défaut suffit, ajustable ensuite. */}
            <input type="hidden" name="container_port" value="8080" />

            {step === 1 && (
              <p className="flex items-start gap-2 rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
                <Info className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  L&apos;application est créée à cette étape : le workflow de la
                  suivante référence son identifiant.
                </span>
              </p>
            )}

            {/* --- 3. Fichiers ------------------------------------------- */}
            <div className={cn("flex flex-col gap-4", step !== 2 && "hidden")}>
              {createdId ? (
                <>
                  <p className="flex items-center gap-2 rounded-md border border-success/30 bg-success/5 px-3 py-2 text-xs text-success">
                    <Check className="size-3.5 shrink-0" />
                    Application <strong className="font-medium">{slug}</strong>{" "}
                    créée.
                  </p>

                  <FilesStep
                    repo={repo}
                    appId={createdId}
                    appName={slug}
                    baseUrl={baseUrl}
                    templates={templates}
                    folders={folders}
                    selected={files}
                    onChange={setFiles}
                  />

                  {filesState && !filesState.ok && (
                    <p
                      className="flex items-start gap-1.5 text-xs text-destructive"
                      role="alert"
                    >
                      <XCircle className="mt-0.5 size-3.5 shrink-0" />
                      {filesState.message}
                    </p>
                  )}
                </>
              ) : (
                <p className="text-xs text-muted-foreground">
                  L&apos;application sera créée à l&apos;étape précédente.
                </p>
              )}
            </div>

            {/* --- 4. Aperçu --------------------------------------------- */}
            <div
              className={cn(
                "flex min-h-0 flex-1 flex-col gap-3",
                step !== 3 && "hidden",
              )}
            >
              <p className="shrink-0 text-xs text-muted-foreground">
                Ce que Kybers écrira dans{" "}
                <span className="font-mono text-foreground">{repo}</span>,
                substitutions appliquées.
              </p>

              <FilePreview files={payload.files} className="min-h-96 flex-1" />

              {payload.needsToken && (
                <p className="flex shrink-0 items-start gap-2 rounded-md border border-border bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
                  <Info className="mt-0.5 size-3.5 shrink-0" />
                  Un workflow est inclus : un jeton de déploiement sera créé et
                  ajouté aux secrets du dépôt. Votre jeton GitHub doit porter le
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
              {/* Une fois l'application créée, revenir en arrière n'a plus de
                  sens : elle existe. */}
              {/* Revenir sur l'identité ou le dépôt n'a plus de sens une fois
                  l'application créée, mais revoir sa sélection de fichiers, si. */}
              {(step > 0 && !createdId) || step === 3 ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setStep((s) => s - 1)}
                >
                  <ArrowLeft className="size-3.5" />
                  Retour
                </Button>
              ) : (
                !createdId && (
                  <Button type="button" variant="outline" onClick={close}>
                    Annuler
                  </Button>
                )
              )}

              {/* Le bouton final écrit les fichiers cochés : aucune action
                  intermédiaire à déclencher soi-même. */}
              {createdId && step === 2 && files.length > 0 ? (
                // Rien n'est écrit avant l'aperçu : on valide ce qu'on a vu.
                <Button type="button" onClick={() => setStep(3)}>
                  Voir l&apos;aperçu
                  <ArrowRight className="size-3.5" />
                </Button>
              ) : createdId ? (
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
                  ) : null}
                  {files.length > 0
                    ? `Créer ${files.length} fichier${files.length > 1 ? "s" : ""}`
                    : "Terminer"}
                  <ArrowRight className="size-3.5" />
                </Button>
              ) : step === 0 ? (
                <Button
                  type="button"
                  disabled={!canNext}
                  onClick={() => setStep(1)}
                >
                  Continuer
                  <ArrowRight className="size-3.5" />
                </Button>
              ) : (
                <SubmitButton
                  label="Créer et continuer"
                  pendingLabel="Création…"
                  icon={ArrowRight}
                />
              )}
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
