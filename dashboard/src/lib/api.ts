// Client de l'API Control Plane. Utilisé exclusivement côté serveur
// (Server Components et Server Actions) : le token n'atteint jamais le navigateur.

export type App = {
  id: string;
  name: string;
  git_repo: string;
  /** Port principal, celui que route l'Ingress. */
  container_port: number;
  /** Ports ouverts par l'image ; un seul est exposé publiquement. */
  ports?: AppPort[];
  created_at: string;
};

export type AppPort = {
  port: number;
  /** Nom Kubernetes (http, metrics, grpc…), cible possible des probes. */
  name: string;
  /** Port routé par l'Ingress. Au plus un par application. */
  exposed: boolean;
  protocol: string;
};

export type DeploymentStatus =
  | "pending"
  | "dispatched"
  | "provisioning"
  | "running"
  | "failed"
  | "stopped"
  | "deleted";

export type Deployment = {
  id: string;
  app_id: string;
  app_name?: string;
  environment: string;
  image: string;
  replicas: number;
  host: string;
  status: DeploymentStatus;
  message: string;
  /** Cause technique d'un échec : ImagePullBackOff, CrashLoopBackOff... */
  reason?: string;
  url: string;
  /** Numéro de révision, unique par (application, environnement). */
  revision: number;
  /** Renseigné quand ce déploiement est un retour à une révision antérieure. */
  rolled_back_from?: string | null;

  // Provenance, renseignée par le CI appelant : Kybers ne construit pas les
  // images, il ne peut donc pas la déduire.
  /** Commit à partir duquel l'image a été construite. */
  git_commit?: string;
  /** Branche ou tag Git. */
  git_ref?: string;
  /** Message du commit. */
  git_message?: string;
  /** Origine : « ci », « cli », « dashboard », « rollback ». */
  source?: string;

  created_at: string;
  updated_at: string;
};

export type LogLine = { pod_name: string; line: string; ts: string };

export type Event = {
  pod_name: string;
  type: string;
  reason: string;
  message: string;
  ts: string;
};

export type Cluster = {
  id: string;
  name: string;
  connected: boolean;
  last_seen?: string | null;
};

export type NodeInfo = {
  name: string;
  ready: boolean;
  role: string;
  architecture: string;
  os_image: string;
  kubelet_version: string;
  internal_ip: string;
  cpu_capacity: string;
  memory_capacity: string;
  pressures?: string[] | null;
};

export type ClusterInfo = {
  k8s_version: string;
  platform: string;
  node_count: number;
  nodes_ready: number;
  nodes: NodeInfo[];
  total_cpu: string;
  total_memory: string;
  has_metrics_server: boolean;
  has_cert_manager: boolean;
  ingress_classes?: string[] | null;
  ingress_ips?: string[] | null;
  storage_class: string;
  /** Origine des métriques : metrics-server | prometheus | aucune. */
  metrics_source?: string;
  /** URL du Prometheus utilisé, si c'est la source retenue. */
  prometheus_url?: string;
  /** Sources exploitables sur ce cluster, pour proposer un choix. */
  available_metrics_sources?: string[] | null;
  managed_namespaces: number;
  managed_pods: number;
};

export type NodeUsage = {
  name: string;
  cpu_millis: number;
  cpu_capacity: number;
  memory_bytes: number;
  memory_capacity: number;
  gpu_count: number;
  gpu_allocated: number;
};

export type AppUsage = {
  namespace: string;
  app_name: string;
  deployment_id: string;
  cpu_millis: number;
  memory_bytes: number;
  pod_count: number;
};

export type UsageSample = {
  ts: string;
  cpu_millis: number;
  cpu_capacity: number;
  memory_bytes: number;
  memory_capacity: number;
  nodes?: NodeUsage[] | null;
  apps?: AppUsage[] | null;
};

export type InfraCluster = {
  id: string;
  name: string;
  connected: boolean;
  last_seen?: string | null;
  agent_version?: string;
  info_updated_at?: string | null;
  info?: ClusterInfo;
  /** Dernier relevé de consommation ; absent sans metrics-server. */
  usage?: UsageSample;
  /** Historique pour la courbe d'évolution (24 h). */
  usage_history?: UsageSample[];
  /** Source imposée par l'utilisateur ; vide = choix automatique. */
  metrics_source_preference?: string;
};

export type Infra = {
  control_plane: {
    database_ok: boolean;
    agents_connected: number;
    url_generation: boolean;
    url_tls: boolean;
    api_auth: boolean;
    /** Faux sans jeton Git : documentation et pipelines restent inaccessibles. */
    git_integration?: boolean;
  };
  clusters: InfraCluster[];
};

export type User = {
  id: string;
  email: string;
  name: string;
  created_at: string;
  last_login_at?: string | null;
  /** Administrateur de la plateforme, distinct du rôle en organisation. */
  is_admin: boolean;
  /** Compte unique créé à l'installation : au-dessus de tous, non attribuable. */
  is_superadmin?: boolean;
  /** Mot de passe temporaire non encore remplacé. */
  must_change_password: boolean;
  disabled: boolean;
};

export type Permission = {
  key: string;
  label: string;
  hint: string;
  /** Droit effectif, exceptions comprises. */
  granted: boolean;
  /** Ce que le rôle accorde par défaut. */
  from_role: boolean;
  /** Vrai si une décision individuelle prime sur le rôle. */
  overridden: boolean;
};

export type Organization = {
  id: string;
  slug: string;
  name: string;
  created_at: string;
  /** Rôle de l'utilisateur courant dans cette organisation. */
  role?: string;
  /** Renseignés seulement par la vue d'administration. */
  member_count?: number;
  app_count?: number;
};

export type Member = {
  user_id: string;
  email: string;
  name: string;
  role: string;
  joined_at: string;
  /** Statut plateforme du membre : il prime sur son rôle dans l'organisation. */
  is_admin?: boolean;
  is_superadmin?: boolean;
};

export type APIToken = {
  id: string;
  name: string;
  prefix: string;
  expires_at?: string | null;
  last_used_at?: string | null;
  created_at: string;
};

export type Registry = {
  id: string;
  name: string;
  server: string;
  username: string;
  email: string;
  created_at: string;
};

export type Repository = {
  name: string;
  description: string;
  private: boolean;
  pull_count: number;
  last_updated: string;
  /** Tag proposé au déploiement ; tous les dépôts n'ont pas « latest ». */
  default_tag?: string;
};

export type Tag = {
  name: string;
  size: number;
  last_updated: string;
  /** Référence complète, directement utilisable comme image de déploiement. */
  image: string;
};

/** Version d'un runtime, tirée des tags publiés par son image. */
export type RuntimeVersion = {
  name: string;
  major: number;
  minor: number;
  patch: number;
  /** Le tag ne porte que la majeure : il suit les correctifs. */
  floating: boolean;
};

/** Type fourni avec Kybers, proposé à l'installation. */
export type BuiltinGoldenPath = {
  key: string;
  folder: TemplateFolder;
  files: FileTemplate[];
};

/** Spécification OpenAPI, telle que le Control Plane la sert. */
export type OpenAPISpec = {
  openapi: string;
  info: { title: string; version: string; description?: string };
  servers?: { url: string }[];
  tags?: { name: string }[];
  paths: Record<string, Record<string, OpenAPIOperation>>;
  components?: { schemas?: Record<string, OpenAPISchema> };
};

export type OpenAPIOperation = {
  summary?: string;
  tags?: string[];
  parameters?: { name: string; in: string; required?: boolean }[];
  requestBody?: {
    content: Record<string, { schema: OpenAPISchema }>;
  };
  responses?: Record<string, { description?: string }>;
  security?: unknown[];
};

export type OpenAPISchema = {
  type?: string;
  format?: string;
  properties?: Record<string, OpenAPISchema>;
  required?: string[];
  items?: OpenAPISchema;
  $ref?: string;
};

export type TemplateFolder = {
  id: string;
  org_id: string;
  name: string;
  description: string;
  /** Nombre de modèles qu'il contient. */
  file_count: number;

  /** Le dossier est proposé comme type d'application à la création. */
  is_golden_path: boolean;
  /** Clé d'icône lucide, résolue côté client. */
  icon: string;
  /** Image dont les tags font les versions : "node", "python", "golang". */
  runtime_image: string;
  /** Versions de repli, si l'image est absente ou le registre injoignable. */
  versions: string;
  /** Version retenue par défaut, parmi celles proposées. */
  default_version: string;
  /** Port écouté par l'exécution ; 0 = défaut de l'instance. */
  default_port: number;
  cpu_request: string;
  memory_request: string;
  cpu_limit: string;
  memory_limit: string;
  /** Chemin de la sonde HTTP ; vide = pas de sonde préconfigurée. */
  probe_path: string;
  /** Délai avant la première sonde, en secondes. */
  probe_initial_delay: number;
  /** UID non-root imposé par l'image de base ; 0 = non contraint. */
  run_as_user: number;

  created_at: string;
  updated_at: string;
};

export type FileTemplate = {
  id: string;
  org_id: string;
  /** Dossier d'appartenance ; vide = racine. */
  folder_id?: string;
  name: string;
  description: string;
  /** « pipeline », « readme » ou « fichier ». */
  kind: "pipeline" | "readme" | "fichier";
  /** Chemin de destination dans le dépôt. */
  path: string;
  content: string;
  /** Proposé en premier pour sa catégorie ; un seul par organisation. */
  is_default: boolean;
  created_at: string;
  updated_at: string;
};

export type GitStatus = {
  /** Faux quand l'instance n'a pas de jeton. */
  configured: boolean;
  /** Faux quand le jeton est présent mais refusé. */
  valid?: boolean;
  error?: string;
  login?: string;
  /** Vrai si le jeton autorise la création de dépôts. */
  can_create?: boolean;
  /** Comptes et organisations où un dépôt peut être créé. */
  owners?: string[];
};

export type GitRepo = {
  full_name: string;
  description: string;
  private: boolean;
  html_url: string;
  default_branch: string;
  language: string;
  pushed_at: string;
};

export type GitDoc = {
  path: string;
  name: string;
  size: number;
  /** Rendu HTML ; présent seulement à la lecture d'un fichier. */
  html?: string;
};

export type GitRun = {
  id: number;
  name: string;
  /** queued | in_progress | completed */
  status: string;
  /** success | failure | cancelled… (vide tant que le run tourne) */
  conclusion: string;
  branch: string;
  commit: string;
  message: string;
  actor: string;
  html_url: string;
  started_at: string;
  updated_at: string;
};

export type Probe = {
  type: "http" | "tcp" | "exec" | "none" | "";
  path?: string;
  port?: number;
  initial_delay_seconds?: number;
  period_seconds?: number;
  timeout_seconds?: number;
  failure_threshold?: number;
  command?: string[];
};

export type AppConfig = {
  app_id: string;
  environment: string;
  registry_id?: string | null;
  registry_name?: string;
  cpu_request: string;
  memory_request: string;
  cpu_limit: string;
  memory_limit: string;
  autoscaling_enabled: boolean;
  autoscaling_min: number;
  autoscaling_max: number;
  autoscaling_cpu_percent: number;
  liveness_probe?: Probe | null;
  readiness_probe?: Probe | null;
  startup_probe?: Probe | null;
  network_policy: boolean;
  quota_cpu: string;
  quota_memory: string;
  quota_pods: number;
  run_as_non_root: boolean;
  run_as_user: number;
  read_only_root_fs: boolean;
  updated_at: string;
};

const BASE = process.env.KYBERS_API_URL ?? "http://localhost:8080";

/**
 * URL du Control Plane telle qu'une pipeline externe doit l'appeler.
 *
 * `KYBERS_API_URL` sert aux appels internes du dashboard et vaut souvent
 * `localhost` : un CI hébergé ailleurs ne pourrait pas l'atteindre. Cette
 * variable-ci est celle qu'on affiche dans les instructions d'intégration.
 */
export const publicApiUrl =
  process.env.KYBERS_PUBLIC_API_URL ?? process.env.KYBERS_API_URL ?? "";
const TOKEN = process.env.KYBERS_API_TOKEN ?? "";

/**
 * Organisation active d'une session, telle que la voit le Control Plane.
 *
 * Le cookie fait foi ; à défaut, la première de la liste — celle que l'API
 * retiendrait d'elle-même s'il n'y en avait qu'une. Se fier directement à
 * `organizations[0]` est un piège : après une bascule, la page raisonnerait sur
 * une autre organisation que celle réellement interrogée, et masquerait les
 * actions dont l'utilisateur dispose pourtant.
 */
export async function activeOrganization<T extends { id: string; slug: string }>(
  organizations: T[],
): Promise<T | undefined> {
  try {
    const { cookies } = await import("next/headers");
    const stored = (await cookies()).get("kybers_org")?.value;
    const match = organizations.find((o) => o.slug === stored);
    if (match) return match;
  } catch {
    // Hors contexte de requête : on retombe sur la première.
  }
  return organizations[0];
}

/**
 * Organisation de repli, résolue une seule fois par session.
 *
 * `/auth/me` est la seule route qui n'exige pas d'organisation : elle peut donc
 * servir à en trouver une sans boucler. La mémoire est indexée par jeton de
 * session, et purgée dès qu'elle grossit — un serveur de longue durée verrait
 * sinon s'accumuler les sessions expirées.
 */
const defaultOrgCache = new Map<string, string>();

async function defaultOrgSlug(session?: string): Promise<string> {
  if (!session) return "";

  const hit = defaultOrgCache.get(session);
  if (hit !== undefined) return hit;

  try {
    const res = await fetch(`${BASE}/api/v1/auth/me`, {
      headers: { Cookie: `kybers_session=${session}` },
      cache: "no-store",
    });
    if (!res.ok) return "";

    const body = (await res.json()) as { organizations?: { slug: string }[] };
    const slug = body.organizations?.[0]?.slug ?? "";

    if (defaultOrgCache.size > 500) defaultOrgCache.clear();
    defaultOrgCache.set(session, slug);
    return slug;
  } catch {
    return "";
  }
}

/**
 * Cible explicitement une organisation, par slug ou identifiant.
 *
 * `resolveOrg` accepte le paramètre `org` au même titre que l'en-tête : c'est
 * la voie la plus simple pour agir sur une organisation qu'on consulte sans
 * l'avoir activée.
 */
function qs(org?: string): string {
  return org ? `?org=${encodeURIComponent(org)}` : "";
}

/**
 * Transmet la session de l'utilisateur au Control Plane.
 *
 * Les Server Components s'exécutent côté serveur : le cookie du navigateur
 * n'est pas joint automatiquement, il faut le relayer explicitement. Sans
 * cela, chaque appel serait anonyme et rejeté.
 */
async function sessionHeaders(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  try {
    const { cookies, headers: nextHeaders } = await import("next/headers");

    const jar = await cookies();
    const session = jar.get("kybers_session");
    if (session) out.Cookie = `kybers_session=${session.value}`;

    // Organisation active, choisie par l'utilisateur.
    //
    // Le Control Plane refuse de deviner dès qu'on appartient à plusieurs
    // organisations — à raison : un DELETE frapperait la mauvaise. Mais le
    // cookie est effacé à la déconnexion, et une session ouverte avant que la
    // connexion ne le pose n'en a pas : toutes les pages se videraient alors
    // sans expliquer pourquoi.
    //
    // On retombe donc sur la première organisation, celle que l'API choisirait
    // d'elle-même s'il n'y en avait qu'une. Le résultat est mémorisé pour la
    // durée du rendu : sans cela, chaque appel rappellerait `/auth/me`.
    const org = jar.get("kybers_org");
    const slug = org?.value || (await defaultOrgSlug(session?.value));
    // Un en-tête vide vaut moins que pas d'en-tête : l'API le lirait comme une
    // organisation nommée « » et répondrait 403 au lieu de choisir.
    if (slug) out["X-Kybers-Org"] = slug;

    // Hors contexte de requête (build), next/headers échoue : on ignore.
    void nextHeaders;
  } catch {
    // Pas de requête en cours : appel anonyme, l'API répondra 401.
  }
  return out;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  Object.assign(headers, await sessionHeaders());

  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
    // L'état des déploiements change en permanence : jamais de cache.
    cache: "no-store",
  });

  if (!res.ok) {
    // L'API renvoie {"error": "..."} : on remonte ce message plutôt qu'un
    // code HTTP brut, plus parlant dans l'interface.
    const body = await res.text();
    let message = body;
    try {
      const parsed = JSON.parse(body);
      if (parsed?.error) message = parsed.error;
    } catch {
      // corps non JSON : on garde le texte tel quel
    }
    throw new Error(message || `${res.status}`);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  health: () => request<{ status: string; agents: string[] }>("/healthz"),

  // --- Applications ---
  listApps: () => request<App[]>("/api/v1/apps"),
  getApp: (id: string) => request<App>(`/api/v1/apps/${id}`),
  createApp: (name: string, gitRepo: string, containerPort: number) =>
    request<App>("/api/v1/apps", {
      method: "POST",
      body: JSON.stringify({ name, git_repo: gitRepo, container_port: containerPort }),
    }),

  // --- Variables ---
  getEnv: (appId: string, environment: string) =>
    request<Record<string, string>>(
      `/api/v1/apps/${appId}/env?environment=${encodeURIComponent(environment)}`,
    ),
  setEnv: (appId: string, environment: string, vars: Record<string, string>) =>
    request<{ updated: number }>(`/api/v1/apps/${appId}/env`, {
      method: "PUT",
      body: JSON.stringify({ environment, vars }),
    }),
  deleteEnv: (appId: string, environment: string, key: string) =>
    request<void>(
      `/api/v1/apps/${appId}/env/${encodeURIComponent(key)}?environment=${encodeURIComponent(environment)}`,
      { method: "DELETE" },
    ),

  // --- Secrets : seuls les NOMS sont lisibles ---
  /** Noms des secrets du dépôt GitHub ; les valeurs ne sont jamais restituées. */
  listRepoSecrets: (appId: string, env = "") =>
    request<{ name: string; updated_at: string }[]>(
      `/api/v1/apps/${appId}/repo-secrets${env ? `?env=${encodeURIComponent(env)}` : ""}`,
    ),

  /** Dépose des secrets sur le dépôt ; Kybers n'en garde aucune valeur. */
  putRepoSecrets: (
    appId: string,
    secrets: { key: string; value: string }[],
    env = "",
  ) =>
    request<{ repo: string; written: string[] }>(
      `/api/v1/apps/${appId}/repo-secrets${env ? `?env=${encodeURIComponent(env)}` : ""}`,
      { method: "PUT", body: JSON.stringify({ secrets }) },
    ),

  /** Variables Actions du dépôt ; leurs valeurs sont lisibles. */
  /** Spécification OpenAPI de l'API HTTP, servie sans authentification. */
  openapi: () => request<OpenAPISpec>("/api/v1/openapi.json"),

  /** Environnements déclarés sur le dépôt ; ils cloisonnent les secrets. */
  listRepoEnvs: (appId: string) =>
    request<string[]>(`/api/v1/apps/${appId}/repo-envs`),

  createRepoEnv: (appId: string, name: string) =>
    request<{ name: string }>(
      `/api/v1/apps/${appId}/repo-envs/${encodeURIComponent(name)}`,
      { method: "PUT" },
    ),

  deleteRepoEnv: (appId: string, name: string) =>
    request<void>(
      `/api/v1/apps/${appId}/repo-envs/${encodeURIComponent(name)}`,
      { method: "DELETE" },
    ),

  listRepoVars: (appId: string, env = "") =>
    request<{ name: string; value: string }[]>(
      `/api/v1/apps/${appId}/repo-vars${env ? `?env=${encodeURIComponent(env)}` : ""}`,
    ),

  putRepoVars: (
    appId: string,
    variables: { key: string; value: string }[],
    env = "",
  ) =>
    request<{ repo: string; written: string[] }>(
      `/api/v1/apps/${appId}/repo-vars${env ? `?env=${encodeURIComponent(env)}` : ""}`,
      { method: "PUT", body: JSON.stringify({ variables }) },
    ),

  deleteRepoVar: (appId: string, name: string, env = "") => {
    return request<void>(
      `/api/v1/apps/${appId}/repo-vars/${name}${env ? `?env=${encodeURIComponent(env)}` : ""}`,
      { method: "DELETE" },
    );
  },

  deleteRepoSecret: (appId: string, name: string, env = "") => {
    return request<void>(
      `/api/v1/apps/${appId}/repo-secrets/${name}${env ? `?env=${encodeURIComponent(env)}` : ""}`,
      { method: "DELETE" },
    );
  },

  listSecretKeys: (appId: string, environment: string) =>
    request<{ keys: string[] }>(
      `/api/v1/apps/${appId}/secrets?environment=${encodeURIComponent(environment)}`,
    ),
  setSecrets: (appId: string, environment: string, vars: Record<string, string>) =>
    request<{ updated: number }>(`/api/v1/apps/${appId}/secrets`, {
      method: "PUT",
      body: JSON.stringify({ environment, vars }),
    }),
  deleteSecret: (appId: string, environment: string, key: string) =>
    request<void>(
      `/api/v1/apps/${appId}/secrets/${encodeURIComponent(key)}?environment=${encodeURIComponent(environment)}`,
      { method: "DELETE" },
    ),

  // --- Configuration d'exécution ---
  getConfig: (appId: string, environment: string) =>
    request<AppConfig>(
      `/api/v1/apps/${appId}/config?environment=${encodeURIComponent(environment)}`,
    ),
  setConfig: (appId: string, cfg: Partial<AppConfig> & { environment: string }) =>
    request<AppConfig>(`/api/v1/apps/${appId}/config`, {
      method: "PUT",
      body: JSON.stringify(cfg),
    }),

  // --- Déploiements ---
  deploy: (
    appId: string,
    environment: string,
    image: string,
    replicas: number,
    host: string,
    /** Origine du déclenchement, pour distinguer un geste manuel d'un appel CI. */
    source = "dashboard",
  ) =>
    request<Deployment>(`/api/v1/apps/${appId}/deploy`, {
      method: "POST",
      body: JSON.stringify({ environment, image, replicas, host, source }),
    }),
  deleteApp: (appId: string, cascade = false, deleteRepo = false) => {
    const q = new URLSearchParams();
    if (cascade) q.set("cascade", "true");
    if (deleteRepo) q.set("delete_repo", "true");
    const s = q.toString();
    return request<{ pending_environments?: number; message?: string }>(
      `/api/v1/apps/${appId}${s ? `?${s}` : ""}`,
      { method: "DELETE" },
    );
  },

  // --- Modèles de fichiers ---
  listFolders: () => request<TemplateFolder[]>("/api/v1/template-folders"),

  /** Types fournis avec Kybers, pas encore installés dans l'organisation. */
  listBuiltinGoldenPaths: () =>
    request<BuiltinGoldenPath[]>("/api/v1/golden-paths/builtin"),

  /** Versions disponibles pour un type ; `source` dit d'où elles viennent. */
  listRuntimeVersions: (folderId: string, all = false) =>
    request<{ versions: RuntimeVersion[]; source: string }>(
      `/api/v1/template-folders/${folderId}/versions${all ? "?all=1" : ""}`,
    ),

  installGoldenPath: (key: string) =>
    request<TemplateFolder>(`/api/v1/golden-paths/builtin/${key}`, {
      method: "POST",
    }),
  saveFolder: (f: Partial<TemplateFolder> & { id?: string }) =>
    request<TemplateFolder>(
      f.id ? `/api/v1/template-folders/${f.id}` : "/api/v1/template-folders",
      { method: f.id ? "PUT" : "POST", body: JSON.stringify(f) },
    ),
  deleteFolder: (id: string) =>
    request<void>(`/api/v1/template-folders/${id}`, { method: "DELETE" }),

  listTemplates: (kind = "") =>
    request<FileTemplate[]>(
      `/api/v1/templates${kind ? `?kind=${encodeURIComponent(kind)}` : ""}`,
    ),
  saveTemplate: (t: Partial<FileTemplate> & { id?: string }) =>
    request<FileTemplate>(
      t.id ? `/api/v1/templates/${t.id}` : "/api/v1/templates",
      { method: t.id ? "PUT" : "POST", body: JSON.stringify(t) },
    ),
  deleteTemplate: (id: string) =>
    request<void>(`/api/v1/templates/${id}`, { method: "DELETE" }),

  // --- Intégration Git ---
  gitStatus: () => request<GitStatus>("/api/v1/git/status"),
  setGitSettings: (token: string, apiUrl = "") =>
    request<GitStatus>("/api/v1/git/settings", {
      method: "PUT",
      body: JSON.stringify({ token, api_url: apiUrl }),
    }),
  gitReadFile: (repo: string, path: string) =>
    request<{ path: string; content: string; exists: boolean }>(
      `/api/v1/git/file?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(path)}`,
    ),
  gitWriteFile: (payload: {
    repo: string;
    path: string;
    content: string;
    message?: string;
  }) =>
    request<{ repo: string; path: string }>("/api/v1/git/file", {
      method: "PUT",
      body: JSON.stringify(payload),
    }),
  gitWriteFiles: (payload: {
    repo: string;
    files: { path: string; content: string }[];
    token_name?: string;
    /** Secrets chiffrés déposés sur le dépôt, lisibles par le CI seul. */
    secrets?: { key: string; value: string }[];
  }) =>
    request<{
      repo: string;
      written: string[];
      failures: Record<string, string>;
      secret: boolean;
    }>("/api/v1/git/files", { method: "POST", body: JSON.stringify(payload) }),
  gitInstallWorkflow: (payload: {
    repo: string;
    path?: string;
    content: string;
    token_name?: string;
  }) =>
    request<{ repo: string; path: string; secret: boolean }>(
      "/api/v1/git/workflow",
      { method: "POST", body: JSON.stringify(payload) },
    ),
  gitLookup: (repo: string) =>
    request<GitRepo>(`/api/v1/git/repo?repo=${encodeURIComponent(repo)}`),
  gitCreateRepo: (payload: {
    owner: string;
    name: string;
    description?: string;
    private?: boolean;
  }) =>
    request<GitRepo>("/api/v1/git/repos", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  // --- Dépôt Git rattaché ---
  getAppRepo: (appId: string) =>
    request<GitRepo>(`/api/v1/apps/${appId}/repo`),
  setAppRepo: (appId: string, repo: string) =>
    request<{ repo: string }>(`/api/v1/apps/${appId}/repo`, {
      method: "PUT",
      body: JSON.stringify({ repo }),
    }),
  listAppDocs: (appId: string) =>
    request<GitDoc[]>(`/api/v1/apps/${appId}/docs`),
  getAppDoc: (appId: string, path: string) =>
    request<GitDoc>(`/api/v1/apps/${appId}/docs/${path}`),
  listAppRuns: (appId: string) =>
    request<GitRun[]>(`/api/v1/apps/${appId}/runs`),

  listAppPorts: (appId: string) =>
    request<AppPort[]>(`/api/v1/apps/${appId}/ports`),
  setAppPorts: (appId: string, ports: AppPort[]) =>
    request<AppPort[]>(`/api/v1/apps/${appId}/ports`, {
      method: "PUT",
      body: JSON.stringify({ ports }),
    }),
  listDeployments: () => request<Deployment[]>("/api/v1/deployments"),
  listAppDeployments: (appId: string, environment = "") =>
    request<Deployment[]>(
      `/api/v1/apps/${appId}/deployments?environment=${encodeURIComponent(environment)}`,
    ),
  getDeployment: (id: string) => request<Deployment>(`/api/v1/deployments/${id}`),

  // --- Cycle de vie ---
  scale: (id: string, replicas: number) =>
    request<unknown>(`/api/v1/deployments/${id}/scale`, {
      method: "POST",
      body: JSON.stringify({ replicas }),
    }),
  stop: (id: string) =>
    request<unknown>(`/api/v1/deployments/${id}/stop`, { method: "POST", body: "{}" }),
  start: (id: string, replicas = 1) =>
    request<unknown>(`/api/v1/deployments/${id}/start`, {
      method: "POST",
      body: JSON.stringify({ replicas }),
    }),
  restart: (id: string) =>
    request<unknown>(`/api/v1/deployments/${id}/restart`, { method: "POST", body: "{}" }),
  rollback: (id: string) =>
    request<Deployment>(`/api/v1/deployments/${id}/rollback`, {
      method: "POST",
      body: "{}",
    }),
  remove: (id: string, withNamespace = false) =>
    request<unknown>(`/api/v1/deployments/${id}?namespace=${withNamespace}`, {
      method: "DELETE",
    }),

  // --- Observabilité ---
  getLogs: (id: string, limit = 100) =>
    request<LogLine[]>(`/api/v1/deployments/${id}/logs?limit=${limit}`),
  getEvents: (id: string, limit = 50) =>
    request<Event[]>(`/api/v1/deployments/${id}/events?limit=${limit}`),
  followLogs: (id: string, follow: boolean) =>
    request<{ follow: boolean }>(`/api/v1/deployments/${id}/logs/follow`, {
      method: "POST",
      body: JSON.stringify({ follow }),
    }),

  // --- Clusters ---
  listClusters: () =>
    request<{ clusters: Cluster[]; connected: string[] }>("/api/v1/clusters"),
  createCluster: (name: string) =>
    request<{ cluster: Cluster; token: string; install_command: string }>("/api/v1/clusters", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  deleteCluster: (id: string) =>
    request<void>(`/api/v1/clusters/${id}`, { method: "DELETE" }),

  getInfra: () => request<Infra>("/api/v1/infra"),

  // --- Identité ---
  me: () => request<{ user: User; organizations: Organization[] }>("/api/v1/auth/me"),
  /** Vrai tant qu'aucun compte n'existe : seul cas où l'inscription est ouverte. */
  needsBootstrap: () =>
    request<{ needs_bootstrap: boolean; open_registration: boolean }>(
      "/api/v1/auth/bootstrap",
    ).then((r) => r.needs_bootstrap || r.open_registration),
  changePassword: (current: string, next: string) =>
    request<unknown>("/api/v1/auth/password", {
      method: "POST",
      body: JSON.stringify({ current_password: current, new_password: next }),
    }),
  listOrganizations: () => request<Organization[]>("/api/v1/organizations"),
  createOrganization: (name: string) =>
    request<Organization>("/api/v1/organizations", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),

  // --- Membres et droits ---
  //
  // `org` cible une organisation autre que l'organisation active : on gère les
  // membres de celle qu'on consulte, sans avoir à basculer d'abord. Le Control
  // Plane vérifie de toute façon le rôle dans CETTE organisation.
  listMembers: (org?: string) => request<Member[]>(`/api/v1/members${qs(org)}`),
  addMember: (email: string, role: string, org?: string) =>
    request<unknown>(`/api/v1/members${qs(org)}`, {
      method: "POST",
      body: JSON.stringify({ email, role }),
    }),
  updateMemberRole: (userId: string, role: string, org?: string) =>
    request<unknown>(`/api/v1/members/${userId}${qs(org)}`, {
      method: "PUT",
      body: JSON.stringify({ role }),
    }),
  removeMember: (userId: string, org?: string) =>
    request<void>(`/api/v1/members/${userId}${qs(org)}`, { method: "DELETE" }),

  // --- Administration de la plateforme ---
  adminListUsers: () => request<User[]>("/api/v1/admin/users"),
  adminCreateUser: (payload: {
    email: string;
    name: string;
    is_admin?: boolean;
    org_id?: string;
    role?: string;
  }) =>
    request<{ user: User; password?: string }>("/api/v1/admin/users", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  adminSetUserStatus: (id: string, payload: { disabled?: boolean; is_admin?: boolean }) =>
    request<User>(`/api/v1/admin/users/${id}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    }),
  adminResetPassword: (id: string) =>
    request<{ password?: string; status: string }>(
      `/api/v1/admin/users/${id}/password`,
      { method: "POST", body: "{}" },
    ),
  adminAssignOrg: (userId: string, orgId: string, role: string) =>
    request<unknown>("/api/v1/admin/assign", {
      method: "POST",
      body: JSON.stringify({ user_id: userId, org_id: orgId, role }),
    }),
  adminListOrganizations: () => request<Organization[]>("/api/v1/admin/organizations"),
  adminCreateOrganization: (name: string, ownerId?: string, slug?: string) =>
    request<Organization>("/api/v1/admin/organizations", {
      method: "POST",
      body: JSON.stringify({ name, owner_id: ownerId, slug }),
    }),
  adminRenameOrganization: (id: string, name: string) =>
    request<Organization>(`/api/v1/admin/organizations/${id}`, {
      method: "PUT",
      body: JSON.stringify({ name }),
    }),
  adminDeleteOrganization: (id: string) =>
    request<void>(`/api/v1/admin/organizations/${id}`, { method: "DELETE" }),
  adminListOrgMembers: (id: string) =>
    request<Member[]>(`/api/v1/admin/organizations/${id}/members`),
  adminRemoveOrgMember: (id: string, userId: string) =>
    request<void>(`/api/v1/admin/organizations/${id}/members/${userId}`, {
      method: "DELETE",
    }),

  // --- Droits individuels ---
  getUserPermissions: (userId: string, org?: string) =>
    request<{ user_id: string; role: string; permissions: Permission[] }>(
      `/api/v1/members/${userId}/permissions${qs(org)}`,
    ),
  setUserPermission: (
    userId: string,
    permission: string,
    granted: boolean,
    reset = false,
    org?: string,
  ) =>
    request<unknown>(`/api/v1/members/${userId}/permissions${qs(org)}`, {
      method: "PUT",
      body: JSON.stringify({ permission, granted, reset }),
    }),

  // --- Jetons d'API ---
  listTokens: () => request<APIToken[]>("/api/v1/tokens"),
  createToken: (name: string, expiresInDays = 0) =>
    request<{ api_token: APIToken; token: string }>("/api/v1/tokens", {
      method: "POST",
      body: JSON.stringify({ name, expires_in_days: expiresInDays }),
    }),
  deleteToken: (id: string) =>
    request<void>(`/api/v1/tokens/${id}`, { method: "DELETE" }),
  setMetricsSource: (clusterId: string, source: string, prometheusUrl = "") =>
    request<{ source: string; applied: boolean }>(
      `/api/v1/clusters/${clusterId}/metrics-source`,
      { method: "PUT", body: JSON.stringify({ source, prometheus_url: prometheusUrl }) },
    ),

  // --- Registries ---
  listRegistries: () => request<Registry[]>("/api/v1/registries"),
  createRegistry: (r: {
    name: string;
    server: string;
    username: string;
    password: string;
    email?: string;
  }) =>
    request<Registry>("/api/v1/registries", {
      method: "POST",
      body: JSON.stringify(r),
    }),
  deleteRegistry: (id: string) =>
    request<void>(`/api/v1/registries/${id}`, { method: "DELETE" }),
  testRegistry: (r: { server: string; username: string; password: string }) =>
    request<{ ok: boolean; checked: boolean; message: string }>(
      "/api/v1/registries/test",
      { method: "POST", body: JSON.stringify(r) },
    ),
  listRepositories: (registryId: string, namespace = "") =>
    request<{
      repositories: Repository[];
      authenticated: boolean;
      namespace: string;
    }>(
      `/api/v1/registries/${registryId}/repositories?namespace=${encodeURIComponent(namespace)}`,
    ),
  listTags: (registryId: string, repository: string) =>
    request<Tag[]>(
      `/api/v1/registries/${registryId}/tags?repository=${encodeURIComponent(repository)}`,
    ),
};

/** Parse un bloc "KEY=VALUE" (une paire par ligne) en objet. */
export function parseEnvBlock(raw: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx > 0) vars[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return vars;
}

/**
 * Découpe un bloc collé en paires clé/valeur.
 *
 * Accepte ce qu'on récupère réellement : un `.env`, un export shell, un
 * tableau collé depuis une documentation, ou plusieurs paires sur une même
 * ligne. Les guillemets entourant la valeur sont retirés — ils appartiennent à
 * la syntaxe du fichier, pas à la valeur.
 */
export function parseEnvPairs(raw: string): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];

  for (const line of raw.split(/\r?\n/)) {
    for (const chunk of splitPairs(line)) {
      const pair = parsePair(chunk);
      if (pair) out.push(pair);
    }
  }
  return out;
}

/**
 * Sépare les paires écrites sur une même ligne.
 *
 * On ne coupe qu'avant ce qui ressemble à une nouvelle clé — `ESPACE NOM=` —
 * car une valeur peut légitimement contenir des espaces : `GREETING=hello
 * world` doit rester entier.
 */
function splitPairs(line: string): string[] {
  const s = line.trim();
  if (!s || s.startsWith("#")) return [];

  const cuts: number[] = [];
  const re = /\s+(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    cuts.push(m.index);
    // Reprendre au début du nom : le `=` consommé pourrait masquer la paire
    // suivante si deux se touchent.
    re.lastIndex = m.index + m[0].length - 1;
  }
  if (cuts.length === 0) return [s];

  const out: string[] = [];
  let from = 0;
  for (const at of cuts) {
    out.push(s.slice(from, at));
    from = at;
  }
  out.push(s.slice(from));
  return out;
}

/** Lit une paire isolée : `CLÉ=valeur` ou `CLÉ: valeur`. */
function parsePair(chunk: string): { key: string; value: string } | null {
  let s = chunk.trim();
  if (!s || s.startsWith("#")) return null;

  // `export KEY=value` est la forme la plus courante d'un extrait de doc.
  s = s.replace(/^export\s+/, "");

  // Séparateur : `=` ou `:` — un YAML collé reste exploitable. Le premier
  // rencontré tranche, une valeur peut contenir les deux.
  const at = s.search(/[=:]/);
  if (at <= 0) return null;

  const key = s.slice(0, at).trim();
  let value = s.slice(at + 1).trim();

  // Guillemets de syntaxe, et virgule finale d'un tableau.
  value = value.replace(/,$/, "").trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  return key ? { key, value } : null;
}
