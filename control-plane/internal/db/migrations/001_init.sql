-- Schéma initial du Control Plane Kybers.
-- Appliqué automatiquement au démarrage du serveur (voir internal/db/db.go).

CREATE TABLE IF NOT EXISTS users (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email       TEXT        NOT NULL UNIQUE,
    api_token   TEXT        NOT NULL UNIQUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS clusters (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT        NOT NULL UNIQUE,
    token       TEXT        NOT NULL,
    last_seen   TIMESTAMPTZ,
    connected   BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS apps (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name           TEXT        NOT NULL,
    git_repo       TEXT        NOT NULL DEFAULT '',
    cluster_id     UUID        REFERENCES clusters(id) ON DELETE SET NULL,
    container_port INT         NOT NULL DEFAULT 8080,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (name)
);

-- Variables d'environnement par application + environnement.
CREATE TABLE IF NOT EXISTS env_vars (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id      UUID        NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    environment TEXT        NOT NULL,
    key         TEXT        NOT NULL,
    value       TEXT        NOT NULL,
    UNIQUE (app_id, environment, key)
);

-- Un déploiement = une demande de mise en service d'une image dans un env.
-- status : pending -> dispatched -> provisioning -> running | failed
CREATE TABLE IF NOT EXISTS deployments (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id       UUID        NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    environment  TEXT        NOT NULL,
    image        TEXT        NOT NULL,
    replicas     INT         NOT NULL DEFAULT 1,
    host         TEXT        NOT NULL DEFAULT '',
    status       TEXT        NOT NULL DEFAULT 'pending',
    message      TEXT        NOT NULL DEFAULT '',
    url          TEXT        NOT NULL DEFAULT '',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_deployments_status ON deployments(status);
CREATE INDEX IF NOT EXISTS idx_deployments_app    ON deployments(app_id, created_at DESC);

-- Logs remontés par l'agent (bornés en pratique par une purge externe).
CREATE TABLE IF NOT EXISTS deployment_logs (
    id            BIGSERIAL PRIMARY KEY,
    deployment_id UUID        NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
    pod_name      TEXT        NOT NULL,
    line          TEXT        NOT NULL,
    ts            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_logs_deployment ON deployment_logs(deployment_id, id DESC);

-- Aucune donnée de démarrage : depuis l'introduction des organisations, un
-- cluster appartient à une organisation et se crée via l'API, qui génère son
-- jeton. Un INSERT ici échouerait au rejeu, la contrainte d'unicité portant
-- désormais sur (org_id, name).
