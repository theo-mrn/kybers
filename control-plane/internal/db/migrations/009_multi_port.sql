-- Ports d'une application : une image peut en ouvrir plusieurs.
--
-- Jusqu'ici `apps.container_port` n'en portait qu'un : une image écoutant sur
-- 3000 et 7001 n'était joignable que sur l'un des deux, sans que rien ne le
-- signale. Les ports vivent désormais dans leur propre table.
--
-- Un seul port peut être exposé publiquement : l'Ingress ne route que vers une
-- destination, et deux ports publics sur un même hôte seraient ambigus.

CREATE TABLE IF NOT EXISTS app_ports (
    id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    app_id   UUID NOT NULL REFERENCES apps(id) ON DELETE CASCADE,

    port     INT  NOT NULL CHECK (port > 0 AND port < 65536),
    -- Nom Kubernetes du port (http, metrics, grpc…) : il apparaît dans le
    -- Service et sert de cible aux probes.
    name     TEXT NOT NULL DEFAULT '',
    -- Port routé par l'Ingress. Les autres restent joignables dans le cluster.
    exposed  BOOLEAN NOT NULL DEFAULT false,
    -- Protocole Kubernetes : TCP ou UDP.
    protocol TEXT NOT NULL DEFAULT 'TCP' CHECK (protocol IN ('TCP', 'UDP')),

    position INT NOT NULL DEFAULT 0,

    UNIQUE (app_id, port, protocol)
);

CREATE INDEX IF NOT EXISTS idx_app_ports_app ON app_ports(app_id, position);

-- Un seul port public par application : garanti en base plutôt que par le
-- code, pour qu'aucun chemin d'écriture ne puisse l'enfreindre.
CREATE UNIQUE INDEX IF NOT EXISTS idx_app_ports_one_exposed
    ON app_ports(app_id) WHERE exposed;

-- Reprise de l'existant : le port unique devient le port public.
INSERT INTO app_ports (app_id, port, name, exposed, position)
SELECT id, container_port, 'http', true, 0
FROM apps
WHERE container_port > 0
ON CONFLICT DO NOTHING;

-- `apps.container_port` est conservé : il reste la valeur par défaut proposée
-- à la création et évite de casser les clients de l'API qui le lisent encore.
