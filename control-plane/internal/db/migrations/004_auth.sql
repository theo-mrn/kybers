-- Authentification et organisations.
--
-- Modèle : un utilisateur appartient à une ou plusieurs organisations ; toutes
-- les ressources (applications, clusters, registries) appartiennent à une
-- organisation, jamais directement à un utilisateur.

-- ---------------------------------------------------------------------------
-- Utilisateurs
-- ---------------------------------------------------------------------------
-- La table users existait sans jamais servir : on la complète.
-- api_token devient inutile — les jetons vivent dans leur propre table, pour
-- qu'un utilisateur puisse en avoir plusieurs et les révoquer un par un.
ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
ALTER TABLE users ALTER COLUMN api_token DROP NOT NULL;
ALTER TABLE users ALTER COLUMN api_token SET DEFAULT NULL;

-- L'email sert d'identifiant de connexion : la casse ne doit pas créer de
-- doublon (Theo@x.fr et theo@x.fr sont la même personne).
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users (lower(email));

-- ---------------------------------------------------------------------------
-- Organisations
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS organizations (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- slug : identifiant lisible utilisé dans les URL, immuable en pratique.
    slug       TEXT        NOT NULL UNIQUE,
    name       TEXT        NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Rôles : owner peut tout, y compris gérer les membres et supprimer l'org ;
-- member déploie et administre les applications ; viewer lit seulement.
CREATE TABLE IF NOT EXISTS org_members (
    org_id    UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id   UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role      TEXT        NOT NULL DEFAULT 'member',
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, user_id),
    CONSTRAINT org_members_role_valid CHECK (role IN ('owner', 'member', 'viewer'))
);

CREATE INDEX IF NOT EXISTS idx_org_members_user ON org_members(user_id);

-- ---------------------------------------------------------------------------
-- Sessions (dashboard)
-- ---------------------------------------------------------------------------
-- Seul le hash du jeton est stocké : une fuite de la base ne permet pas
-- d'usurper une session.
CREATE TABLE IF NOT EXISTS sessions (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash   TEXT        NOT NULL UNIQUE,
    expires_at   TIMESTAMPTZ NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    user_agent   TEXT        NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- ---------------------------------------------------------------------------
-- Jetons d'API (CLI, CI)
-- ---------------------------------------------------------------------------
-- Comme les sessions, seul le hash est conservé : le jeton en clair n'est
-- affiché qu'à sa création.
CREATE TABLE IF NOT EXISTS api_tokens (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    org_id       UUID        REFERENCES organizations(id) ON DELETE CASCADE,
    name         TEXT        NOT NULL,
    token_hash   TEXT        NOT NULL UNIQUE,
    -- Préfixe affiché dans la liste pour reconnaître un jeton sans le révéler.
    prefix       TEXT        NOT NULL DEFAULT '',
    expires_at   TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON api_tokens(user_id);

-- ---------------------------------------------------------------------------
-- Rattachement des ressources existantes
-- ---------------------------------------------------------------------------
ALTER TABLE apps ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE clusters ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE registries ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES organizations(id) ON DELETE CASCADE;

-- Trace de l'auteur d'un déploiement : « qui a déployé ça ? » est la première
-- question posée quand quelque chose casse.
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_apps_org ON apps(org_id);
CREATE INDEX IF NOT EXISTS idx_clusters_org ON clusters(org_id);
CREATE INDEX IF NOT EXISTS idx_registries_org ON registries(org_id);

-- Le nom d'une application n'est unique qu'AU SEIN d'une organisation : deux
-- équipes peuvent chacune avoir une app « api ».
ALTER TABLE apps DROP CONSTRAINT IF EXISTS apps_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_apps_org_name ON apps(org_id, name);

-- Idem pour les clusters et registries.
ALTER TABLE clusters DROP CONSTRAINT IF EXISTS clusters_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_clusters_org_name ON clusters(org_id, name);
ALTER TABLE registries DROP CONSTRAINT IF EXISTS registries_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_registries_org_name ON registries(org_id, name);

-- ---------------------------------------------------------------------------
-- Migration des données existantes
-- ---------------------------------------------------------------------------
-- Les ressources créées avant l'authentification sont rattachées à une
-- organisation par défaut : sans cela, elles deviendraient invisibles.
INSERT INTO organizations (slug, name)
SELECT 'default', 'Organisation par défaut'
WHERE NOT EXISTS (SELECT 1 FROM organizations)
  AND (EXISTS (SELECT 1 FROM apps) OR EXISTS (SELECT 1 FROM clusters));

UPDATE apps SET org_id = (SELECT id FROM organizations WHERE slug = 'default')
WHERE org_id IS NULL;
UPDATE clusters SET org_id = (SELECT id FROM organizations WHERE slug = 'default')
WHERE org_id IS NULL;
UPDATE registries SET org_id = (SELECT id FROM organizations WHERE slug = 'default')
WHERE org_id IS NULL;
