"use server";

import { revalidatePath } from "next/cache";
import {
  api,
  parseEnvBlock,
  type AppConfig,
  type AppPort,
  type FileTemplate,
  type Probe,
} from "@/lib/api";
import { validatePath } from "@/lib/repo-path";

// Les Server Actions gardent l'API et son token côté serveur : le navigateur
// ne parle jamais directement au Control Plane.

export type ActionState =
  | {
      ok: boolean;
      message: string;
      /** Identifiant de la ressource créée, pour enchaîner sans la rechercher. */
      id?: string;
    }
  | null;

function ok(message: string): ActionState {
  return { ok: true, message };
}

function fail(e: unknown, fallback: string): ActionState {
  return { ok: false, message: e instanceof Error ? e.message : fallback };
}

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------

export async function createAppAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  // Le nom préfixe les namespaces Kubernetes : il doit en respecter la
  // syntaxe, quelle que soit la saisie.
  const name = String(formData.get("name") ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const gitRepo = String(formData.get("git_repo") ?? "").trim();
  const port = Number(formData.get("container_port") ?? 8080);
  // Ports secondaires : joignables dans le cluster, non routés par l'Ingress.
  const extraPorts = String(formData.get("extra_ports") ?? "")
    .split(/[,\s]+/)
    .map((v) => Number(v.trim()))
    .filter((n) => Number.isInteger(n) && n > 0 && n < 65536);

  if (!name) return { ok: false, message: "Le nom de l'application est requis." };

  try {
    const app = await api.createApp(name, gitRepo, port || 8080);

    // Écrits après la création : l'application doit exister pour porter ses
    // ports. Un refus ici ne doit pas annuler la création.
    if (extraPorts.length > 0) {
      const main = port || 8080;
      await api
        .setAppPorts(app.id, [
          { port: main, name: "http", exposed: true, protocol: "TCP" },
          ...extraPorts
            .filter((p) => p !== main)
            .map((p) => ({
              port: p,
              name: `port-${p}`,
              exposed: false,
              protocol: "TCP",
            })),
        ])
        .catch(() => {});
    }

    // Pas de revalidatePath ici : invalider le layout remonte l'arbre et
    // détruit l'état du parcours, refermant la modale avant l'étape
    // « pipeline ». La liste est rafraîchie à la sortie du parcours.
    return { ok: true, message: `Application « ${name} » créée.`, id: app.id };
  } catch (e) {
    return fail(e, "Échec de la création.");
  }
}

/** Supprime une application, environnements compris si demandé. */
export async function deleteAppAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const appId = String(formData.get("app_id") ?? "");
  const cascade = String(formData.get("cascade") ?? "") === "true";
  // Le dépôt n'est supprimé que sur demande explicite : c'est irréversible et
  // sans rapport avec le cycle de vie de l'application.
  const deleteRepo = String(formData.get("delete_repo") ?? "") === "true";

  try {
    const res = await api.deleteApp(appId, cascade, deleteRepo);
    // Pas de revalidatePath : la page courante décrit l'application
    // supprimée et la rejouer donnerait un 404 avant que la redirection
    // n'aboutisse. Le client navigue vers la liste, ce qui la rafraîchit.
    // 202 : l'agent nettoie le cluster, l'application partira ensuite.
    if (res?.pending_environments) {
      return ok(
        `Suppression de ${res.pending_environments} environnement(s) en cours ; l'application sera retirée une fois le cluster nettoyé.`,
      );
    }
    return ok(
      deleteRepo
        ? "Application et dépôt supprimés."
        : "Application supprimée.",
    );
  } catch (e) {
    return fail(e, "Échec de la suppression.");
  }
}

// ---------------------------------------------------------------------------
// Déploiement
// ---------------------------------------------------------------------------

/**
 * Déploie une image sans exiger qu'une application existe déjà.
 *
 * Une « application » ne porte qu'un nom et un port : la créer à la main avant
 * de pouvoir déployer était une étape vide. Ici elle est créée à la volée si
 * aucune ne porte le nom demandé, et réutilisée sinon.
 */
export async function deployImageAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const image = String(formData.get("image") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const environment = String(formData.get("environment") ?? "staging").trim();
  const port = Number(formData.get("container_port") ?? 8080);
  const replicas = Number(formData.get("replicas") ?? 1);
  const host = String(formData.get("host") ?? "").trim();
  const envRaw = String(formData.get("env") ?? "").trim();
  const secretsRaw = String(formData.get("secrets") ?? "").trim();
  // Origine du geste : « catalogue » quand il part d'une image du registry,
  // « dashboard » sinon. Le CI, lui, appelle l'API directement.
  const source = String(formData.get("source") ?? "dashboard").trim();
  // Ports secondaires : joignables dans le cluster, non routés par l'Ingress.
  const extraPorts = String(formData.get("extra_ports") ?? "")
    .split(/[,\s]+/)
    .map((v) => Number(v.trim()))
    .filter((n) => Number.isInteger(n) && n > 0 && n < 65536);

  if (!image) return { ok: false, message: "Image manquante." };
  if (!name) return { ok: false, message: "Le nom de l'application est requis." };

  try {
    const apps = await api.listApps();
    let app = apps.find((a) => a.name === name);
    let created = false;

    if (!app) {
      app = await api.createApp(name, "", port || 8080);
      created = true;
    }

    // Le port principal est public ; les autres restent internes. Écrit après
    // la création pour que l'application existe déjà.
    if (extraPorts.length > 0) {
      const main = port || app.container_port || 8080;
      await api
        .setAppPorts(app.id, [
          { port: main, name: "http", exposed: true, protocol: "TCP" },
          ...extraPorts
            .filter((p) => p !== main)
            .map((p) => ({
              port: p,
              name: `port-${p}`,
              exposed: false,
              protocol: "TCP",
            })),
        ])
        .catch(() => {
          // Un port refusé ne doit pas empêcher le déploiement : l'application
          // garde alors son port principal seul.
        });
    }

    // Les variables sont enregistrées avant le déploiement : l'agent les lira
    // au moment où le Control Plane lui transmettra l'ordre.
    const vars = parseEnvBlock(envRaw);
    if (Object.keys(vars).length > 0) {
      await api.setEnv(app.id, environment, vars);
    }
    const secrets = parseEnvBlock(secretsRaw);
    if (Object.keys(secrets).length > 0) {
      await api.setSecrets(app.id, environment, secrets);
    }

    const dep = await api.deploy(app.id, environment, image, replicas || 1, host, source);
    revalidatePath("/", "layout");
    return ok(
      created
        ? `Application « ${name} » créée et déploiement rev${dep.revision} lancé sur « ${environment} ».`
        : `Déploiement rev${dep.revision} lancé sur « ${environment} ».`,
    );
  } catch (e) {
    return fail(e, "Échec du déploiement.");
  }
}

// ---------------------------------------------------------------------------
// Cycle de vie
// ---------------------------------------------------------------------------

/** Une seule action pour tous les boutons de pilotage d'un déploiement. */
export async function lifecycleAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const id = String(formData.get("deployment_id") ?? "");
  const action = String(formData.get("action") ?? "");
  if (!id) return { ok: false, message: "Déploiement non précisé." };

  try {
    switch (action) {
      case "scale": {
        const replicas = Number(formData.get("replicas") ?? 1);
        if (replicas < 0) return { ok: false, message: "Nombre de replicas invalide." };
        await api.scale(id, replicas);
        revalidatePath("/", "layout");
        return ok(`Mise à l'échelle à ${replicas} replica(s) demandée.`);
      }
      case "stop":
        await api.stop(id);
        revalidatePath("/", "layout");
        return ok("Arrêt demandé (configuration conservée).");
      case "start": {
        const replicas = Number(formData.get("replicas") ?? 1);
        await api.start(id, replicas || 1);
        revalidatePath("/", "layout");
        return ok("Redémarrage demandé.");
      }
      case "restart":
        await api.restart(id);
        revalidatePath("/", "layout");
        return ok("Rolling restart déclenché.");
      case "rollback": {
        const dep = await api.rollback(id);
        revalidatePath("/", "layout");
        return ok(`Rollback lancé — nouvelle révision ${dep.revision}.`);
      }
      case "delete":
        await api.remove(id, false);
        revalidatePath("/", "layout");
        return ok("Suppression de l'application demandée.");
      case "delete-namespace":
        await api.remove(id, true);
        revalidatePath("/", "layout");
        return ok("Suppression de l'environnement complet demandée.");
      case "follow-logs":
        await api.followLogs(id, true);
        revalidatePath("/", "layout");
        return ok("Suivi des logs démarré.");
      case "unfollow-logs":
        await api.followLogs(id, false);
        revalidatePath("/", "layout");
        return ok("Suivi des logs arrêté.");
      default:
        return { ok: false, message: `Action inconnue : ${action}` };
    }
  } catch (e) {
    return fail(e, "L'action a échoué.");
  }
}

// ---------------------------------------------------------------------------
// Configuration d'exécution
// ---------------------------------------------------------------------------

/** Reconstruit une sonde depuis les champs du formulaire, ou null si désactivée. */
function probeFromForm(formData: FormData, prefix: string): Probe | null {
  const type = String(formData.get(`${prefix}_type`) ?? "none");
  if (type === "none" || type === "") return null;

  const num = (name: string) => {
    const v = Number(formData.get(`${prefix}_${name}`) ?? 0);
    return Number.isFinite(v) && v > 0 ? v : undefined;
  };

  const probe: Probe = {
    type: type as Probe["type"],
    path: String(formData.get(`${prefix}_path`) ?? "").trim() || undefined,
    port: num("port"),
    initial_delay_seconds: num("initial_delay"),
    period_seconds: num("period"),
    timeout_seconds: num("timeout"),
    failure_threshold: num("failure_threshold"),
  };

  if (type === "exec") {
    const cmd = String(formData.get(`${prefix}_command`) ?? "").trim();
    probe.command = cmd ? cmd.split(/\s+/) : undefined;
  }
  return probe;
}

export async function saveConfigAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const appId = String(formData.get("app_id") ?? "");
  const environment = String(formData.get("environment") ?? "").trim();
  if (!appId || !environment) {
    return { ok: false, message: "Application ou environnement manquant." };
  }

  const registryId = String(formData.get("registry_id") ?? "").trim();
  const str = (n: string, d = "") => String(formData.get(n) ?? d).trim();
  const int = (n: string, d = 0) => {
    const v = Number(formData.get(n) ?? d);
    return Number.isFinite(v) ? v : d;
  };
  const bool = (n: string) => formData.get(n) === "on" || formData.get(n) === "true";

  const cfg: Partial<AppConfig> & { environment: string } = {
    environment,
    registry_id: registryId || null,
    cpu_request: str("cpu_request", "50m"),
    memory_request: str("memory_request", "64Mi"),
    cpu_limit: str("cpu_limit", "500m"),
    memory_limit: str("memory_limit", "512Mi"),
    autoscaling_enabled: bool("autoscaling_enabled"),
    autoscaling_min: int("autoscaling_min", 1),
    autoscaling_max: int("autoscaling_max", 5),
    autoscaling_cpu_percent: int("autoscaling_cpu_percent", 80),
    liveness_probe: probeFromForm(formData, "liveness"),
    readiness_probe: probeFromForm(formData, "readiness"),
    startup_probe: probeFromForm(formData, "startup"),
    network_policy: bool("network_policy"),
    quota_cpu: str("quota_cpu"),
    quota_memory: str("quota_memory"),
    quota_pods: int("quota_pods", 0),
    run_as_non_root: bool("run_as_non_root"),
    run_as_user: int("run_as_user", 0),
    read_only_root_fs: bool("read_only_root_fs"),
  };

  try {
    await api.setConfig(appId, cfg);
    revalidatePath("/", "layout");
    return ok(`Configuration « ${environment} » enregistrée.`);
  } catch (e) {
    return fail(e, "Échec de l'enregistrement.");
  }
}

// ---------------------------------------------------------------------------
// Variables et secrets
// ---------------------------------------------------------------------------

export async function saveVarsAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const appId = String(formData.get("app_id") ?? "");
  const environment = String(formData.get("environment") ?? "").trim();
  const kind = String(formData.get("kind") ?? "env");
  const raw = String(formData.get("vars") ?? "").trim();

  if (!appId || !environment) {
    return { ok: false, message: "Application ou environnement manquant." };
  }

  const vars = parseEnvBlock(raw);
  if (Object.keys(vars).length === 0) {
    return { ok: false, message: "Aucune paire KEY=VALUE valide." };
  }

  try {
    if (kind === "secret") {
      await api.setSecrets(appId, environment, vars);
    } else {
      await api.setEnv(appId, environment, vars);
    }
    revalidatePath("/", "layout");
    return ok(
      `${Object.keys(vars).length} ${kind === "secret" ? "secret(s)" : "variable(s)"} enregistré(s).`,
    );
  } catch (e) {
    return fail(e, "Échec de l'enregistrement.");
  }
}

export async function deleteVarAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const appId = String(formData.get("app_id") ?? "");
  const environment = String(formData.get("environment") ?? "");
  const key = String(formData.get("key") ?? "");
  const kind = String(formData.get("kind") ?? "env");

  try {
    if (kind === "secret") {
      await api.deleteSecret(appId, environment, key);
    } else {
      await api.deleteEnv(appId, environment, key);
    }
    revalidatePath("/", "layout");
    return ok(`« ${key} » supprimé.`);
  } catch (e) {
    return fail(e, "Échec de la suppression.");
  }
}

// ---------------------------------------------------------------------------
// Registries
// ---------------------------------------------------------------------------

export async function createRegistryAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const name = String(formData.get("name") ?? "").trim();
  const server = String(formData.get("server") ?? "").trim();
  const username = String(formData.get("username") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const email = String(formData.get("email") ?? "").trim();

  if (!name || !server || !username || !password) {
    return { ok: false, message: "Nom, serveur, identifiant et mot de passe sont requis." };
  }

  try {
    // Validation préalable : mieux vaut un message clair maintenant qu'un
    // ImagePullBackOff au premier déploiement.
    const test = await api.testRegistry({ server, username, password });
    if (!test.ok) {
      return { ok: false, message: test.message };
    }

    await api.createRegistry({ name, server, username, password, email });
    revalidatePath("/", "layout");
    return ok(
      test.checked
        ? `Registry « ${name} » connecté et enregistré.`
        : `Registry « ${name} » enregistré (identifiants non vérifiables pour ce serveur).`,
    );
  } catch (e) {
    return fail(e, "Échec de l'enregistrement du registry.");
  }
}

export async function deleteRegistryAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const id = String(formData.get("registry_id") ?? "");
  try {
    await api.deleteRegistry(id);
    revalidatePath("/", "layout");
    return ok("Registry supprimé.");
  } catch (e) {
    return fail(e, "Échec de la suppression.");
  }
}

// ---------------------------------------------------------------------------
// Clusters
// ---------------------------------------------------------------------------

/**
 * Enregistre un cluster et retourne son jeton.
 *
 * Le jeton n'est lisible qu'ici : il est nécessaire pour installer l'agent et
 * n'est plus jamais exposé ensuite par l'API.
 */
export type ClusterState =
  | {
      ok: boolean;
      message: string;
      token?: string;
      clusterName?: string;
      /** Commande d'installation prête à coller, jeton inclus. */
      installCommand?: string;
    }
  | null;

export async function createClusterAction(
  _prev: ClusterState,
  formData: FormData,
): Promise<ClusterState> {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { ok: false, message: "Le nom du cluster est requis." };

  try {
    const res = await api.createCluster(name);
    revalidatePath("/", "layout");
    return {
      ok: true,
      message: `Cluster « ${name} » enregistré.`,
      token: res.token,
      clusterName: name,
      installCommand: res.install_command,
    };
  } catch (e) {
    const f = fail(e, "Échec de l'enregistrement du cluster.");
    return f ?? { ok: false, message: "Échec de l'enregistrement du cluster." };
  }
}

export async function deleteClusterAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const id = String(formData.get("cluster_id") ?? "");
  try {
    await api.deleteCluster(id);
    revalidatePath("/", "layout");
    return ok("Cluster supprimé.");
  } catch (e) {
    return fail(e, "Échec de la suppression.");
  }
}

/** Change la source des métriques d'un cluster (metrics-server / Prometheus). */
export async function setMetricsSourceAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const clusterId = String(formData.get("cluster_id") ?? "");
  const source = String(formData.get("source") ?? "");
  if (!clusterId) return { ok: false, message: "Cluster non précisé." };

  try {
    const res = await api.setMetricsSource(clusterId, source);
    revalidatePath("/", "layout");

    const label = source === "" ? "automatique" : source;
    return ok(
      res.applied
        ? `Source des métriques : ${label}.`
        : `Source enregistrée (${label}) — sera appliquée à la reconnexion de l'agent.`,
    );
  } catch (e) {
    return fail(e, "Échec du changement de source.");
  }
}

/**
 * Remplace les ports d'une application.
 *
 * La prise d'effet demande un nouveau déploiement : le Service et le
 * Deployment ne sont reconstruits que par l'agent.
 */
export async function saveAppPortsAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const appId = String(formData.get("app_id") ?? "");
  const raw = String(formData.get("ports") ?? "[]");

  let ports: AppPort[];
  try {
    ports = JSON.parse(raw) as AppPort[];
  } catch {
    return { ok: false, message: "Ports illisibles." };
  }

  if (ports.length === 0) {
    return { ok: false, message: "Au moins un port est requis." };
  }

  try {
    await api.setAppPorts(appId, ports);
    revalidatePath("/", "layout");
    return ok(
      "Ports enregistrés. Déployez une nouvelle révision pour les appliquer.",
    );
  } catch (e) {
    return fail(e, "Échec de l'enregistrement des ports.");
  }
}

/** Rattache — ou détache — un dépôt Git à une application. */
export async function setAppRepoAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const appId = String(formData.get("app_id") ?? "");
  const repo = String(formData.get("repo") ?? "").trim();

  try {
    const res = await api.setAppRepo(appId, repo);
    revalidatePath("/", "layout");
    return ok(
      res.repo
        ? `Dépôt « ${res.repo} » rattaché.`
        : "Dépôt détaché de l'application.",
    );
  } catch (e) {
    return fail(e, "Échec du rattachement.");
  }
}

// ---------------------------------------------------------------------------
// Intégration Git
// ---------------------------------------------------------------------------

export type GitProbeState =
  | {
      ok: boolean;
      message: string;
      /** Référence normalisée du dépôt, à rattacher à l'application. */
      repo?: string;
      url?: string;
      language?: string;
      /** Vrai quand le dépôt vient d'être créé par cette action. */
      created?: boolean;
    }
  | null;

/**
 * Vérifie qu'un dépôt existe, ou le crée.
 *
 * Les deux gestes partagent une action : le stepper les propose côte à côte et
 * l'utilisateur bascule de l'un à l'autre sans quitter l'étape.
 */
export async function gitProbeAction(
  _prev: GitProbeState,
  formData: FormData,
): Promise<GitProbeState> {
  const mode = String(formData.get("mode") ?? "link");
  const owner = String(formData.get("owner") ?? "").trim();
  const name = String(formData.get("repo_name") ?? "").trim();
  const repo = String(formData.get("repo") ?? "").trim();

  try {
    if (mode === "create") {
      if (!name) return { ok: false, message: "Nommez le dépôt à créer." };
      const created = await api.gitCreateRepo({
        owner,
        name,
        description: String(formData.get("description") ?? "").trim(),
        private: String(formData.get("private") ?? "") === "true",
      });
      return {
        ok: true,
        message: `Dépôt « ${created.full_name} » créé.`,
        repo: created.full_name,
        url: created.html_url,
        language: created.language,
        created: true,
      };
    }

    if (!repo) return { ok: false, message: "Indiquez un dépôt." };
    const found = await api.gitLookup(repo);
    return {
      ok: true,
      message: `Dépôt « ${found.full_name} » trouvé.`,
      repo: found.full_name,
      url: found.html_url,
      language: found.language,
    };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : "Dépôt introuvable.",
    };
  }
}

/**
 * Enregistre le jeton Git de l'instance.
 *
 * Le jeton est vérifié auprès de l'hébergeur avant d'être conservé : un jeton
 * refusé laisserait croire l'intégration active sans que rien ne fonctionne.
 */
export async function setGitSettingsAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const token = String(formData.get("token") ?? "").trim();
  const apiUrl = String(formData.get("api_url") ?? "").trim();

  try {
    const status = await api.setGitSettings(token, apiUrl);
    revalidatePath("/", "layout");
    if (!token) return ok("Intégration Git désactivée.");
    return ok(`Connecté à GitHub en tant que ${status.login ?? "—"}.`);
  } catch (e) {
    return fail(e, "Jeton refusé.");
  }
}

/**
 * Installe le workflow de déploiement dans le dépôt.
 *
 * Kybers écrit le fichier et dépose le jeton en secret : sans lui, le workflow
 * échouerait à son premier déclenchement.
 */
export async function installWorkflowAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const repo = String(formData.get("repo") ?? "").trim();
  const content = String(formData.get("content") ?? "");
  const path = String(formData.get("path") ?? "").trim();
  const appName = String(formData.get("app_name") ?? "").trim();

  if (!repo) return { ok: false, message: "Aucun dépôt rattaché." };
  if (!content.trim()) return { ok: false, message: "Le workflow est vide." };

  try {
    const res = await api.gitInstallWorkflow({
      repo,
      path: path || undefined,
      content,
      token_name: `ci-${appName || "kybers"}`,
    });
    // Pas de revalidatePath : cette action est appelée depuis le parcours de
    // création, qu'un remontage de l'arbre refermerait.
    return ok(
      `Workflow écrit dans ${res.repo} (${res.path})${res.secret ? " et jeton déposé en secret" : ""}.`,
    );
  } catch (e) {
    return fail(e, "Échec de l'installation du workflow.");
  }
}

/** Écrit un fichier de documentation dans le dépôt rattaché. */
export async function writeRepoFileAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const repo = String(formData.get("repo") ?? "").trim();
  const path = String(formData.get("path") ?? "").trim() || "README.md";
  const content = String(formData.get("content") ?? "");

  if (!repo) return { ok: false, message: "Aucun dépôt rattaché." };
  if (!content.trim()) return { ok: false, message: "Le contenu est vide." };

  try {
    const res = await api.gitWriteFile({ repo, path, content });
    // Pas de revalidatePath : cette action est appelée depuis le parcours de
    // création, qu'un remontage de l'arbre refermerait.
    return ok(`${res.path} écrit dans ${res.repo}.`);
  } catch (e) {
    return fail(e, "Échec de l'écriture.");
  }
}

// ---------------------------------------------------------------------------
// Modèles de fichiers
// ---------------------------------------------------------------------------

/** Crée ou renomme un dossier de modèles. */
export async function saveFolderAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const id = String(formData.get("id") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();

  if (!name) return { ok: false, message: "Nommez ce dossier." };

  try {
    const saved = await api.saveFolder({ id: id || undefined, name, description });
    revalidatePath("/", "layout");
    return { ok: true, message: `Dossier « ${saved.name} » enregistré.`, id: saved.id };
  } catch (e) {
    return fail(e, "Échec de l'enregistrement.");
  }
}

/** Supprime un dossier ; ses modèles retournent à la racine. */
export async function deleteFolderAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const id = String(formData.get("id") ?? "");

  try {
    await api.deleteFolder(id);
    revalidatePath("/", "layout");
    return ok("Dossier supprimé ; ses modèles sont revenus à la racine.");
  } catch (e) {
    return fail(e, "Échec de la suppression.");
  }
}

/** Crée ou met à jour un modèle de fichier. */
export async function saveTemplateAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const id = String(formData.get("id") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const path = String(formData.get("path") ?? "").trim();
  const kind = String(formData.get("kind") ?? "fichier").trim();
  const content = String(formData.get("content") ?? "");
  const description = String(formData.get("description") ?? "").trim();
  const isDefault = String(formData.get("is_default") ?? "") === "true";
  const folderId = String(formData.get("folder_id") ?? "").trim();

  if (!name) return { ok: false, message: "Nommez ce modèle." };
  if (!path) return { ok: false, message: "Indiquez le chemin de destination." };

  try {
    const saved = await api.saveTemplate({
      id: id || undefined,
      name,
      path,
      kind: kind as "pipeline" | "readme" | "fichier",
      content,
      description,
      is_default: isDefault,
      folder_id: folderId || undefined,
    });
    revalidatePath("/", "layout");
    return { ok: true, message: `Modèle « ${saved.name} » enregistré.`, id: saved.id };
  } catch (e) {
    return fail(e, "Échec de l'enregistrement.");
  }
}

/**
 * Déplace un modèle vers un autre dossier du dépôt.
 *
 * Seul le chemin change. Le modèle complet est fourni par l'appelant, qui l'a
 * déjà en main : `SaveTemplate` met à jour toutes les colonnes, si bien qu'un
 * champ omis serait écrasé par une valeur vide.
 */
export async function moveTemplateAction(
  template: FileTemplate,
  path: string,
): Promise<ActionState> {
  const clean = path.trim();
  if (!clean) return { ok: false, message: "Chemin de destination vide." };

  const invalid = validatePath(clean);
  if (invalid) return { ok: false, message: invalid };

  try {
    await api.saveTemplate({ ...template, path: clean });
    revalidatePath("/", "layout");
    return { ok: true, message: `Déplacé vers ${clean}.` };
  } catch (e) {
    return fail(e, "Échec du déplacement.");
  }
}

/** Supprime un modèle. */
export async function deleteTemplateAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const id = String(formData.get("id") ?? "");

  try {
    await api.deleteTemplate(id);
    revalidatePath("/", "layout");
    return ok("Modèle supprimé.");
  } catch (e) {
    return fail(e, "Échec de la suppression.");
  }
}

/**
 * Écrit les fichiers choisis dans le dépôt.
 *
 * Les substitutions sont appliquées ici : un même modèle sert toutes les
 * applications, le contenu n'est spécialisé qu'à l'écriture.
 */
export async function writeRepoFilesAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const repo = String(formData.get("repo") ?? "").trim();
  const raw = String(formData.get("files") ?? "[]");
  const needsToken = String(formData.get("needs_token") ?? "") === "true";
  const appName = String(formData.get("app_name") ?? "").trim();

  if (!repo) return { ok: false, message: "Aucun dépôt rattaché." };

  let files: { path: string; content: string }[];
  try {
    files = JSON.parse(raw) as { path: string; content: string }[];
  } catch {
    return { ok: false, message: "Fichiers illisibles." };
  }
  if (files.length === 0) return ok("Aucun fichier à créer.");

  try {
    const res = await api.gitWriteFiles({
      repo,
      files,
      token_name: needsToken ? `ci-${appName || "kybers"}` : undefined,
    });

    const failed = Object.entries(res.failures ?? {});
    if (failed.length > 0) {
      // Un échec partiel doit se voir : les fichiers écrits le restent.
      return {
        ok: false,
        message: `${res.written.length} fichier(s) écrit(s). Échec sur ${failed
          .map(([p, e]) => `${p} (${e})`)
          .join(", ")}`,
      };
    }
    return ok(
      `${res.written.length} fichier(s) écrit(s) dans ${res.repo}${res.secret ? ", jeton déposé en secret" : ""}.`,
    );
  } catch (e) {
    return fail(e, "Échec de l'écriture.");
  }
}
