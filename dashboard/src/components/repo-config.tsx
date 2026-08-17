"use client";

import * as React from "react";
import { useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ExternalLink,
  GitBranch,
  KeyRound,
  Layers,
  Trash2,
  Variable,
} from "lucide-react";

import {
  deleteRepoEntryAction,
  deleteRepoEnvAction,
} from "@/app/actions";
import { Button } from "@/components/ui/button";
import { RepoEntryDialog } from "@/components/repo-entry-dialog";
import { RepoEntryEdit } from "@/components/repo-entry-edit";
import { Card } from "@/components/ui";
import { ConfirmButton } from "@/components/confirm-button";
import { NewEnvDialog } from "@/components/new-env-dialog";
import { cn } from "@/lib/utils";

/**
 * Variables et secrets du dépôt GitHub.
 *
 * Une seule source : ce que Kybers écrit ici part sur GitHub, et ce qui
 * s'affiche vient de GitHub. Les variables sont relues telles quelles ; des
 * secrets, l'API ne restitue que les noms — c'est le principe même d'un
 * secret, et il n'y a rien à en tirer de plus.
 */
export function RepoConfig({
  appId,
  repo,
  variables,
  secretNames,
  env = "",
  environments = [],
}: {
  appId: string;
  repo: string;
  variables: { name: string; value: string }[];
  secretNames: string[];
  /** Environnement consulté ; vide = niveau dépôt, commun à tous. */
  env?: string;
  /** Environnements déclarés sur le dépôt. */
  environments?: string[];
}) {
  return (
    <div className="flex flex-col gap-6">
      <EnvTabs appId={appId} current={env} environments={environments} />

      <div className="grid items-start gap-6 lg:grid-cols-2">
      <Card
        title="Variables"
        icon={Variable}
        action={
          <Button
            variant="ghost"
            size="sm"
            nativeButton={false}
            className="text-muted-foreground"
            render={
              <a
                href={ghHref(repo, env, "variables")}
                target="_blank"
                rel="noreferrer"
              />
            }
          >
            Voir
            <ExternalLink className="size-3.5" />
          </Button>
        }
      >
        {variables.length > 0 ? (
          <ul className="mb-4 space-y-1 rounded-md border border-border bg-muted/40 p-2">
            {variables.map((v) => (
              <li
                key={v.name}
                className="flex items-center gap-2 rounded px-1 py-0.5 font-mono text-xs"
              >
                <span className="min-w-0 flex-1 truncate">
                  <span className="text-foreground">{v.name}</span>
                  <span className="text-muted-foreground">={v.value}</span>
                </span>
                <RepoEntryEdit
                  appId={appId}
                  name={v.name}
                  value={v.value}
                  kind="var"
                  env={env}
                />
                <RemoveButton appId={appId} name={v.name} kind="var" env={env} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="mb-4 text-xs text-muted-foreground">
            Aucune variable sur ce dépôt.
          </p>
        )}

        <RepoEntryDialog
          appId={appId}
          kind="var"
          taken={variables.map((v) => v.name)}
          env={env}
        />
      </Card>

      <Card
        title="Secrets"
        icon={KeyRound}
        action={
          <Button
            variant="ghost"
            size="sm"
            nativeButton={false}
            className="text-muted-foreground"
            render={
              <a
                href={ghHref(repo, env, "secrets")}
                target="_blank"
                rel="noreferrer"
              />
            }
          >
            Voir
            <ExternalLink className="size-3.5" />
          </Button>
        }
      >
        {secretNames.length > 0 ? (
          <ul className="mb-4 space-y-1 rounded-md border border-border bg-muted/40 p-2">
            {secretNames.map((n) => (
              <li
                key={n}
                className="flex items-center gap-2 rounded px-1 py-0.5 font-mono text-xs"
              >
                <KeyRound className="size-3 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{n}</span>
                <span className="text-muted-foreground">••••••</span>
                <RepoEntryEdit appId={appId} name={n} kind="secret" env={env} />
                <RemoveButton appId={appId} name={n} kind="secret" env={env} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="mb-4 text-xs text-muted-foreground">
            Aucun secret sur ce dépôt.
          </p>
        )}

        <RepoEntryDialog
          appId={appId}
          kind="secret"
          taken={secretNames}
          env={env}
        />
      </Card>
      </div>
    </div>
  );
}

/**
 * Portée consultée : le dépôt, ou l'un de ses environnements.
 *
 * GitHub ne livre les secrets d'un environnement qu'aux workflows qui le
 * visent. Ce qui est posé au niveau du dépôt reste lisible par tous — d'où la
 * distinction, qui décide de qui verra quoi.
 */
/**
 * Portée consultée : le dépôt, ou l'un de ses environnements.
 *
 * GitHub ne livre les secrets d'un environnement qu'aux workflows qui le
 * visent ; ce qui est posé au niveau du dépôt reste lisible par tous. La
 * distinction décide de qui verra quoi, elle mérite d'être lisible d'un coup
 * d'œil plutôt que noyée dans une ligne d'actions.
 */
function EnvTabs({
  appId,
  current,
  environments,
}: {
  appId: string;
  current: string;
  environments: string[];
}) {
  const href = (e: string) =>
    `?tab=configuration${e ? `&env=${encodeURIComponent(e)}` : ""}`;

  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      {/* Les onglets seuls : mêler les actions à la navigation faisait
          cliquer sur « Supprimer » en croyant changer de portée. */}
      <nav className="flex flex-wrap items-center gap-1 rounded-lg border border-border p-1">
        <Tab
          href={href("")}
          active={current === ""}
          icon={GitBranch}
          label="Dépôt"
        />
        {environments.map((e) => (
          <Tab
            key={e}
            href={href(e)}
            active={current === e}
            icon={Layers}
            label={e}
          />
        ))}
      </nav>

      <div className="flex items-center gap-1">
        <NewEnvDialog appId={appId} existing={environments} />
        {/* La suppression ne porte que sur la portée affichée, et se tient à
            l'écart des onglets. */}
        {current !== "" && <DeleteEnvButton appId={appId} name={current} />}
      </div>
    </div>
  );
}

/**
 * Lien vers le réglage correspondant sur GitHub.
 *
 * Un environnement a sa propre page : y renvoyer évite de chercher dans une
 * liste, et confirme au passage que la portée affichée est la bonne.
 */
function ghHref(repo: string, env: string, kind: "variables" | "secrets") {
  const base = `https://github.com/${repo}/settings`;
  return env
    ? `${base}/environments/${encodeURIComponent(env)}/edit`
    : `${base}/${kind}/actions`;
}

/** Un onglet de portée. */
function Tab({
  href,
  active,
  icon: Icon,
  label,
}: {
  href: string;
  active: boolean;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors",
        active
          ? "bg-primary/15 font-medium text-primary"
          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
      )}
    >
      <Icon className="size-3.5" />
      {label}
    </Link>
  );
}

/** Retrait d'une entrée, avec confirmation. */
function RemoveButton({
  appId,
  name,
  kind,
  env,
}: {
  appId: string;
  name: string;
  kind: "var" | "secret";
  env: string;
}) {
  const [pending, start] = useTransition();

  return (
    <ConfirmButton
      onConfirm={() => start(() => void deleteRepoEntryAction(appId, name, kind, env))}
      title={`Retirer ${name}`}
      description={`« ${name} » sera supprimé du dépôt. Vos workflows ne le verront plus.`}
      confirmLabel="Retirer"
      icon={Trash2}
      ariaLabel={`Retirer ${name}`}
      size="icon-xs"
      pending={pending}
      className="shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
    />
  );
}

/** Suppression de l'environnement consulté, avec confirmation. */
function DeleteEnvButton({ appId, name }: { appId: string; name: string }) {
  const [pending, start] = useTransition();
  const router = useRouter();

  return (
    <ConfirmButton
      onConfirm={() =>
        start(async () => {
          const res = await deleteRepoEnvAction(appId, name);
          // Rester sur un environnement supprimé afficherait une vue vide sans
          // expliquer pourquoi.
          if (res?.ok) router.push("?tab=configuration");
        })
      }
      title={`Supprimer ${name}`}
      description={`« ${name} » sera supprimé du dépôt, avec ses secrets et ses variables. Les valeurs ne seront récupérables nulle part.`}
      confirmLabel="Supprimer l'environnement"
      icon={Trash2}
      ariaLabel={`Supprimer l'environnement ${name}`}
      size="icon-sm"
      pending={pending}
      className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
    />
  );
}
