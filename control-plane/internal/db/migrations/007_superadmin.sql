-- Sépare le super-administrateur des administrateurs de plateforme.
--
-- `is_admin` confondait deux rôles très différents : celui qui a installé
-- l'instance, et ceux à qui il délègue la gestion des comptes. Résultat, deux
-- « admins » pouvaient se rétrograder mutuellement — le plus rapide gagnait.
--
-- La hiérarchie devient stricte, chacun ne modifiant que le niveau inférieur :
--
--   super-admin   unique, créé au bootstrap, jamais attribuable ensuite
--   admin         en nombre libre, nommés par le super-admin
--   admin d'org   `owner` dans org_members
--   membre / lecteur
--
-- Le super-admin ne peut pas être créé après coup : c'est ce qui rend le
-- sommet de la hiérarchie stable. Sans cela, un admin pourrait s'auto-promouvoir
-- et le niveau au-dessus perdrait tout sens.

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_superadmin BOOLEAN NOT NULL DEFAULT FALSE;

-- Le compte de bootstrap devient super-admin : c'est le plus ancien admin,
-- celui qui a créé l'instance. Les autres restent de simples admins.
UPDATE users SET is_superadmin = TRUE
WHERE id = (
    SELECT id FROM users WHERE is_admin ORDER BY created_at LIMIT 1
)
AND NOT EXISTS (SELECT 1 FROM users WHERE is_superadmin);

-- Unicité garantie en base, pas seulement dans le code : un index partiel
-- interdit qu'un second super-admin apparaisse, quelle qu'en soit la voie.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_single_superadmin
    ON users ((TRUE)) WHERE is_superadmin;
