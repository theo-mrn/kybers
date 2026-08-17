import { redirect } from "next/navigation";
import { BookOpen, Lock } from "lucide-react";

import { api, publicApiUrl, type OpenAPISpec } from "@/lib/api";
import { ApiExplorer } from "@/components/api-explorer";
import { Card, EmptyState, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * Documentation de l'API du plan de contrôle.
 *
 * La spécification est produite par le serveur à partir de sa table de
 * routage : elle ne peut décrire que ce qui existe. Une documentation
 * maintenue à part se serait périmée en quelques semaines.
 */
export default async function ApiDocPage() {
  if (!(await api.me().catch(() => null))) redirect("/login");

  const spec = await api.openapi().catch(() => null);

  return (
    <>
      <PageHeader
        title="API"
        description="Ce que le plan de contrôle expose, tel qu'il le sert. Utile pour appeler Kybers depuis un script ou une pipeline."
      />

      {spec ? (
        <ApiExplorer spec={spec as OpenAPISpec} baseUrl={publicApiUrl} />
      ) : (
        <Card title="API" icon={BookOpen}>
          <EmptyState
            icon={Lock}
            title="Spécification indisponible"
            description="Le plan de contrôle n'a pas répondu. Vérifiez qu'il est joignable depuis le dashboard."
          />
        </Card>
      )}
    </>
  );
}
