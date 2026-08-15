-- L'unicité d'un modèle porte sur son chemin, pas sur son nom.
--
-- La 012 imposait un nom unique par dossier. C'était un reste de l'époque où
-- le nom identifiait le modèle : depuis, le nom se pré-remplit avec le nom du
-- fichier, si bien qu'un dossier « Readme » contenant deux README destinés à
-- des chemins différents — `docs/A.md` et `docs/B.md` — était refusé.
--
-- Ce qui ne peut pas coexister, c'est deux modèles écrivant au même endroit :
-- `PutFile` étant un upsert, le second écraserait le premier en silence. La
-- contrainte suit donc le chemin, et le nom redevient une simple étiquette.

DROP INDEX IF EXISTS idx_file_templates_unique_name;

-- Le dossier reste dans la clé : deux bundles peuvent proposer chacun leur
-- version de `.github/workflows/deploy.yml`, on n'en coche qu'une à la fois.
CREATE UNIQUE INDEX IF NOT EXISTS idx_file_templates_unique_path
    ON file_templates(org_id, COALESCE(folder_id, '00000000-0000-0000-0000-000000000000'::uuid), path);
