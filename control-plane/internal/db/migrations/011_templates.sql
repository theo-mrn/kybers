-- Modèles de fichiers, définis par l'organisation.
--
-- Kybers écrit des fichiers dans les dépôts — workflow de déploiement, README,
-- et tout ce qu'une équipe veut standardiser : CODEOWNERS, Dockerfile,
-- CONTRIBUTING… Les modèles étaient jusqu'ici figés dans le code du dashboard,
-- ce qui interdisait à une entreprise d'imposer les siens.
--
-- Ils appartiennent à l'organisation : deux équipes d'une même instance ne
-- partagent ni leurs conventions ni leurs pipelines.

CREATE TABLE IF NOT EXISTS file_templates (
    id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    -- Catégorie : « pipeline », « readme », ou « fichier » pour le reste.
    -- Elle détermine où le modèle est proposé dans le parcours.
    kind        TEXT NOT NULL DEFAULT 'fichier'
                CHECK (kind IN ('pipeline', 'readme', 'fichier')),
    -- Chemin de destination dans le dépôt. Les placeholders y sont admis :
    -- un modèle peut viser .github/workflows/{{app}}.yml.
    path        TEXT NOT NULL,
    content     TEXT NOT NULL DEFAULT '',

    -- Modèle proposé en premier pour sa catégorie. Un seul par catégorie et
    -- par organisation : au-delà, le choix par défaut serait ambigu.
    is_default  BOOLEAN NOT NULL DEFAULT false,

    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by  UUID REFERENCES users(id) ON DELETE SET NULL,

    UNIQUE (org_id, name)
);

CREATE INDEX IF NOT EXISTS idx_file_templates_org
    ON file_templates(org_id, kind, name);

CREATE UNIQUE INDEX IF NOT EXISTS idx_file_templates_one_default
    ON file_templates(org_id, kind) WHERE is_default;
