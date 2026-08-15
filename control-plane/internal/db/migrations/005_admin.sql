-- Administration : comptes créés par un admin, droits individuels.
--
-- Modèle : pas d'auto-inscription. Un administrateur de plateforme crée les
-- comptes, les affecte aux organisations, et peut affiner leurs droits
-- individuellement au-delà du rôle.

-- ---------------------------------------------------------------------------
-- Rôle plateforme
-- ---------------------------------------------------------------------------
-- Distinct du rôle dans une organisation : un admin gère la plateforme
-- (comptes, organisations), pas nécessairement les applications.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;

-- Mot de passe temporaire : tant que ce drapeau est vrai, l'utilisateur ne
-- peut rien faire d'autre que définir son propre mot de passe.
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;

-- Qui a créé ce compte : utile pour l'audit et pour retrouver l'admin à
-- contacter en cas de problème.
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- Un compte désactivé ne peut plus se connecter, sans être supprimé : ses
-- déploiements et son historique restent attribuables.
ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled BOOLEAN NOT NULL DEFAULT FALSE;

-- Le premier compte existant devient administrateur : sans cela, personne ne
-- pourrait plus rien administrer après cette migration.
UPDATE users SET is_admin = TRUE
WHERE id = (SELECT id FROM users ORDER BY created_at LIMIT 1)
  AND NOT EXISTS (SELECT 1 FROM users WHERE is_admin);

-- ---------------------------------------------------------------------------
-- Permissions individuelles
-- ---------------------------------------------------------------------------
-- Affinent le rôle d'un membre dans une organisation : une permission accordée
-- s'ajoute à celles du rôle, une permission refusée les retire.
--
-- Exemple : un « member » qui ne doit pas supprimer d'environnement, ou un
-- « viewer » autorisé à consulter les logs applicatifs.
CREATE TABLE IF NOT EXISTS user_permissions (
    org_id     UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    permission TEXT        NOT NULL,
    -- TRUE = accordée en plus du rôle, FALSE = retirée malgré le rôle.
    granted    BOOLEAN     NOT NULL DEFAULT TRUE,
    granted_by UUID        REFERENCES users(id) ON DELETE SET NULL,
    granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, user_id, permission)
);

CREATE INDEX IF NOT EXISTS idx_user_permissions_lookup
    ON user_permissions(org_id, user_id);

-- ---------------------------------------------------------------------------
-- Journal d'administration
-- ---------------------------------------------------------------------------
-- « Qui a donné ce droit, et quand ? » doit avoir une réponse.
CREATE TABLE IF NOT EXISTS admin_audit (
    id         BIGSERIAL PRIMARY KEY,
    actor_id   UUID        REFERENCES users(id) ON DELETE SET NULL,
    action     TEXT        NOT NULL,
    target     TEXT        NOT NULL DEFAULT '',
    details    JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit(created_at DESC);
