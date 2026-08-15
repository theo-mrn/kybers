-- Réglages de l'instance, modifiables depuis l'interface.
--
-- Certains paramètres — le jeton Git, notamment — ne peuvent pas rester
-- réservés aux variables d'environnement : les renseigner imposerait un accès
-- au serveur et un redémarrage, alors qu'ils relèvent de l'administration
-- courante. La variable d'environnement reste prioritaire quand elle existe,
-- pour que les déploiements pilotés par configuration gardent la main.
--
-- Les valeurs sensibles sont chiffrées avant écriture, comme les mots de passe
-- de registry.

CREATE TABLE IF NOT EXISTS instance_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL DEFAULT '',
    /** Vrai quand la valeur est chiffrée et ne doit jamais être relue en clair. */
    secret     BOOLEAN NOT NULL DEFAULT false,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL
);
