-- Golden paths : un dossier de modèles devient un type d'application.
--
-- Un dossier rassemblait déjà les fichiers d'un même usage. Il lui manquait ce
-- qui distingue vraiment un service Node d'un service Go : le port qu'il
-- écoute, la mémoire qu'il consomme, le délai avant qu'il réponde à une sonde.
-- Ces valeurs étaient identiques pour tout le monde, ce qui est faux pour tout
-- le monde.
--
-- Elles ne sont qu'un point de départ : le parcours de création les recopie
-- dans l'application, qui les possède ensuite. Modifier un golden path ne
-- retouche donc aucune application existante — une équipe qui a ajusté la
-- mémoire de son service ne se la verra pas reprendre.

ALTER TABLE template_folders
    -- Ce qui en fait un type proposable à la création. Un dossier ordinaire
    -- (« conformité », « docs ») n'a pas vocation à être un point de départ.
    ADD COLUMN IF NOT EXISTS is_golden_path BOOLEAN NOT NULL DEFAULT false,

    -- Identité visuelle, pour la carte du sélecteur.
    ADD COLUMN IF NOT EXISTS icon TEXT NOT NULL DEFAULT '',

    -- Port par défaut de l'exécution : 3000 pour Node, 8000 pour Python.
    ADD COLUMN IF NOT EXISTS default_port INTEGER,

    -- Ressources, au format Kubernetes ('256Mi', '500m'). Vides = les défauts
    -- de l'instance s'appliquent.
    ADD COLUMN IF NOT EXISTS cpu_request TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS memory_request TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS cpu_limit TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS memory_limit TEXT NOT NULL DEFAULT '',

    -- Sonde de vivacité : le chemin et le délai de démarrage varient
    -- énormément d'un écosystème à l'autre.
    ADD COLUMN IF NOT EXISTS probe_path TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS probe_initial_delay INTEGER,

    -- L'utilisateur non-root imposé par l'image de base officielle.
    ADD COLUMN IF NOT EXISTS run_as_user INTEGER;

-- Le sélecteur ne liste que les types : l'index suit cet accès.
CREATE INDEX IF NOT EXISTS idx_template_folders_golden
    ON template_folders(org_id, name) WHERE is_golden_path;
