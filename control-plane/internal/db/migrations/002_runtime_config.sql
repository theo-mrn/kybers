-- Configuration d'exécution, registries privés, révisions et events.
-- Idempotent : rejoué à chaque démarrage du Control Plane.

-- ---------------------------------------------------------------------------
-- Registries privés
-- ---------------------------------------------------------------------------
-- Le mot de passe est chiffré applicativement (AES-GCM) avant insertion :
-- une lecture directe de la table ne révèle aucun identifiant.
CREATE TABLE IF NOT EXISTS registries (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name               TEXT        NOT NULL UNIQUE,
    server             TEXT        NOT NULL,
    username           TEXT        NOT NULL,
    password_encrypted BYTEA       NOT NULL,
    email              TEXT        NOT NULL DEFAULT '',
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Variables sensibles
-- ---------------------------------------------------------------------------
-- Séparées de env_vars : elles finiront dans un Secret Kubernetes et non dans
-- un ConfigMap, et ne sont jamais renvoyées en clair par l'API.
CREATE TABLE IF NOT EXISTS secret_vars (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id          UUID        NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    environment     TEXT        NOT NULL,
    key             TEXT        NOT NULL,
    value_encrypted BYTEA       NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (app_id, environment, key)
);

-- ---------------------------------------------------------------------------
-- Configuration d'exécution par application + environnement
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_configs (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id      UUID NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    environment TEXT NOT NULL,

    registry_id UUID REFERENCES registries(id) ON DELETE SET NULL,

    -- Ressources (format Kubernetes : "100m", "256Mi").
    cpu_request    TEXT NOT NULL DEFAULT '50m',
    memory_request TEXT NOT NULL DEFAULT '64Mi',
    cpu_limit      TEXT NOT NULL DEFAULT '500m',
    memory_limit   TEXT NOT NULL DEFAULT '512Mi',

    -- Autoscaling ; désactivé => replicas fixes du déploiement.
    autoscaling_enabled     BOOLEAN NOT NULL DEFAULT FALSE,
    autoscaling_min         INT     NOT NULL DEFAULT 1,
    autoscaling_max         INT     NOT NULL DEFAULT 5,
    autoscaling_cpu_percent INT     NOT NULL DEFAULT 80,

    -- Sondes, stockées en JSON pour rester souples sans multiplier les colonnes.
    liveness_probe  JSONB,
    readiness_probe JSONB,
    startup_probe   JSONB,

    -- Sécurité du namespace.
    network_policy BOOLEAN NOT NULL DEFAULT FALSE,
    quota_cpu      TEXT    NOT NULL DEFAULT '',
    quota_memory   TEXT    NOT NULL DEFAULT '',
    quota_pods     INT     NOT NULL DEFAULT 0,

    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (app_id, environment)
);

-- ---------------------------------------------------------------------------
-- Historique et cycle de vie des déploiements
-- ---------------------------------------------------------------------------
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS revision INT NOT NULL DEFAULT 1;
-- Renseigné quand le déploiement est un retour à une révision antérieure.
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS rolled_back_from UUID;
-- Cause technique du dernier échec (ImagePullBackOff, CrashLoopBackOff...).
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS reason TEXT NOT NULL DEFAULT '';
-- Snapshot de la config appliquée : rend le rollback fidèle même si la config
-- courante de l'application a changé depuis.
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS config_snapshot JSONB;

-- La révision est unique par application + environnement.
CREATE UNIQUE INDEX IF NOT EXISTS idx_deployments_revision
    ON deployments(app_id, environment, revision);

-- ---------------------------------------------------------------------------
-- Events Kubernetes remontés par l'agent
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deployment_events (
    id            BIGSERIAL PRIMARY KEY,
    deployment_id UUID        NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
    pod_name      TEXT        NOT NULL DEFAULT '',
    type          TEXT        NOT NULL DEFAULT 'Normal',
    reason        TEXT        NOT NULL DEFAULT '',
    message       TEXT        NOT NULL DEFAULT '',
    ts            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_events_deployment
    ON deployment_events(deployment_id, id DESC);

-- ---------------------------------------------------------------------------
-- Commandes de cycle de vie (scale, restart, rollback...)
-- ---------------------------------------------------------------------------
-- Tracées pour que le dashboard sache si l'ordre a été exécuté par l'agent.
CREATE TABLE IF NOT EXISTS deployment_commands (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deployment_id UUID        NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
    kind          TEXT        NOT NULL,   -- scale | restart | delete
    payload       JSONB       NOT NULL DEFAULT '{}'::jsonb,
    status        TEXT        NOT NULL DEFAULT 'pending', -- pending|sent|done|failed
    message       TEXT        NOT NULL DEFAULT '',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_commands_status ON deployment_commands(status);

-- Durcissement du conteneur (opt-in, cf. commentaire dans agent.proto).
ALTER TABLE app_configs ADD COLUMN IF NOT EXISTS run_as_non_root BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE app_configs ADD COLUMN IF NOT EXISTS run_as_user BIGINT NOT NULL DEFAULT 0;
ALTER TABLE app_configs ADD COLUMN IF NOT EXISTS read_only_root_fs BOOLEAN NOT NULL DEFAULT FALSE;

-- État de l'infrastructure remonté par l'agent, pour la page Infrastructure.
-- Stocké en JSON : la forme évolue avec l'agent sans migration à chaque champ.
ALTER TABLE clusters ADD COLUMN IF NOT EXISTS info JSONB;
ALTER TABLE clusters ADD COLUMN IF NOT EXISTS agent_version TEXT NOT NULL DEFAULT '';
ALTER TABLE clusters ADD COLUMN IF NOT EXISTS info_updated_at TIMESTAMPTZ;
