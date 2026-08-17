"use client";

import * as React from "react";
import { useMemo, useState } from "react";
import { Check, Copy, Lock, Search } from "lucide-react";

import type { OpenAPIOperation, OpenAPISchema, OpenAPISpec } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui";
import { cn } from "@/lib/utils";

/** Couleur par méthode : c'est le repère qu'on cherche en parcourant. */
const METHOD_STYLES: Record<string, string> = {
  get: "bg-chart-2/15 text-chart-2",
  post: "bg-success/15 text-success",
  put: "bg-chart-4/15 text-chart-4",
  patch: "bg-chart-4/15 text-chart-4",
  delete: "bg-destructive/15 text-destructive",
};

type Route = {
  method: string;
  path: string;
  op: OpenAPIOperation;
};

/**
 * Documentation de l'API, rendue depuis sa spécification.
 *
 * Un rendu maison plutôt qu'une bibliothèque : Swagger UI et ses équivalents
 * pèsent près d'un mégaoctet, imposent leur thème et se chargent souvent
 * depuis un CDN — trois frictions pour afficher une liste d'endpoints. Ce qui
 * manque en échange, c'est le « Try it out », qu'un jeton en clair dans le
 * navigateur rendait de toute façon discutable.
 */
export function ApiExplorer({
  spec,
  baseUrl,
}: {
  spec: OpenAPISpec;
  baseUrl: string;
}) {
  const [q, setQ] = useState("");

  const routes = useMemo<Route[]>(() => {
    const out: Route[] = [];
    for (const [path, methods] of Object.entries(spec.paths ?? {})) {
      for (const [method, op] of Object.entries(methods)) {
        out.push({ method, path, op });
      }
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }, [spec]);

  const needle = q.trim().toLowerCase();
  const shown = needle
    ? routes.filter((r) =>
        `${r.method} ${r.path} ${r.op.summary ?? ""}`
          .toLowerCase()
          .includes(needle),
      )
    : routes;

  // Groupées par domaine : parcourir 40 routes à plat ne mène nulle part.
  const groups = useMemo(() => {
    const map = new Map<string, Route[]>();
    for (const r of shown) {
      const tag = r.op.tags?.[0] ?? "Autres";
      map.set(tag, [...(map.get(tag) ?? []), r]);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [shown]);

  return (
    <div className="flex flex-col gap-6">
      <Card title="Appeler l'API" icon={Lock}>
        <div className="space-y-2 text-sm text-muted-foreground">
          <p>
            Les jetons se créent depuis{" "}
            <strong className="text-foreground">Jetons</strong> et s&apos;envoient
            en en-tête{" "}
            <code className="font-mono text-foreground">
              Authorization: Bearer &lt;jeton&gt;
            </code>
            .
          </p>
          <CopyLine
            text={`curl -H "Authorization: Bearer $KYBERS_TOKEN" ${baseUrl}/api/v1/apps`}
          />
          <p>
            La spécification complète est servie sur{" "}
            <a
              href={`${baseUrl}/api/v1/openapi.json`}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-primary underline-offset-2 hover:underline"
            >
              /api/v1/openapi.json
            </a>{" "}
            — exploitable par Postman, Bruno ou un générateur de client.
          </p>
        </div>
      </Card>

      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Rechercher un endpoint…"
          className="pl-9"
        />
      </div>

      {groups.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
          Aucun endpoint ne correspond à « {q} ».
        </p>
      ) : (
        groups.map(([tag, list]) => (
          <section key={tag} className="flex flex-col gap-2">
            <h2 className="text-sm font-medium">
              {tag}{" "}
              <span className="text-muted-foreground">({list.length})</span>
            </h2>
            <div className="flex flex-col gap-1.5">
              {list.map((r) => (
                <RouteRow
                  key={`${r.method} ${r.path}`}
                  route={r}
                  schemas={spec.components?.schemas ?? {}}
                />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}

/** Une route : repliée sur l'essentiel, dépliée sur son contrat. */
function RouteRow({
  route: r,
  schemas,
}: {
  route: Route;
  schemas: Record<string, OpenAPISchema>;
}) {
  const [open, setOpen] = useState(false);

  const body = r.op.requestBody?.content?.["application/json"]?.schema;
  const protectedRoute = Boolean(r.op.security?.length);

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/40"
      >
        <span
          className={cn(
            "shrink-0 rounded px-1.5 py-0.5 font-mono text-xs font-medium uppercase",
            METHOD_STYLES[r.method] ?? "bg-muted text-muted-foreground",
          )}
        >
          {r.method}
        </span>
        <span className="font-mono text-xs">{r.path}</span>
        {protectedRoute && (
          <Lock className="size-3 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate text-right text-xs text-muted-foreground">
          {r.op.summary}
        </span>
      </button>

      {open && (
        <div className="flex flex-col gap-3 border-t border-border px-3 py-3 text-xs">
          {r.op.summary && (
            <p className="text-muted-foreground">{r.op.summary}</p>
          )}

          {(r.op.parameters?.length ?? 0) > 0 && (
            <Section title="Paramètres de chemin">
              {r.op.parameters!.map((p) => (
                <li key={p.name} className="flex items-center gap-2">
                  <code className="font-mono text-foreground">{p.name}</code>
                  {p.required && <Badge variant="outline">requis</Badge>}
                </li>
              ))}
            </Section>
          )}

          {body?.properties && (
            <Section title="Corps de la requête">
              {Object.entries(body.properties).map(([name, prop]) => (
                <li key={name} className="flex items-center gap-2">
                  <code className="font-mono text-foreground">{name}</code>
                  <span className="text-muted-foreground">
                    {prop.type ?? "any"}
                  </span>
                </li>
              ))}
            </Section>
          )}

          <ResponseSchema op={r.op} schemas={schemas} />

          {Object.entries(r.op.responses ?? {}).length > 0 && (
            <Section title="Réponses">
              {Object.entries(r.op.responses!).map(([code, res]) => (
                <li key={code} className="flex items-center gap-2">
                  <code
                    className={cn(
                      "font-mono",
                      code.startsWith("2") ? "text-success" : "text-destructive",
                    )}
                  >
                    {code}
                  </code>
                  <span className="text-muted-foreground">
                    {res.description}
                  </span>
                </li>
              ))}
            </Section>
          )}
        </div>
      )}
    </div>
  );
}

/** Schéma de la réponse, résolu depuis les composants. */
function ResponseSchema({
  op,
  schemas,
}: {
  op: OpenAPIOperation;
  schemas: Record<string, OpenAPISchema>;
}) {
  const content = (
    op.responses?.["200"] as { content?: Record<string, { schema?: OpenAPISchema }> }
  )?.content?.["application/json"]?.schema;
  if (!content) return null;

  // Un tableau renvoie vers le schéma de ses éléments.
  const isList = content.type === "array";
  const ref = (isList ? content.items?.$ref : content.$ref) ?? "";
  const name = ref.split("/").pop() ?? "";
  const schema = schemas[name];
  if (!schema?.properties) return null;

  return (
    <Section title={`Réponse : ${name}${isList ? "[]" : ""}`}>
      {Object.entries(schema.properties).map(([field, prop]) => (
        <li key={field} className="flex items-center gap-2">
          <code className="font-mono text-foreground">{field}</code>
          <span className="text-muted-foreground">
            {prop.format ?? prop.type ?? "any"}
          </span>
          {schema.required?.includes(field) && (
            <span className="text-muted-foreground">toujours présent</span>
          )}
        </li>
      ))}
    </Section>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <p className="font-medium">{title}</p>
      <ul className="space-y-0.5 rounded-md border border-border bg-muted/30 p-2">
        {children}
      </ul>
    </div>
  );
}

/** Commande copiable : la recopier à la main invite aux fautes de frappe. */
function CopyLine({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
      <code className="min-w-0 flex-1 overflow-x-auto font-mono text-xs text-foreground">
        {text}
      </code>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Copier"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2000);
          } catch {
            // Presse-papiers refusé : la commande reste sélectionnable.
          }
        }}
        className="shrink-0 text-muted-foreground"
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
