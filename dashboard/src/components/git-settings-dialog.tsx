"use client";

import { useActionState, useState } from "react";
import { ExternalLink, Info, Plug, Settings2 } from "lucide-react";

import { setGitSettingsAction, type ActionState } from "@/app/actions";
import { SubmitButton, Feedback } from "@/components/forms";
import { Button } from "@/components/ui/button";
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

/**
 * Configuration de l'intégration Git, depuis l'interface.
 *
 * Le jeton vivait uniquement en variable d'environnement : le renseigner
 * imposait un accès au serveur et un redémarrage. Il est désormais posable
 * ici, chiffré en base — la variable d'environnement, si elle existe, garde
 * la priorité.
 */
export function GitSettingsDialog({
  trigger,
}: {
  /** Déclencheur personnalisé ; un bouton discret par défaut. */
  trigger?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [state, action] = useActionState<ActionState, FormData>(
    setGitSettingsAction,
    null,
  );

  // Un succès referme : la page rafraîchie derrière montre l'intégration
  // active.
  const isOpen = open && !state?.ok;

  return (
    <>
      {trigger ? (
        <span onClick={() => setOpen(true)}>{trigger}</span>
      ) : (
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          <Settings2 className="size-3.5" />
          Configurer GitHub
        </Button>
      )}

      <Dialog open={isOpen} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Connecter GitHub</DialogTitle>
            <DialogDescription>
              Kybers lit la documentation et les pipelines des dépôts rattachés.
              Le jeton vaut pour toute l&apos;instance.
            </DialogDescription>
          </DialogHeader>

          <form action={action} className="flex flex-col gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="git_token">Jeton d&apos;accès</Label>
              <Input
                id="git_token"
                name="token"
                type="password"
                required
                placeholder="ghp_…"
                autoComplete="off"
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">
                Chiffré en base, jamais relu par l&apos;interface.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="git_api_url">
                URL de l&apos;API <span className="text-muted-foreground">(optionnel)</span>
              </Label>
              <Input
                id="git_api_url"
                name="api_url"
                placeholder="https://api.github.com"
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">
                À renseigner pour GitHub Enterprise uniquement.
              </p>
            </div>

            <div className="space-y-2 rounded-lg border border-border p-3 text-xs text-muted-foreground">
              <p className="flex items-center gap-1.5 font-medium text-foreground">
                <Info className="size-3.5" />
                Droits nécessaires
              </p>
              <p>
                <strong className="text-foreground">Lecture seule</strong> —
                portée <code className="font-mono">repo</code> en lecture, ou
                fine-grained <code className="font-mono">Contents: read</code> +{" "}
                <code className="font-mono">Actions: read</code>. Suffit pour la
                documentation et les pipelines.
              </p>
              <p>
                <strong className="text-foreground">Écriture</strong> — portée{" "}
                <code className="font-mono">repo</code>, pour créer des dépôts.
              </p>
              <p>
                <strong className="text-foreground">Pipeline</strong> — portée{" "}
                <code className="font-mono">workflow</code> en plus, exigée par
                GitHub pour écrire sous{" "}
                <code className="font-mono">.github/workflows/</code>.
              </p>
              <a
                href="https://github.com/settings/tokens"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                Créer un jeton sur GitHub
                <ExternalLink className="size-3" />
              </a>
            </div>

            <Feedback state={state} />

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setOpen(false)}
              >
                Annuler
              </Button>
              <SubmitButton
                label="Connecter"
                pendingLabel="Vérification…"
                icon={Plug}
              />
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
