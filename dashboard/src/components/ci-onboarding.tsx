"use client";

import { useActionState, useState } from "react";
import {
  Check,
  Copy,
  KeyRound,
  Rocket,
  Terminal,
  TriangleAlert,
} from "lucide-react";

import { createTokenAction, type TokenState } from "@/app/auth-actions";
import {
  PROVIDERS,
  TOKEN_SECRET,
  type Provider,
  verifyCommand,
  workflow,
} from "@/lib/ci-templates";
import { SubmitButton } from "@/components/forms";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/** Bloc de code copiable : le geste central de cet écran. */
function Snippet({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(children);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Presse-papiers refusé (contexte non sécurisé) : le texte reste
      // sélectionnable à la main.
    }
  }

  return (
    <div className="relative">
      <pre
        className={cn(
          "max-h-80 overflow-auto rounded-lg border border-border bg-muted/40 p-3 pr-12 font-mono text-xs leading-relaxed select-all",
          className,
        )}
      >
        {children}
      </pre>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Copier"
        title="Copier"
        onClick={copy}
        className="absolute top-2 right-2"
      >
        {copied ? (
          <Check className="size-3.5 text-success" />
        ) : (
          <Copy className="size-3.5" />
        )}
      </Button>
    </div>
  );
}

/** Étape numérotée du parcours. */
function Step({
  n,
  title,
  description,
  last,
  children,
}: {
  n: number;
  title: string;
  description?: string;
  /** La dernière étape ne prolonge pas le fil vertical. */
  last?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-4">
      <div className="flex flex-col items-center">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border text-xs font-medium">
          {n}
        </span>
        {!last && <span className="mt-1 w-px flex-1 bg-border" aria-hidden />}
      </div>

      <div className={cn("min-w-0 flex-1", last ? "pb-0" : "pb-6")}>
        <p className="text-sm font-medium">{title}</p>
        {description && (
          <p className="mt-0.5 mb-3 text-xs text-muted-foreground">
            {description}
          </p>
        )}
        <div className={description ? "" : "mt-3"}>{children}</div>
      </div>
    </div>
  );
}

/**
 * Parcours de branchement d'un CI.
 *
 * Kybers ne s'installe pas sur le dépôt : il fournit ce qu'il faut coller dans
 * la pipeline existante. Ce chemin fonctionne quel que soit l'outil du client
 * — GitHub, GitLab, Jenkins — là où une intégration propriétaire en exclurait
 * une partie.
 */
export function CiOnboarding({
  baseUrl,
  appId,
  appName,
  environment,
  registry = "ghcr.io",
}: {
  baseUrl: string;
  appId: string;
  appName: string;
  environment: string;
  registry?: string;
}) {
  const [provider, setProvider] = useState<Provider>("github");
  const [state, action] = useActionState<TokenState, FormData>(
    createTokenAction,
    null,
  );

  const created = state?.ok && state.token;
  const current = PROVIDERS.find((p) => p.key === provider)!;

  return (
    <div className="flex flex-col">
      {/* --- 1. Le jeton --------------------------------------------------- */}
      <Step
        n={1}
        title="Créer un jeton d'API"
        description="Il autorise votre pipeline à déclencher des déploiements. Il hérite de vos droits dans l'organisation."
      >
        {created ? (
          <div className="rounded-lg border border-success/30 bg-success/5 p-3">
            <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-success">
              <Check className="size-3.5" />
              Jeton créé — copiez-le maintenant
            </p>
            <Snippet>{state!.token!}</Snippet>
            <p className="mt-2 flex items-start gap-1.5 text-xs text-warning">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
              Il ne sera plus affiché : seule son empreinte est conservée.
            </p>
          </div>
        ) : (
          <form action={action} className="flex flex-wrap items-end gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="ci_token_name">Nom du jeton</Label>
              <Input
                id="ci_token_name"
                name="name"
                required
                defaultValue={`ci-${appName}`}
                className="h-8 w-56"
              />
            </div>
            <input type="hidden" name="expires_in_days" value="365" />
            <SubmitButton
              label="Créer le jeton"
              pendingLabel="Création…"
              icon={KeyRound}
              size="sm"
            />
            {state && !state.ok && (
              <p className="text-xs text-destructive" role="alert">
                {state.message}
              </p>
            )}
          </form>
        )}
      </Step>

      {/* --- 2. Le secret -------------------------------------------------- */}
      <Step
        n={2}
        title="L'ajouter aux secrets de votre dépôt"
        description={
          provider === "github"
            ? "Settings → Secrets and variables → Actions → New repository secret"
            : provider === "gitlab"
              ? "Settings → CI/CD → Variables → Add variable (masquée)"
              : "Dans le gestionnaire de secrets de votre CI."
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="font-mono">
            {TOKEN_SECRET}
          </Badge>
          <span className="text-xs text-muted-foreground">
            = le jeton de l&apos;étape 1
          </span>
        </div>
      </Step>

      {/* --- 3. Le workflow ------------------------------------------------ */}
      <Step
        n={3}
        title="Ajouter l'étape de déploiement"
        description="Votre pipeline construit et publie l'image, puis appelle Kybers pour la déployer."
      >
        <div className="mb-2 flex flex-wrap items-center gap-1">
          {PROVIDERS.map((p) => (
            <Button
              key={p.key}
              variant={provider === p.key ? "secondary" : "ghost"}
              size="xs"
              aria-pressed={provider === p.key}
              onClick={() => setProvider(p.key)}
            >
              {p.label}
            </Button>
          ))}
          {current.file && (
            <Badge variant="outline" className="ml-1 font-mono">
              {current.file}
            </Badge>
          )}
        </div>

        <Snippet>
          {workflow(provider, {
            baseUrl,
            appId,
            appName,
            environment,
            registry,
          })}
        </Snippet>
      </Step>

      {/* --- 4. Vérifier --------------------------------------------------- */}
      <Step
        n={4}
        last
        title="Pousser sur votre dépôt"
        description="La pipeline se déclenche, publie l'image et crée une révision ici. Pour vérifier le jeton sans attendre :"
      >
        <Snippet>{verifyCommand(baseUrl)}</Snippet>
        <p className="mt-3 flex items-start gap-1.5 text-xs text-muted-foreground">
          <Rocket className="mt-0.5 size-3.5 shrink-0" />
          Les déploiements apparaîtront sur cette page, marqués{" "}
          <Badge variant="secondary" className="gap-1 border-transparent bg-info/15 text-info">
            <Terminal className="size-3" />
            CI
          </Badge>
        </p>
      </Step>
    </div>
  );
}

/** Déclencheur : ouvre le parcours dans une modale. */
export function CiOnboardingDialog(props: React.ComponentProps<typeof CiOnboarding>) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Terminal className="size-3.5" />
        Brancher un CI
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Déployer depuis votre CI</DialogTitle>
            <DialogDescription>
              Votre pipeline construit et publie l&apos;image, puis appelle
              Kybers pour la déployer. Kybers ne construit rien et ne s&apos;installe
              pas sur votre dépôt.
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-[70vh] overflow-y-auto pr-1">
            <CiOnboarding {...props} />
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Fermer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
