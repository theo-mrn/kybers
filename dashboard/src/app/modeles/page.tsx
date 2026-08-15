import { redirect } from "next/navigation";
import { FileCode, Info } from "lucide-react";

import { api } from "@/lib/api";
import { TemplateDialog } from "@/components/template-dialog";
import { FolderDialog } from "@/components/folder-dialog";
import { TemplateExplorer } from "@/components/template-explorer";
import { Card, EmptyState, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * Bibliothèque de modèles de l'organisation.
 *
 * Les modèles sont lus dans un explorateur : les dossiers groupent par
 * intention — « service Go », « conformité » — et l'arborescence montre la
 * forme réelle du dépôt que ces chemins produiront.
 */
export default async function TemplatesPage() {
  if (!(await api.me().catch(() => null))) redirect("/login");

  const [templates, folders] = await Promise.all([
    api.listTemplates().catch(() => []),
    api.listFolders().catch(() => []),
  ]);

  return (
    <>
      <PageHeader
        title="Modèles"
        description="Les fichiers que Kybers écrit dans vos dépôts. Groupez-les en dossiers pour les ajouter en bloc."
      />

      {templates.length === 0 && folders.length === 0 ? (
        <Card title="Modèles" icon={FileCode}>
          <EmptyState
            icon={FileCode}
            title="Aucun modèle"
            description="Créez un dossier pour regrouper les fichiers d'un même usage, ou un modèle isolé."
          >
            <FolderDialog />
            <TemplateDialog folders={folders} />
          </EmptyState>
        </Card>
      ) : (
        <TemplateExplorer templates={templates} folders={folders} />
      )}

      <Card title="Comment ils sont utilisés" icon={Info}>
        <div className="space-y-2 text-sm text-muted-foreground">
          <p>
            À la création d&apos;une application, vous cochez les fichiers à
            écrire. Un <strong className="text-foreground">dossier</strong>{" "}
            s&apos;ajoute d&apos;un seul geste, avec tout ce qu&apos;il contient.
          </p>
          <p>
            Un dossier de modèles n&apos;est pas un dossier du dépôt : il groupe
            par usage. C&apos;est le{" "}
            <strong className="text-foreground">chemin</strong> de chaque modèle
            qui décide de son emplacement — d&apos;où l&apos;arborescence
            ci-dessus.
          </p>
          <p>
            Les substitutions <code className="font-mono">{"{{app}}"}</code>,{" "}
            <code className="font-mono">{"{{repo}}"}</code>,{" "}
            <code className="font-mono">{"{{env}}"}</code> et{" "}
            <code className="font-mono">{"{{endpoint}}"}</code> sont remplacées à
            l&apos;écriture, dans le chemin comme dans le contenu.
          </p>
          <p>
            Modifier un modèle n&apos;affecte pas les dépôts déjà écrits : il
            sert de point de départ, pas de source de vérité.
          </p>
        </div>
      </Card>
    </>
  );
}
