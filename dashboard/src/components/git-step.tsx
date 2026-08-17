"use client";

import * as React from "react";
import { useState } from "react";
import {
  Check,
  Link2,
  Lock,
  Plug,
  Plus,
  TriangleAlert,
  XCircle,
} from "lucide-react";

import { gitProbeAction, type GitProbeState } from "@/app/actions";
import type { GitStatus } from "@/lib/api";
import { GitSettingsDialog } from "@/components/git-settings-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm outline-none " +
  "transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40";

/**
 * Étape « dépôt » du parcours de création.
 *
 * Trois cas, selon ce que le jeton de l'instance permet : rattacher un dépôt
 * existant, en créer un, ou continuer sans. L'état de l'intégration est vérifié
 * en amont pour ne proposer que ce qui aboutira.
 */
export function GitStep({
  status,
  appName,
  onResolved,
  onCreateRequest,
  onReady,
}: {
  status: GitStatus;
  /** Sert de nom par défaut au dépôt à créer. */
  appName: string;
  /** Remonte la référence retenue, pour l'étape suivante. */
  onResolved?: (repo: string) => void;
  /**
   * Remonte la demande de création, jouée à la validation finale.
   *
   * Le dépôt n'est plus créé à cette étape : abandonner le parcours ensuite
   * laissait un dépôt vide sur le compte de l'utilisateur.
   */
  onCreateRequest?: (
    req: { owner: string; name: string; private: boolean } | null,
  ) => void;
  /**
   * Reçoit la fonction de vérification, déclenchée par « Continuer ».
   *
   * Un bouton « Vérifier » séparé faisait double emploi : on ne quitte l'étape
   * que pour continuer, et continuer suppose un dépôt résolu.
   */
  onReady?: (probe: () => Promise<boolean>) => void;
}) {
  const [mode, setMode] = useState<"link" | "create">("link");
  const [state, setState] = useState<GitProbeState>(null);

  // Les champs sont lus à la demande : ce composant vit DANS le formulaire de
  // création, un <form> imbriqué serait invalide et React le refuse.
  const repoRef = React.useRef<HTMLInputElement>(null);
  const ownerRef = React.useRef<HTMLSelectElement>(null);
  const nameRef = React.useRef<HTMLInputElement>(null);
  const privateRef = React.useRef<HTMLInputElement>(null);

  /**
   * Résout le dépôt saisi. Retourne faux si l'étape ne peut pas être quittée.
   *
   * Un champ vide n'est pas un échec : continuer sans dépôt reste permis, on
   * le rattachera plus tard depuis l'application.
   */
  const probe = React.useCallback(async (): Promise<boolean> => {
    const typed =
      mode === "link"
        ? (repoRef.current?.value ?? "").trim()
        : (nameRef.current?.value ?? "").trim();
    if (!typed) {
      setState(null);
      onResolved?.("");
      onCreateRequest?.(null);
      return true;
    }

    const data = new FormData();
    data.set("mode", mode);
    if (mode === "link") {
      data.set("repo", typed);
    } else {
      data.set("owner", ownerRef.current?.value ?? "");
      data.set("repo_name", typed);
      if (privateRef.current?.checked) data.set("private", "true");
    }

    const res = await gitProbeAction(null, data);
    setState(res);
    if (!res?.ok || !res.repo) return false;

    onResolved?.(res.repo);
    onCreateRequest?.(
      mode === "create"
        ? {
            owner: ownerRef.current?.value ?? "",
            name: typed,
            private: privateRef.current?.checked ?? false,
          }
        : null,
    );
    return true;
  }, [mode, onResolved, onCreateRequest]);

  // Le parent déclenche la vérification depuis « Continuer ».
  React.useEffect(() => {
    onReady?.(probe);
  }, [onReady, probe]);

  // La référence validée alimente le champ caché du formulaire parent : aucun
  // état à remonter, le FormData la portera.
  const resolved = state?.ok ? state.repo : undefined;

  // --- Aucun jeton : le rattachement reste possible, la lecture non. --------
  if (!status.configured) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-warning/30 bg-warning/5 p-3">
          <div className="min-w-0 space-y-1">
            <p className="flex items-center gap-1.5 text-sm font-medium text-warning">
              <TriangleAlert className="size-3.5" />
              GitHub n&apos;est pas connecté
            </p>
            <p className="text-xs text-muted-foreground">
              Connectez-le pour rattacher un dépôt, en créer un, et afficher sa
              documentation et ses pipelines.
            </p>
          </div>
          <GitSettingsDialog
            trigger={
              <Button size="sm">
                <Plug className="size-3.5" />
                Connecter GitHub
              </Button>
            }
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="git_repo_manual">Dépôt Git</Label>
          <Input
            id="git_repo_manual"
            name="git_repo"
            placeholder="acme/billing-api"
            className="font-mono"
          />
          <p className="text-xs text-muted-foreground">
            Facultatif — vous pourrez le rattacher plus tard.
          </p>
        </div>
      </div>
    );
  }

  // --- Jeton présent mais refusé -------------------------------------------
  if (status.valid === false) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
          <div className="min-w-0 space-y-1">
            <p className="flex items-center gap-1.5 text-sm font-medium text-destructive">
              <XCircle className="size-3.5" />
              Jeton GitHub refusé
            </p>
            <p className="text-xs text-muted-foreground">
              {status.error ?? "accès impossible"}
            </p>
          </div>
          <GitSettingsDialog
            trigger={
              <Button size="sm" variant="outline">
                <Plug className="size-3.5" />
                Remplacer le jeton
              </Button>
            }
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="git_repo_manual">Dépôt Git</Label>
          <Input
            id="git_repo_manual"
            name="git_repo"
            placeholder="acme/billing-api"
            className="font-mono"
          />
        </div>
      </div>
    );
  }

  const owners = status.owners ?? [];
  const canCreate = status.can_create !== false;

  return (
    <div className="flex flex-col gap-4">
      {/* Le dépôt retenu voyage avec le formulaire parent. */}
      <input type="hidden" name="git_repo" value={resolved ?? ""} />

      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Check className="size-3.5 text-success" />
        Connecté à GitHub en tant que{" "}
        <span className="font-mono text-foreground">{status.login}</span>
      </p>

      {/* Deux choix, chacun avec sa seule action : un troisième bouton pour
          valider laissait croire qu'il fallait cliquer deux fois. */}
      <div className="grid gap-3 sm:grid-cols-2">
        <button
          type="button"
          aria-pressed={mode === "link"}
          onClick={() => setMode("link")}
          className={cn(
            "flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors",
            mode === "link"
              ? "border-primary/50 bg-primary/5"
              : "border-border hover:bg-muted/60",
          )}
        >
          <span className="flex items-center gap-1.5 text-sm font-medium">
            <Link2 className="size-3.5" />
            Dépôt existant
          </span>
          <span className="text-xs text-muted-foreground">
            Rattacher un dépôt déjà créé.
          </span>
        </button>

        <button
          type="button"
          aria-pressed={mode === "create"}
          disabled={!canCreate}
          title={canCreate ? undefined : "Le jeton ne permet pas de créer un dépôt"}
          onClick={() => setMode("create")}
          className={cn(
            "flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors",
            mode === "create"
              ? "border-primary/50 bg-primary/5"
              : "border-border hover:bg-muted/60",
            !canCreate && "cursor-not-allowed opacity-50",
          )}
        >
          <span className="flex items-center gap-1.5 text-sm font-medium">
            <Plus className="size-3.5" />
            Créer un dépôt
          </span>
          <span className="text-xs text-muted-foreground">
            {canCreate
              ? "Kybers le crée sur votre compte."
              : "Jeton en lecture seule."}
          </span>
        </button>
      </div>

      <div className="flex flex-col gap-3">
        {mode === "link" ? (
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1 space-y-1.5">
              <Label htmlFor="probe_repo">Dépôt à rattacher</Label>
              <Input
                id="probe_repo"
                ref={repoRef}
                placeholder="acme/billing-api"
                className="font-mono"
              />
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1.5">
                <Label htmlFor="probe_owner">Propriétaire</Label>
                <select id="probe_owner" ref={ownerRef} className={selectClass}>
                  {owners.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              </div>

              <div className="min-w-0 flex-1 space-y-1.5">
                <Label htmlFor="probe_name">Nom du dépôt</Label>
                <Input
                  id="probe_name"
                  ref={nameRef}
                  defaultValue={appName}
                  placeholder="billing-api"
                  className="font-mono"
                />
              </div>
            </div>

            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                ref={privateRef}
                defaultChecked
                className="size-4 accent-primary"
              />
              <Lock className="size-3" />
              Dépôt privé
            </label>
          </div>
        )}

        {state && !state.ok && (
          <p
            className="flex items-start gap-1.5 text-xs text-destructive"
            role="alert"
          >
            <XCircle className="mt-0.5 size-3.5 shrink-0" />
            {state.message}
          </p>
        )}
      </div>

      {resolved && (
        <p className="flex items-center gap-2 rounded-md border border-success/30 bg-success/5 px-3 py-2 text-xs text-success">
          <Check className="size-3.5 shrink-0" />
          <span>
            <strong className="font-medium">{resolved}</strong>{" "}
            {mode === "create"
              ? "sera créé et rattaché à la validation."
              : "sera rattaché à l'application."}
          </span>
        </p>
      )}

    </div>
  );
}
