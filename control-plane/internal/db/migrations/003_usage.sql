-- Séries temporelles de consommation, alimentées par les agents.
-- Rétention : 24h, purgée périodiquement par le Control Plane.

CREATE TABLE IF NOT EXISTS usage_samples (
    id            BIGSERIAL PRIMARY KEY,
    cluster_id    UUID        NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
    ts            TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Agrégats du cluster, en unités Kubernetes (millicores, octets).
    cpu_millis     BIGINT NOT NULL DEFAULT 0,
    cpu_capacity   BIGINT NOT NULL DEFAULT 0,
    memory_bytes   BIGINT NOT NULL DEFAULT 0,
    memory_capacity BIGINT NOT NULL DEFAULT 0,

    -- Détail par nœud et par application ; JSON pour suivre l'évolution du
    -- format sans migration à chaque champ.
    nodes JSONB,
    apps  JSONB
);

-- La requête dominante est « les N dernières heures d'un cluster ».
CREATE INDEX IF NOT EXISTS idx_usage_cluster_ts ON usage_samples(cluster_id, ts DESC);

-- Source de métriques choisie par l'utilisateur ; vide = choix automatique.
-- Persistée pour être réappliquée à chaque reconnexion de l'agent.
ALTER TABLE clusters ADD COLUMN IF NOT EXISTS metrics_source TEXT NOT NULL DEFAULT '';
