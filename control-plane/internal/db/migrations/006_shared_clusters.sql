-- Les clusters redeviennent une ressource de plateforme, partageable.
--
-- Le rattachement à UNE organisation était une erreur de modélisation :
-- plusieurs organisations déploient couramment sur le MÊME cluster, chacune
-- dans ses propres namespaces. Ce lien unique avait deux conséquences :
--
--   * les autres organisations ne voyaient aucun cluster alors qu'un agent
--     était connecté — leurs déploiements ne partaient que par chance, tant
--     qu'un seul agent existait ;
--   * supprimer l'organisation propriétaire emportait le cluster par cascade,
--     donc le couple (nom, token) de l'agent, qui ne pouvait plus
--     s'authentifier.

ALTER TABLE clusters DROP COLUMN IF EXISTS org_id;

-- Le nom redevient l'identifiant présenté par l'agent : unique sur toute la
-- plateforme, et non plus par organisation.
DROP INDEX IF EXISTS idx_clusters_org_name;
DROP INDEX IF EXISTS idx_clusters_org;

-- Deux clusters homonymes venus d'organisations différentes se télescoperaient
-- ici : on suffixe les doublons plutôt que d'échouer, l'administrateur les
-- renommera.
UPDATE clusters c SET name = c.name || '-' || left(c.id::text, 8)
WHERE EXISTS (
    SELECT 1 FROM clusters o
    WHERE o.name = c.name AND o.created_at < c.created_at
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_clusters_name ON clusters(name);

-- Restriction facultative : tant qu'un cluster n'a AUCUNE ligne ici, il est
-- visible par toutes les organisations — le cas courant, et le comportement
-- par défaut. Dès qu'une ligne existe, seules les organisations listées le
-- voient. Une organisation peut être liée à plusieurs clusters, et un cluster
-- à plusieurs organisations.
--
-- Une liste d'autorisation, plutôt qu'une propriété exclusive : ouvrir reste
-- l'état par défaut, restreindre est un geste délibéré.
CREATE TABLE IF NOT EXISTS cluster_orgs (
    cluster_id UUID        NOT NULL REFERENCES clusters(id)      ON DELETE CASCADE,
    org_id     UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (cluster_id, org_id)
);

CREATE INDEX IF NOT EXISTS idx_cluster_orgs_org ON cluster_orgs(org_id);
