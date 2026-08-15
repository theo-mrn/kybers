"use client";

import {
  AlertTriangle,
  FileCode,
  GitBranch,
  Network,
} from "lucide-react";

import type { App, FileTemplate, TemplateFolder } from "@/lib/api";
import { Card } from "@/components/ui";
import { PortsForm } from "@/components/ports-form";
import { RepoForm } from "@/components/repo-form";
import { AppFiles } from "@/components/app-files";
import { DeleteAppDialog } from "@/components/delete-app-dialog";

/**
 * Paramètres d'une application : ce qui la décrit, indépendamment de ses
 * environnements.
 *
 * Le dépôt et les ports appartiennent au service lui-même ; la configuration
 * d'exécution — ressources, sondes, variables — reste propre à chaque
 * environnement et vit donc un cran plus bas.
 */
export function AppSettings({
  app,
  environments,
  baseUrl,
  templates = [],
  folders = [],
}: {
  app: App;
  /** Nombre d'environnements encore déployés : conditionne la suppression. */
  environments: number;
  /** URL publique appelée par le workflow depuis le CI. */
  baseUrl: string;
  /** Modèles de l'organisation, proposés à l'écriture. */
  templates?: FileTemplate[];
  /** Dossiers de modèles, pour l'ajout en bloc. */
  folders?: TemplateFolder[];
}) {
  return (
    <div className="flex flex-col gap-6">
      <Card
        title="Dépôt Git"
        description="Rattacher un dépôt donne accès à sa documentation et à ses pipelines, et relie chaque déploiement au commit qui l'a produit."
        icon={GitBranch}
      >
        <RepoForm appId={app.id} repo={app.git_repo ?? ""} configured />
      </Card>

      <Card
        title="Ports"
        description="Les ports ouverts par l'image. Un seul reçoit le trafic public ; les autres restent joignables dans le cluster."
        icon={Network}
      >
        <PortsForm appId={app.id} ports={app.ports ?? []} />
      </Card>

      {app.git_repo && (
        <Card
          title="Fichiers du dépôt"
          description="Écrire ou réécrire les fichiers issus de vos modèles. Les fichiers existants sont remplacés."
          icon={FileCode}
        >
          <AppFiles
            repo={app.git_repo}
            appId={app.id}
            appName={app.name}
            baseUrl={baseUrl}
            templates={templates}
            folders={folders}
          />
        </Card>
      )}

      <Card title="Zone de danger" icon={AlertTriangle}>
        <div className="flex flex-wrap items-start justify-between gap-4 rounded-lg border border-destructive/25 bg-destructive/5 p-4">
          <div className="min-w-0 space-y-1">
            <p className="text-sm font-medium text-destructive">
              Supprimer cette application
            </p>
            <p className="text-xs text-muted-foreground">
              {environments > 0
                ? `${environments} environnement(s) seront retirés du cluster.`
                : "Aucun environnement déployé."}{" "}
              Le dépôt Git peut être supprimé au passage, sur demande.
            </p>
          </div>

          <DeleteAppDialog app={app} environments={environments} />
        </div>
      </Card>
    </div>
  );
}
