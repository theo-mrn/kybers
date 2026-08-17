-- Version du runtime : le vrai paramètre d'un type.
--
-- La 014 permettait de régler une icône et un UID d'exécution — des détails que
-- personne ne saisit à la main. Ce qu'on choisit en créant un service Node,
-- c'est Node 20, 22 ou 24 : la version se propage dans le FROM du Dockerfile,
-- les engines du manifeste et le workflow.
--
-- Elle est portée par une substitution {{version}}, appliquée aux fichiers du
-- type comme les autres.

ALTER TABLE template_folders
    -- Versions proposées, de la plus récente à la plus ancienne, séparées par
    -- des virgules : '24,22,20'. Vide = le type n'est pas versionné.
    ADD COLUMN IF NOT EXISTS versions TEXT NOT NULL DEFAULT '',
    -- Celle retenue quand l'utilisateur ne choisit pas.
    ADD COLUMN IF NOT EXISTS default_version TEXT NOT NULL DEFAULT '';

-- L'icône se déduit du type, l'UID vient de l'image de base : ni l'un ni
-- l'autre n'a sa place dans un formulaire. Les colonnes restent — les
-- supprimer casserait les instances qui les ont déjà écrites — mais ne sont
-- plus exposées à la saisie.
COMMENT ON COLUMN template_folders.icon IS
    'Déduit du nom du type ; non saisissable.';
COMMENT ON COLUMN template_folders.run_as_user IS
    'Imposé par l''image de base ; non saisissable.';
