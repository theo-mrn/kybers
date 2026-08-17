-- Image de référence d'un type, pour lister ses versions réelles.
--
-- Les versions étaient figées dans une colonne texte : '24,22,20'. Elles
-- vieillissaient sans que personne ne les mette à jour, et ne permettaient pas
-- de choisir un correctif précis — 22.11.0 plutôt que 22.
--
-- En nommant l'image de base, Kybers interroge le registre et propose les tags
-- réellement publiés. La colonne `versions` reste comme repli : un type
-- personnalisé peut viser une image privée que le dashboard ne sait pas lire.

ALTER TABLE template_folders
    -- Image Docker Hub dont les tags font les versions : 'node', 'python',
    -- 'golang'. Vide = versions figées dans la colonne `versions`.
    ADD COLUMN IF NOT EXISTS runtime_image TEXT NOT NULL DEFAULT '';

COMMENT ON COLUMN template_folders.versions IS
    'Versions de repli, si runtime_image est vide ou le registre injoignable.';
