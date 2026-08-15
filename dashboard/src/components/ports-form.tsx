"use client";

import { useActionState, useState } from "react";
import { Globe, Info, Lock, Plus, Save, Trash2, XCircle } from "lucide-react";

import { saveAppPortsAction, type ActionState } from "@/app/actions";
import type { AppPort } from "@/lib/api";
import { SubmitButton, Feedback } from "@/components/forms";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/** Nom Kubernetes valide : minuscules, chiffres et tirets, 15 caractères max. */
function sanitizeName(v: string) {
  return v
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 15);
}

/**
 * Ports ouverts par une application.
 *
 * Une image peut en ouvrir plusieurs — un port applicatif et un port de
 * métriques, par exemple. Tous deviennent joignables dans le cluster ; un seul
 * est routé par l'Ingress, l'hôte public ne pouvant désigner qu'une
 * destination.
 */
export function PortsForm({
  appId,
  ports: initial,
}: {
  appId: string;
  ports: AppPort[];
}) {
  const [ports, setPorts] = useState<AppPort[]>(
    initial.length > 0
      ? initial
      : [{ port: 8080, name: "http", exposed: true, protocol: "TCP" }],
  );
  const [state, action] = useActionState<ActionState, FormData>(
    saveAppPortsAction,
    null,
  );

  function update(i: number, patch: Partial<AppPort>) {
    setPorts((prev) => prev.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  }

  function expose(i: number) {
    // L'exposition est exclusive : cocher un port décoche les autres.
    setPorts((prev) => prev.map((p, j) => ({ ...p, exposed: j === i })));
  }

  function add() {
    setPorts((prev) => [
      ...prev,
      { port: 0, name: "", exposed: false, protocol: "TCP" },
    ]);
  }

  function remove(i: number) {
    setPorts((prev) => {
      const next = prev.filter((_, j) => j !== i);
      // Retirer le port public laisserait l'Ingress sans cible.
      if (next.length > 0 && !next.some((p) => p.exposed)) {
        next[0] = { ...next[0], exposed: true };
      }
      return next;
    });
  }

  const duplicates = new Set(
    ports
      .map((p) => p.port)
      .filter((port, i, all) => port > 0 && all.indexOf(port) !== i),
  );
  const invalid = ports.some((p) => p.port <= 0 || p.port > 65535);

  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="app_id" value={appId} />
      {/* Les lignes voyagent en JSON : un champ par port produirait des noms
          ambigus une fois postés. */}
      <input
        type="hidden"
        name="ports"
        value={JSON.stringify(
          ports
            .filter((p) => p.port > 0)
            .map((p) => ({
              ...p,
              name: sanitizeName(p.name) || `port-${p.port}`,
            })),
        )}
      />

      <div className="flex flex-col gap-2">
        {ports.map((p, i) => (
          <div
            key={i}
            className={cn(
              "flex flex-wrap items-end gap-3 rounded-lg border p-3",
              p.exposed ? "border-primary/40 bg-primary/5" : "border-border",
              duplicates.has(p.port) && "border-destructive/40",
            )}
          >
            <div className="space-y-1.5">
              <Label htmlFor={`port-${i}`}>Port</Label>
              <Input
                id={`port-${i}`}
                type="number"
                min={1}
                max={65535}
                value={p.port || ""}
                onChange={(e) =>
                  update(i, { port: Number(e.target.value) || 0 })
                }
                className="h-8 w-24 font-mono"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={`name-${i}`}>Nom</Label>
              <Input
                id={`name-${i}`}
                value={p.name}
                onChange={(e) => update(i, { name: e.target.value })}
                placeholder={`port-${p.port || "…"}`}
                className="h-8 w-36 font-mono"
              />
            </div>

            <div className="flex flex-1 items-center gap-2">
              {p.exposed ? (
                <Badge
                  variant="secondary"
                  className="gap-1 border-transparent bg-primary/15 text-primary"
                >
                  <Globe className="size-3" />
                  public
                </Badge>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => expose(i)}
                >
                  <Lock className="size-3" />
                  interne
                </Button>
              )}
            </div>

            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Retirer le port ${p.port}`}
              disabled={ports.length === 1}
              onClick={() => remove(i)}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        ))}
      </div>

      <div>
        <Button type="button" variant="outline" size="sm" onClick={add}>
          <Plus className="size-3.5" />
          Ajouter un port
        </Button>
      </div>

      {duplicates.size > 0 && (
        <p
          className="flex items-center gap-1.5 text-sm text-destructive"
          role="alert"
        >
          <XCircle className="size-3.5 shrink-0" />
          Port en double : {[...duplicates].join(", ")}
        </p>
      )}

      <p className="flex items-start gap-2 rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
        <Info className="mt-0.5 size-3.5 shrink-0" />
        Le port <strong className="text-foreground">public</strong> reçoit le
        trafic de l&apos;URL de l&apos;application et porte les sondes de santé.
        Les autres restent joignables depuis le cluster —
        <code className="font-mono"> {"<app>"}:{"<port>"}</code> — ce qui
        convient aux métriques ou à une API interne.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton
          label="Enregistrer les ports"
          pendingLabel="Enregistrement…"
          icon={Save}
          size="sm"
          variant="outline"
        />
        <Feedback state={state} />
      </div>

      {!invalid && duplicates.size === 0 && (
        <p className="text-xs text-muted-foreground">
          Les changements prennent effet au prochain déploiement.
        </p>
      )}
    </form>
  );
}
