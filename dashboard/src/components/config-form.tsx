"use client";

import { useActionState, useState } from "react";
import { saveConfigAction, type ActionState } from "@/app/actions";
import type { AppConfig, Probe, Registry } from "@/lib/api";
import { inputClass, labelClass } from "@/components/ui";
import { SubmitButton, Feedback } from "@/components/forms";

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <fieldset className="rounded-lg border border-border p-4">
      <legend className="px-2 text-xs font-semibold text-muted-foreground">
        {title}
      </legend>
      {hint ? <p className="mb-3 text-xs text-muted-foreground">{hint}</p> : null}
      {children}
    </fieldset>
  );
}

function Checkbox({
  name,
  label,
  defaultChecked,
  hint,
}: {
  name: string;
  label: string;
  defaultChecked?: boolean;
  hint?: string;
}) {
  return (
    <label className="flex items-start gap-2.5 text-sm">
      <input
        type="checkbox"
        name={name}
        defaultChecked={defaultChecked}
        className="mt-0.5 h-4 w-4 accent-current"
      />
      <span>
        {label}
        {hint ? <span className="block text-xs text-muted-foreground">{hint}</span> : null}
      </span>
    </label>
  );
}

/** Bloc de configuration d'une sonde ; les champs se masquent si désactivée. */
function ProbeFields({
  prefix,
  title,
  probe,
  hint,
}: {
  prefix: string;
  title: string;
  probe?: Probe | null;
  hint: string;
}) {
  const [type, setType] = useState(probe?.type && probe.type !== "none" ? probe.type : "none");

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">{title}</p>
          <p className="text-xs text-muted-foreground">{hint}</p>
        </div>
        <select
          name={`${prefix}_type`}
          value={type}
          onChange={(e) => setType(e.target.value as Probe["type"])}
          className="h-9 rounded-md border border-input bg-transparent px-2 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40"
        >
          <option value="none">désactivée</option>
          <option value="http">HTTP</option>
          <option value="tcp">TCP</option>
          <option value="exec">exec</option>
        </select>
      </div>

      {type !== "none" && (
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          {type === "http" && (
            <div className="sm:col-span-2">
              <label className={labelClass}>Chemin</label>
              <input
                name={`${prefix}_path`}
                defaultValue={probe?.path ?? "/"}
                placeholder="/healthz"
                className={inputClass}
              />
            </div>
          )}
          {type === "exec" && (
            <div className="sm:col-span-3">
              <label className={labelClass}>Commande</label>
              <input
                name={`${prefix}_command`}
                defaultValue={probe?.command?.join(" ") ?? ""}
                placeholder="cat /tmp/ready"
                className={`${inputClass} font-mono`}
              />
            </div>
          )}
          {type !== "exec" && (
            <div>
              <label className={labelClass}>Port</label>
              <input
                name={`${prefix}_port`}
                type="number"
                min={0}
                defaultValue={probe?.port ?? 0}
                placeholder="0 = port du conteneur"
                className={inputClass}
              />
            </div>
          )}
          <div>
            <label className={labelClass}>Délai initial (s)</label>
            <input
              name={`${prefix}_initial_delay`}
              type="number"
              min={0}
              defaultValue={probe?.initial_delay_seconds ?? 0}
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>Période (s)</label>
            <input
              name={`${prefix}_period`}
              type="number"
              min={0}
              defaultValue={probe?.period_seconds ?? 10}
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>Timeout (s)</label>
            <input
              name={`${prefix}_timeout`}
              type="number"
              min={0}
              defaultValue={probe?.timeout_seconds ?? 1}
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>Seuil d&apos;échec</label>
            <input
              name={`${prefix}_failure_threshold`}
              type="number"
              min={0}
              defaultValue={probe?.failure_threshold ?? 3}
              className={inputClass}
            />
          </div>
        </div>
      )}
    </div>
  );
}

export function ConfigForm({
  appId,
  environment,
  config,
  registries,
}: {
  appId: string;
  environment: string;
  config: AppConfig;
  registries: Registry[];
}) {
  const [state, action] = useActionState<ActionState, FormData>(saveConfigAction, null);

  return (
    <form action={action} className="flex flex-col gap-5">
      <input type="hidden" name="app_id" value={appId} />
      <input type="hidden" name="environment" value={environment} />

      <Section
        title="Registry"
        hint="Nécessaire uniquement pour les images privées. Sans registry, seules les images publiques sont accessibles."
      >
        <select
          name="registry_id"
          defaultValue={config.registry_id ?? ""}
          className={inputClass}
        >
          <option value="">Aucun (images publiques)</option>
          {registries.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name} — {r.server}
            </option>
          ))}
        </select>
      </Section>

      <Section title="Ressources" hint="Format Kubernetes : 100m, 1, 256Mi, 1Gi.">
        <div className="grid gap-3 sm:grid-cols-4">
          <div>
            <label className={labelClass}>CPU demandé</label>
            <input name="cpu_request" defaultValue={config.cpu_request} className={inputClass} />
          </div>
          <div>
            <label className={labelClass}>Mémoire demandée</label>
            <input
              name="memory_request"
              defaultValue={config.memory_request}
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>Limite CPU</label>
            <input name="cpu_limit" defaultValue={config.cpu_limit} className={inputClass} />
          </div>
          <div>
            <label className={labelClass}>Limite mémoire</label>
            <input
              name="memory_limit"
              defaultValue={config.memory_limit}
              className={inputClass}
            />
          </div>
        </div>
      </Section>

      <Section
        title="Sondes de santé"
        hint="Sans readiness probe, un pod est déclaré prêt dès son démarrage, même si l'application ne répond pas encore."
      >
        <div className="flex flex-col gap-3">
          <ProbeFields
            prefix="readiness"
            title="Readiness"
            hint="Le pod reçoit-il du trafic ?"
            probe={config.readiness_probe}
          />
          <ProbeFields
            prefix="liveness"
            title="Liveness"
            hint="Le pod doit-il être redémarré ?"
            probe={config.liveness_probe}
          />
          <ProbeFields
            prefix="startup"
            title="Startup"
            hint="Démarrage lent : suspend les autres sondes."
            probe={config.startup_probe}
          />
        </div>
      </Section>

      <Section
        title="Autoscaling"
        hint="Nécessite metrics-server dans le cluster. Désactivé, le nombre de replicas reste fixe."
      >
        <div className="flex flex-col gap-3">
          <Checkbox
            name="autoscaling_enabled"
            label="Activer l'autoscaling horizontal"
            defaultChecked={config.autoscaling_enabled}
          />
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label className={labelClass}>Replicas min</label>
              <input
                name="autoscaling_min"
                type="number"
                min={1}
                defaultValue={config.autoscaling_min}
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass}>Replicas max</label>
              <input
                name="autoscaling_max"
                type="number"
                min={1}
                defaultValue={config.autoscaling_max}
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass}>Cible CPU (%)</label>
              <input
                name="autoscaling_cpu_percent"
                type="number"
                min={1}
                max={100}
                defaultValue={config.autoscaling_cpu_percent}
                className={inputClass}
              />
            </div>
          </div>
        </div>
      </Section>

      <Section title="Isolation du namespace">
        <div className="flex flex-col gap-3">
          <Checkbox
            name="network_policy"
            label="NetworkPolicy"
            hint="Seuls l'ingress-controller et les pods du même namespace peuvent joindre l'application."
            defaultChecked={config.network_policy}
          />
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label className={labelClass}>Quota CPU</label>
              <input
                name="quota_cpu"
                defaultValue={config.quota_cpu}
                placeholder="4"
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass}>Quota mémoire</label>
              <input
                name="quota_memory"
                defaultValue={config.quota_memory}
                placeholder="8Gi"
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass}>Quota pods</label>
              <input
                name="quota_pods"
                type="number"
                min={0}
                defaultValue={config.quota_pods}
                className={inputClass}
              />
            </div>
          </div>
        </div>
      </Section>

      <Section
        title="Durcissement du conteneur"
        hint="Désactivé par défaut : la plupart des images publiques (nginx, postgres, redis) démarrent en root et échoueraient. À activer pour vos propres images."
      >
        <div className="flex flex-col gap-3">
          <Checkbox
            name="run_as_non_root"
            label="Interdire l'exécution en root"
            hint="Retire aussi toutes les capabilities Linux."
            defaultChecked={config.run_as_non_root}
          />
          <Checkbox
            name="read_only_root_fs"
            label="Système de fichiers racine en lecture seule"
            hint="Incompatible avec les images qui écrivent dans /tmp sans volume."
            defaultChecked={config.read_only_root_fs}
          />
          <div className="sm:w-1/3">
            <label className={labelClass}>UID forcé (0 = image)</label>
            <input
              name="run_as_user"
              type="number"
              min={0}
              defaultValue={config.run_as_user}
              className={inputClass}
            />
          </div>
        </div>
      </Section>

      <div className="flex items-center gap-3">
        <SubmitButton
          label="Enregistrer la configuration"
          pendingLabel="Enregistrement…"
          variant="default"
        />
        <Feedback state={state} />
      </div>
      <p className="text-xs text-muted-foreground">
        La configuration s&apos;applique au prochain déploiement de cet environnement.
      </p>
    </form>
  );
}
