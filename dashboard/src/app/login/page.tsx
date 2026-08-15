import { Boxes } from "lucide-react";
import { redirect } from "next/navigation";

import { api } from "@/lib/api";
import { LoginForm } from "@/components/auth-forms";
import { Card as ShadcnCard, CardContent } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string }>;
}) {
  const { mode } = await searchParams;

  // Une session déjà valide n'a rien à faire ici : le layout afficherait la
  // navigation autour d'un formulaire de connexion, ce qui donne l'impression
  // d'être à la fois connecté et déconnecté.
  const me = await api.me().catch(() => null);
  if (me) redirect("/");

  // L'auto-inscription ne sert qu'à créer le tout premier compte : au-delà, le
  // Control Plane la refuse. Inutile de proposer un formulaire condamné.
  const bootstrap = await api.needsBootstrap().catch(() => false);
  const register = mode === "register" && bootstrap;

  return (
    <main className="relative flex min-h-dvh flex-col items-center justify-center px-6 py-12">
      {/* Halo vert discret : rappelle l'accent de la marque sans gêner la
          lecture du formulaire. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 overflow-hidden"
      >
        <div className="absolute -top-40 left-1/2 size-[36rem] -translate-x-1/2 rounded-full bg-primary/8 blur-3xl" />
      </div>

      <div className="relative w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <Boxes className="size-6" />
          </div>
          <h1 className="mt-4 text-2xl font-semibold tracking-tight">Kybers</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            PaaS souverain sur Kubernetes
          </p>
        </div>

        <ShadcnCard>
          <CardContent className="py-6">
            <LoginForm register={register} bootstrap={bootstrap} />
          </CardContent>
        </ShadcnCard>
      </div>
    </main>
  );
}
