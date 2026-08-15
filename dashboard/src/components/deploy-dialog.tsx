"use client";

import * as React from "react";
import { useActionState, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Container,
  Rocket,
  Settings2,
  Target,
  XCircle,
} from "lucide-react";

import { deployImageAction, type ActionState } from "@/app/actions";
import type { App } from "@/lib/api";
import { SubmitButton } from "@/components/forms";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
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
  { key: "image", label: "Image", icon: Container },
  { key: "cible", label: "Cible", icon: Target },
  { key: "config", label: "Configuration", icon: Settings2 },
] as const;

/** Déduit un nom d'application depuis une référence d'image. */
function appNameFromImage(image: string) {
  // "ghcr.io/org/mon-app:1.2" -> "mon-app" ; "nginx:alpine" -> "nginx"
  const withoutTag = image.split("@")[0].split(":")[0];
  return withoutTag.split("/").pop() ?? withoutTag;
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
 * Déploiement guidé en trois étapes.
 *
 * Le formulaire comptait huit champs dépliés en permanence : beaucoup ne
 * servent qu'aux cas avancés. Le découpage met en avant ce qui est toujours
 * requis (image, application, environnement) et relègue le reste.
 *
 * Toutes les étapes restent montées — masquées en CSS — pour que le FormData
 * soumis contienne l'ensemble des champs quelle que soit l'étape affichée.
 */
export function DeployDialog({
  apps,
  defaultAppId,
  defaultImage,
  defaultEnvironment,
  trigger,
  source = "dashboard",
}: {
  apps: App[];
  defaultAppId?: string;
  defaultImage?: string;
  defaultEnvironment?: string;
  trigger?: React.ReactNode;
  /** Origine du déclenchement, tracée sur la révision créée. */
  source?: string;
}) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [state, action] = useActionState<ActionState, FormData>(
    deployImageAction,
    null,
  );

  const defaultApp = apps.find((a) => a.id === defaultAppId);

  // Le nom se déduit de l'image tant que l'utilisateur ne l'a pas fixé : il
  // n'a plus qu'à confirmer dans le cas courant.
  const [image, setImage] = useState(defaultImage ?? "");
  const [name, setName] = useState(defaultApp?.name ?? "");
  const suggested = name || (image ? appNameFromImage(image) : "");
  const existing = apps.find((a) => a.name === suggested);

  // Un succès referme la modale : le tableau rafraîchi derrière montre la
  // nouvelle révision.
  const isOpen = open && !state?.ok;

  function close() {
    setOpen(false);
    setStep(0);
  }

  const canNext = step === 0 ? image.trim().length > 0 : true;

  return (
    <>
      {trigger ? (
        <span onClick={() => setOpen(true)}>{trigger}</span>
      ) : (
        <Button size="sm" onClick={() => setOpen(true)}>
          <Rocket className="size-3.5" />
          Déployer
        </Button>
      )}

      <Dialog
        open={isOpen}
        onOpenChange={(o) => (o ? setOpen(true) : close())}
      >
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Déployer une image</DialogTitle>
            <DialogDescription>
              L&apos;application est créée à la volée si elle n&apos;existe pas
              encore.
            </DialogDescription>
          </DialogHeader>

          {/* Fil d'étapes : situe l'avancement sans quitter la modale. */}
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
                      current ? "font-medium text-foreground" : "text-muted-foreground",
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

          <form action={action} className="flex flex-col gap-4">
            <input type="hidden" name="source" value={source} />
            {/* --- Étape 1 : l'image ------------------------------------- */}
            <div className={cn("flex flex-col gap-4", step !== 0 && "hidden")}>
              <Field
                label="Image du conteneur"
                htmlFor="image"
                hint="Image publique, ou privée si un registry est lié à cet environnement."
              >
                <Input
                  id="image"
                  name="image"
                  required
                  value={image}
                  onChange={(e) => setImage(e.target.value)}
                  placeholder="nginx:alpine"
                  className="font-mono"
                />
              </Field>

              {suggested && (
                <p className="rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
                  Application déduite :{" "}
                  <span className="font-mono text-foreground">{suggested}</span>
                  {existing ? " — elle existe déjà." : " — elle sera créée."}
                </p>
              )}
            </div>

            {/* --- Étape 2 : où déployer --------------------------------- */}
            <div className={cn("flex flex-col gap-4", step !== 1 && "hidden")}>
              <Field
                label="Application"
                htmlFor="app_name"
                hint="Créée automatiquement si elle n'existe pas."
              >
                <Input
                  id="app_name"
                  name="name"
                  required
                  list="existing-app-names"
                  value={name || suggested}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="billing-api"
                />
                <datalist id="existing-app-names">
                  {apps.map((a) => (
                    <option key={a.id} value={a.name} />
                  ))}
                </datalist>
              </Field>

              <Field label="Environnement" htmlFor="environment">
                <Input
                  id="environment"
                  name="environment"
                  list="env-suggestions"
                  defaultValue={defaultEnvironment ?? "staging"}
                />
                <datalist id="env-suggestions">
                  <option value="staging" />
                  <option value="prod" />
                  <option value="dev" />
                </datalist>
              </Field>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Port du conteneur" htmlFor="container_port">
                  <Input
                    id="container_port"
                    name="container_port"
                    type="number"
                    min={1}
                    max={65535}
                    defaultValue={
                      defaultApp?.container_port ?? existing?.container_port ?? 8080
                    }
                  />
                </Field>
                <Field label="Replicas" htmlFor="replicas">
                  <Input
                    id="replicas"
                    name="replicas"
                    type="number"
                    min={1}
                    defaultValue={1}
                  />
                </Field>
              </div>

              <Field
                label="Autres ports ouverts"
                htmlFor="extra_ports"
                hint="Séparés par une virgule, si l'image en ouvre plusieurs (métriques, API interne). Ils resteront joignables dans le cluster."
              >
                <Input
                  id="extra_ports"
                  name="extra_ports"
                  placeholder="7001, 9090"
                  className="font-mono"
                />
              </Field>

            </div>

            {/* --- Étape 3 : réglages optionnels ------------------------- */}
            <div className={cn("flex flex-col gap-4", step !== 2 && "hidden")}>
              <p className="text-xs text-muted-foreground">
                Tout est optionnel : vous pouvez déployer sans rien renseigner
                ici.
              </p>

              <Field
                label="Hostname public"
                htmlFor="host"
                hint="Laissez vide pour l'URL générée automatiquement."
              >
                <Input id="host" name="host" placeholder="demo.exemple.fr" />
              </Field>

              <Field
                label="Variables d'environnement"
                htmlFor="env"
                hint="Une par ligne, au format CLÉ=valeur."
              >
                <Textarea
                  id="env"
                  name="env"
                  rows={3}
                  placeholder={"LOG_LEVEL=info"}
                  className="font-mono"
                />
              </Field>

              <Field
                label="Variables sensibles"
                htmlFor="secrets"
                hint="Stockées chiffrées, injectées via un Secret Kubernetes."
              >
                <Textarea
                  id="secrets"
                  name="secrets"
                  rows={3}
                  placeholder={"DB_PASSWORD=…"}
                  className="font-mono"
                />
              </Field>

              {/* Récapitulatif : dernière chance de vérifier avant l'envoi. */}
              <div className="space-y-1.5 rounded-lg border border-border p-3 text-xs">
                <p className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="font-mono">
                    {image || "—"}
                  </Badge>
                  <ArrowRight className="size-3 text-muted-foreground" />
                  <span className="font-medium">{name || suggested || "—"}</span>
                </p>
                {!existing && suggested && (
                  <p className="text-muted-foreground">
                    L&apos;application « {suggested} » sera créée.
                  </p>
                )}
              </div>
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

            <DialogFooter>
              {step > 0 ? (
                <Button
                  type="button"
                  variant="outline"
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
                  disabled={!canNext}
                  onClick={() => setStep((s) => s + 1)}
                >
                  Continuer
                  <ArrowRight className="size-3.5" />
                </Button>
              ) : (
                <SubmitButton
                  label="Déployer"
                  pendingLabel="Envoi…"
                  icon={Rocket}
                />
              )}
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
