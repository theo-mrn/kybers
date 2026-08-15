-- Provenance d'une révision : quel code tourne réellement.
--
-- Kybers ne construit pas les images — le CI du client s'en charge. Ces champs
-- sont donc renseignés par l'appelant au moment du déploiement, à titre de
-- traçabilité : ils ne déclenchent rien et restent facultatifs.

ALTER TABLE deployments ADD COLUMN IF NOT EXISTS git_commit  TEXT NOT NULL DEFAULT '';
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS git_ref     TEXT NOT NULL DEFAULT '';
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS git_message TEXT NOT NULL DEFAULT '';

-- Origine du déploiement : « ci », « dashboard », « cli »… Permet de distinguer
-- un déploiement automatisé d'une action manuelle dans le journal d'activité.
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT '';
