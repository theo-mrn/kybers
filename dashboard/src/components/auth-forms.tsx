"use client";

import { useActionState } from "react";
import Link from "next/link";
import {
  loginAction,
  registerAction,
  deleteTokenAction,
  type AuthState,
  type TokenState,
} from "@/app/auth-actions";
import type { APIToken } from "@/lib/api";
import { CheckCircle2, Trash2, XCircle } from "lucide-react";

import { SubmitButton } from "@/components/forms";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/** Même rendu que `Feedback`, pour les actions d'authentification. */
function Message({ state }: { state: AuthState | TokenState }) {
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

/** Erreur compacte affichée à côté d'un contrôle inline. */
function InlineError({ state }: { state: AuthState }) {
  if (!state || state.ok) return null;
  return (
    <span className="text-xs text-destructive" role="alert">
      {state.message}
    </span>
  );
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

// ---------------------------------------------------------------------------
// Connexion / inscription
// ---------------------------------------------------------------------------

export function LoginForm({
  register,
  bootstrap,
}: {
  register: boolean;
  /** Vrai tant qu'aucun compte n'existe : l'inscription est alors ouverte. */
  bootstrap: boolean;
}) {
  const [state, action] = useActionState<AuthState, FormData>(
    register ? registerAction : loginAction,
    null,
  );

  return (
    <div>
      <h2 className="mb-5 text-base font-semibold">
        {register ? "Créer un compte" : "Connexion"}
      </h2>

      <form action={action} className="flex flex-col gap-4">
        {register && (
          <Field label="Nom" htmlFor="name">
            <Input id="name" name="name" placeholder="Alice Martin" autoComplete="name" />
          </Field>
        )}

        <Field label="Email" htmlFor="email">
          <Input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="email"
            placeholder="vous@exemple.fr"
          />
        </Field>

        <Field
          label="Mot de passe"
          htmlFor="password"
          hint={
            register
              ? "10 caractères minimum — une phrase longue vaut mieux qu'un mot complexe."
              : undefined
          }
        >
          <Input
            id="password"
            name="password"
            type="password"
            required
            autoComplete={register ? "new-password" : "current-password"}
          />
        </Field>

        {register && (
          <Field
            label="Organisation"
            htmlFor="org_name"
            hint="Vos applications, clusters et registries lui appartiendront."
          >
            <Input id="org_name" name="org_name" placeholder="ACME" />
          </Field>
        )}

        <div className="flex flex-col gap-3">
          <SubmitButton
            label={register ? "Créer le compte" : "Se connecter"}
            pendingLabel="…"
            className="w-full"
          />
          <Message state={state} />
        </div>
      </form>

      <p className="mt-5 text-xs text-muted-foreground">
        {register ? (
          <>
            Déjà un compte ?{" "}
            <Link href="/login" className="text-primary hover:underline">
              Se connecter
            </Link>
          </>
        ) : bootstrap ? (
          <>
            Première installation ?{" "}
            <Link
              href="/login?mode=register"
              className="text-primary hover:underline"
            >
              Créer le premier compte
            </Link>
          </>
        ) : (
          // Les comptes suivants sont créés par un administrateur : proposer
          // l'inscription mènerait à un refus.
          "Les comptes sont créés par un administrateur."
        )}
      </p>
    </div>
  );
}

export function DeleteTokenButton({ token }: { token: APIToken }) {
  const [state, action] = useActionState<AuthState, FormData>(deleteTokenAction, null);

  return (
    <form action={action} className="inline-flex items-center gap-2">
      <input type="hidden" name="token_id" value={token.id} />
      <SubmitButton
        label="Révoquer"
        pendingLabel="…"
        variant="destructive"
        size="sm"
        icon={Trash2}
        confirm={`Révoquer « ${token.name} » ? Tout script l'utilisant cessera de fonctionner.`}
      />
      <InlineError state={state} />
    </form>
  );
}
