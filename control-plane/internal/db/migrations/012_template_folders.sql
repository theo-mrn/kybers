-- Dossiers de modèles.
--
-- Les modèles étaient classés par catégorie figée — pipeline, readme, fichier —
-- ce qui interdisait de grouper ce qui va ensemble : « service Go », « service
-- Node », « conformité ». Un dossier rassemble les fichiers d'un même usage et
-- s'ajoute en bloc à la création d'une application.
--
-- La catégorie est conservée : elle sert encore à savoir qu'un fichier est un
-- workflow, donc qu'un jeton doit accompagner son écriture.

CREATE TABLE IF NOT EXISTS template_folders (
    id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',

    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (org_id, name)
);

CREATE INDEX IF NOT EXISTS idx_template_folders_org
    ON template_folders(org_id, name);

-- Un modèle appartient à un dossier, ou reste à la racine.
ALTER TABLE file_templates
    ADD COLUMN IF NOT EXISTS folder_id UUID
    REFERENCES template_folders(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_file_templates_folder
    ON file_templates(folder_id);

-- Le nom n'a plus à être unique dans toute l'organisation : deux dossiers
-- peuvent proposer leur propre « Dockerfile ».
ALTER TABLE file_templates DROP CONSTRAINT IF EXISTS file_templates_org_id_name_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_file_templates_unique_name
    ON file_templates(org_id, COALESCE(folder_id, '00000000-0000-0000-0000-000000000000'::uuid), name);
