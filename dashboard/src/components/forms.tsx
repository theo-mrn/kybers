"use client";

import * as React from "react";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import {
  createAppAction,
  deployImageAction,
  lifecycleAction,
  saveVarsAction,
  createRegistryAction,
  deleteRegistryAction,
  type ActionState,
} from "@/app/actions";
import type { App } from "@/lib/api";
import {
  CheckCircle2,
  Loader2,
  Play,
  RotateCcw,
  Rocket,
  Square,
  Trash2,
  XCircle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export function SubmitButton({
  label,
  pendingLabel,
  className,
  confirm,
  confirmTitle,
  confirmLabel,
  variant = "default",
  size = "default",
  icon: Icon,
  disabled,
}: {
  label: string;
  pendingLabel?: string;
  className?: string;
  /** Question posée avant de soumettre ; ouvre une modale de confirmation. */
  confirm?: string;
  confirmTitle?: string;
  confirmLabel?: string;
  variant?: "default" | "outline" | "secondary" | "ghost" | "destructive";
  size?: "default" | "sm" | "xs" | "lg";
  icon?: React.ComponentType<{ className?: string }>;
  /** Bloque la soumission tant qu'une condition n'est pas remplie. */
  disabled?: boolean;
}) {
  // useFormStatus lit l'état du <form> parent : le bouton se désactive
  // automatiquement pendant l'exécution de la Server Action.
  const { pending } = useFormStatus();
  const [asking, setAsking] = React.useState(false);
  const ref = React.useRef<HTMLButtonElement>(null);

  const button = (
    <Button
      ref={ref}
      type="submit"
      disabled={pending || disabled}
      variant={variant}
      size={size}
      className={className}
      onClick={(e) => {
        // La confirmation passe par une modale : `window.confirm` bloque le
        // navigateur et ne peut ni être stylé ni détailler la portée du geste.
        if (confirm && !asking) {
          e.preventDefault();
          setAsking(true);
        }
      }}
    >
      {pending ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : Icon ? (
        <Icon className="size-3.5" />
      ) : null}
      {pending ? (pendingLabel ?? "…") : label}
    </Button>
  );

  if (!confirm) return button;

  return (
    <>
      {button}

      <Dialog open={asking} onOpenChange={setAsking}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{confirmTitle ?? "Confirmer"}</DialogTitle>
            <DialogDescription>{confirm}</DialogDescription>
          </DialogHeader>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setAsking(false)}
            >
              Annuler
            </Button>
            <Button
              type="button"
              variant={variant === "default" ? "default" : variant}
              onClick={() => {
                // La modale se ferme d'abord : le clic suivant sur le bouton
                // d'origine traverse, `asking` étant retombé à faux.
                setAsking(false);
                // Le formulaire est soumis via le bouton réel pour que
                // `useFormStatus` et la Server Action restent branchés.
                requestAnimationFrame(() => ref.current?.click());
              }}
            >
              {Icon ? <Icon className="size-3.5" /> : null}
              {confirmLabel ?? label}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function Feedback({ state }: { state: ActionState }) {
  if (!state) return null;
  return (
    <p
      className={cn(
        "flex items-center gap-1.5 text-sm",
        state.ok ? "text-success" : "text-destructive",
      )}
      role="status"
      aria-live="polite"
    >
      {state.ok ? (
        <CheckCircle2 className="size-3.5 shrink-0" />
      ) : (
        <XCircle className="size-3.5 shrink-0" />
      )}
      {state.message}
    </p>
  );
}

/** Champ de formulaire : libellé, contrôle et aide, espacés uniformément. */
function FormField({
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

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------

export function CreateAppForm() {
  const [state, action] = useActionState<ActionState, FormData>(createAppAction, null);

  return (
    <form action={action} className="flex flex-col gap-4">
      <FormField label="Nom de l'application" htmlFor="name">
        <Input id="name" name="name" required placeholder="billing-api" />
      </FormField>

      <FormField label="Dépôt Git (optionnel)" htmlFor="git_repo">
        <Input
          id="git_repo"
          name="git_repo"
          placeholder="https://github.com/org/billing-api"
        />
      </FormField>

      <FormField label="Port du conteneur" htmlFor="container_port">
        <Input
          id="container_port"
          name="container_port"
          type="number"
          defaultValue={8080}
        />
      </FormField>

      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton label="Créer l'application" pendingLabel="Création…" />
        <Feedback state={state} />
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Déploiement
// ---------------------------------------------------------------------------

export function DeployForm({
  apps,
  defaultAppId,
  defaultImage,
  defaultEnvironment,
}: {
  apps: App[];
  defaultAppId?: string;
  defaultImage?: string;
  defaultEnvironment?: string;
}) {
  // deployImageAction crée l'application si elle n'existe pas : aucune étape
  // préalable n'est nécessaire pour déployer une image.
  const [state, action] = useActionState<ActionState, FormData>(deployImageAction, null);

  const defaultApp = apps.find((a) => a.id === defaultAppId);

  return (
    <form action={action} className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          label="Application"
          htmlFor="app_name"
          hint="Créée automatiquement si elle n'existe pas."
        >
          <Input
            id="app_name"
            name="name"
            required
            list="existing-app-names"
            defaultValue={defaultApp?.name}
            placeholder="billing-api"
          />
          <datalist id="existing-app-names">
            {apps.map((a) => (
              <option key={a.id} value={a.name} />
            ))}
          </datalist>
        </FormField>

        <FormField label="Environnement" htmlFor="environment">
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
        </FormField>
      </div>

      <FormField
        label="Image du conteneur"
        htmlFor="image"
        hint="Image publique, ou privée si un registry est lié à cet environnement."
      >
        <Input
          id="image"
          name="image"
          required
          placeholder="nginx:alpine"
          defaultValue={defaultImage ?? "nginx:alpine"}
          className="font-mono"
        />
      </FormField>

      <div className="grid gap-4 sm:grid-cols-3">
        <FormField label="Port du conteneur" htmlFor="container_port">
          <Input
            id="container_port"
            name="container_port"
            type="number"
            min={1}
            max={65535}
            defaultValue={defaultApp?.container_port ?? 8080}
          />
        </FormField>

        <FormField label="Replicas" htmlFor="replicas">
          <Input id="replicas" name="replicas" type="number" min={1} defaultValue={1} />
        </FormField>

        <FormField label="Hostname public (optionnel)" htmlFor="host">
          <Input id="host" name="host" placeholder="demo.exemple.fr" />
        </FormField>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Variables d'environnement" htmlFor="env">
          <Textarea
            id="env"
            name="env"
            rows={3}
            placeholder={"LOG_LEVEL=info"}
            className="font-mono"
          />
        </FormField>

        <FormField
          label="Variables sensibles"
          htmlFor="secrets"
          hint="Stockées chiffrées, en Secret K8s."
        >
          <Textarea
            id="secrets"
            name="secrets"
            rows={3}
            placeholder={"DB_PASSWORD=…"}
            className="font-mono"
          />
        </FormField>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton label="Déployer" pendingLabel="Envoi…" icon={Rocket} />
        <Feedback state={state} />
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Cycle de vie
// ---------------------------------------------------------------------------

/** Barre d'actions d'un déploiement : scale, stop/start, restart, suppression. */
export function LifecycleBar({
  deploymentId,
  replicas,
  stopped,
}: {
  deploymentId: string;
  replicas: number;
  stopped: boolean;
}) {
  const [state, action] = useActionState<ActionState, FormData>(lifecycleAction, null);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <form action={action} className="flex items-center gap-2">
          <input type="hidden" name="deployment_id" value={deploymentId} />
          <input type="hidden" name="action" value="scale" />
          <Input
            name="replicas"
            type="number"
            min={0}
            defaultValue={replicas}
            aria-label="Replicas"
            className="h-8 w-20"
          />
          <SubmitButton label="Scale" pendingLabel="…" variant="outline" size="sm" />
        </form>

        {stopped ? (
          <form action={action}>
            <input type="hidden" name="deployment_id" value={deploymentId} />
            <input type="hidden" name="action" value="start" />
            <input type="hidden" name="replicas" value={Math.max(replicas, 1)} />
            <SubmitButton
              label="Démarrer"
              pendingLabel="…"
              variant="outline"
              size="sm"
              icon={Play}
            />
          </form>
        ) : (
          <form action={action}>
            <input type="hidden" name="deployment_id" value={deploymentId} />
            <input type="hidden" name="action" value="stop" />
            <SubmitButton
              label="Arrêter"
              pendingLabel="…"
              variant="outline"
              size="sm"
              icon={Square}
            />
          </form>
        )}

        <form action={action}>
          <input type="hidden" name="deployment_id" value={deploymentId} />
          <input type="hidden" name="action" value="restart" />
          <SubmitButton
            label="Redémarrer"
            pendingLabel="…"
            variant="outline"
            size="sm"
            icon={RotateCcw}
          />
        </form>

        {/* Actions destructrices : séparées visuellement du reste. */}
        <span className="mx-1 h-5 w-px bg-border" aria-hidden />

        <form action={action}>
          <input type="hidden" name="deployment_id" value={deploymentId} />
          <input type="hidden" name="action" value="delete" />
          <SubmitButton
            label="Supprimer l'app"
            pendingLabel="…"
            variant="destructive"
            size="sm"
            icon={Trash2}
            confirm="Supprimer les ressources de cette application ? Le namespace et les autres applications sont conservés."
          />
        </form>

        <form action={action}>
          <input type="hidden" name="deployment_id" value={deploymentId} />
          <input type="hidden" name="action" value="delete-namespace" />
          <SubmitButton
            label="Supprimer l'environnement"
            pendingLabel="…"
            variant="destructive"
            size="sm"
            icon={Trash2}
            confirm="Supprimer TOUT le namespace de cet environnement ? Cette action est irréversible."
          />
        </form>
      </div>
      <Feedback state={state} />
    </div>
  );
}

/** Bouton de rollback vers une révision antérieure. */
export function RollbackButton({
  deploymentId,
  revision,
}: {
  deploymentId: string;
  revision: number;
}) {
  const [state, action] = useActionState<ActionState, FormData>(lifecycleAction, null);
  return (
    <form action={action} className="inline-flex items-center gap-2">
      <input type="hidden" name="deployment_id" value={deploymentId} />
      <input type="hidden" name="action" value="rollback" />
      <SubmitButton
        label="Rollback"
        pendingLabel="…"
        variant="outline"
        size="sm"
        icon={RotateCcw}
        confirm={`Revenir à la révision ${revision} ? Une nouvelle révision sera créée.`}
      />
      <Feedback state={state} />
    </form>
  );
}

/** Démarre ou arrête le suivi des logs en continu côté agent. */
export function LogFollowButton({
  deploymentId,
  following,
}: {
  deploymentId: string;
  following: boolean;
}) {
  const [state, action] = useActionState<ActionState, FormData>(lifecycleAction, null);
  return (
    <form action={action} className="inline-flex items-center gap-2">
      <input type="hidden" name="deployment_id" value={deploymentId} />
      <input type="hidden" name="action" value={following ? "unfollow-logs" : "follow-logs"} />
      <SubmitButton
        label={following ? "Arrêter le suivi" : "Suivre les logs"}
        pendingLabel="…"
        variant="outline"
        size="sm"
        icon={following ? Square : Play}
      />
      <Feedback state={state} />
    </form>
  );
}

// ---------------------------------------------------------------------------
// Variables et secrets
// ---------------------------------------------------------------------------

export function VarsForm({
  appId,
  environment,
  kind,
}: {
  appId: string;
  environment: string;
  kind: "env" | "secret";
}) {
  const [state, action] = useActionState<ActionState, FormData>(saveVarsAction, null);

  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="app_id" value={appId} />
      <input type="hidden" name="environment" value={environment} />
      <input type="hidden" name="kind" value={kind} />
      <Textarea
        name="vars"
        rows={4}
        aria-label={kind === "secret" ? "Secrets" : "Variables"}
        placeholder={kind === "secret" ? "DB_PASSWORD=…" : "LOG_LEVEL=info"}
        className="font-mono"
      />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton
          label={kind === "secret" ? "Enregistrer les secrets" : "Enregistrer les variables"}
          pendingLabel="Enregistrement…"
          variant="outline"
          size="sm"
        />
        <Feedback state={state} />
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Registries
// ---------------------------------------------------------------------------

export function RegistryForm() {
  const [state, action] = useActionState<ActionState, FormData>(createRegistryAction, null);

  return (
    <form action={action} className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Nom" htmlFor="reg_name">
          <Input
            id="reg_name"
            name="name"
            required
            placeholder="mon-docker-hub"
          />
        </FormField>

        <FormField label="Serveur" htmlFor="reg_server">
          <Input
            id="reg_server"
            name="server"
            required
            list="server-suggestions"
            defaultValue="docker.io"
            className="font-mono"
          />
          <datalist id="server-suggestions">
            <option value="docker.io">Docker Hub</option>
            <option value="ghcr.io">GitHub Container Registry</option>
            <option value="quay.io">Quay</option>
            <option value="registry.gitlab.com">GitLab</option>
          </datalist>
        </FormField>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Identifiant" htmlFor="reg_username">
          <Input
            id="reg_username"
            name="username"
            required
            autoComplete="username"
          />
        </FormField>

        <FormField
          label="Mot de passe / token"
          htmlFor="reg_password"
          hint="Chiffré en base, jamais relu par l'interface."
        >
          <Input
            id="reg_password"
            name="password"
            type="password"
            required
            autoComplete="new-password"
          />
        </FormField>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton label="Connecter" pendingLabel="Vérification…" />
        <Feedback state={state} />
      </div>
    </form>
  );
}

export function DeleteRegistryButton({ registryId }: { registryId: string }) {
  const [state, action] = useActionState<ActionState, FormData>(deleteRegistryAction, null);
  return (
    <form action={action} className="inline-flex items-center gap-2">
      <input type="hidden" name="registry_id" value={registryId} />
      <SubmitButton
        label="Supprimer"
        pendingLabel="…"
        variant="destructive"
        size="sm"
        icon={Trash2}
        confirm="Supprimer ce registry ? Les déploiements qui l'utilisent ne pourront plus tirer leurs images."
      />
      <Feedback state={state} />
    </form>
  );
}
