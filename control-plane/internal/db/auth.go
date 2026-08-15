package db

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/kybers/kybers/control-plane/internal/auth"
	"github.com/kybers/kybers/control-plane/internal/models"
)

// ErrNotFound distingue « absent » d'une erreur technique : les handlers
// répondent 401/404 dans un cas, 500 dans l'autre.
var ErrNotFound = errors.New("introuvable")

// ---------------------------------------------------------------------------
// Utilisateurs
// ---------------------------------------------------------------------------

// CreateUser crée un compte. L'email est normalisé et le mot de passe haché
// par l'appelant : cette couche ne manipule jamais de mot de passe en clair.
func (d *DB) CreateUser(ctx context.Context, email, name, passwordHash string) (*models.User, error) {
	var u models.User
	err := d.Pool.QueryRow(ctx, `
		INSERT INTO users (email, name, password_hash)
		VALUES ($1, $2, $3)
		RETURNING id, email, name, created_at`,
		auth.NormalizeEmail(email), name, passwordHash,
	).Scan(&u.ID, &u.Email, &u.Name, &u.CreatedAt)
	if err != nil {
		return nil, err
	}
	return &u, nil
}

// GetUserByEmail retourne l'utilisateur ET son hash, pour la vérification du
// mot de passe. Le hash ne quitte jamais la couche d'authentification.
func (d *DB) GetUserByEmail(ctx context.Context, email string) (*models.User, string, error) {
	var u models.User
	var hash string
	err := d.Pool.QueryRow(ctx, `
		SELECT id, email, name, password_hash, created_at, last_login_at,
		       is_admin, is_superadmin, must_change_password, disabled
		FROM users WHERE lower(email) = $1`, auth.NormalizeEmail(email),
	).Scan(&u.ID, &u.Email, &u.Name, &hash, &u.CreatedAt, &u.LastLoginAt,
		&u.IsAdmin, &u.IsSuperAdmin, &u.MustChangePassword, &u.Disabled)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, "", ErrNotFound
	}
	if err != nil {
		return nil, "", err
	}
	return &u, hash, nil
}

func (d *DB) GetUser(ctx context.Context, id string) (*models.User, error) {
	var u models.User
	err := d.Pool.QueryRow(ctx, `
		SELECT id, email, name, created_at, last_login_at,
		       is_admin, is_superadmin, must_change_password, disabled
		FROM users WHERE id = $1`, id,
	).Scan(&u.ID, &u.Email, &u.Name, &u.CreatedAt, &u.LastLoginAt,
		&u.IsAdmin, &u.IsSuperAdmin, &u.MustChangePassword, &u.Disabled)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	return &u, err
}

func (d *DB) TouchUserLogin(ctx context.Context, id string) error {
	_, err := d.Pool.Exec(ctx, `UPDATE users SET last_login_at = now() WHERE id = $1`, id)
	return err
}

func (d *DB) UpdatePassword(ctx context.Context, userID, passwordHash string) error {
	_, err := d.Pool.Exec(ctx,
		`UPDATE users SET password_hash = $2 WHERE id = $1`, userID, passwordHash)
	return err
}

// CountUsers sert à détecter la première installation : le premier compte créé
// devient propriétaire sans invitation.
func (d *DB) CountUsers(ctx context.Context) (int, error) {
	var n int
	err := d.Pool.QueryRow(ctx, `SELECT count(*) FROM users`).Scan(&n)
	return n, err
}

// ---------------------------------------------------------------------------
// Organisations
// ---------------------------------------------------------------------------

// CreateOrganization crée une organisation et y place son créateur comme
// propriétaire, en une transaction : une organisation sans membre serait
// inaccessible.
func (d *DB) CreateOrganization(ctx context.Context, slug, name, ownerID string) (*models.Organization, error) {
	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op après Commit

	var o models.Organization
	if err := tx.QueryRow(ctx, `
		INSERT INTO organizations (slug, name) VALUES ($1, $2)
		RETURNING id, slug, name, created_at`, slug, name,
	).Scan(&o.ID, &o.Slug, &o.Name, &o.CreatedAt); err != nil {
		return nil, err
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, $3)`,
		o.ID, ownerID, auth.RoleOwner); err != nil {
		return nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	o.Role = auth.RoleOwner
	return &o, nil
}

// ListUserOrganizations retourne les organisations d'un utilisateur, avec son
// rôle dans chacune.
func (d *DB) ListUserOrganizations(ctx context.Context, userID string) ([]models.Organization, error) {
	rows, err := d.Pool.Query(ctx, `
		SELECT o.id, o.slug, o.name, o.created_at, m.role
		FROM organizations o
		JOIN org_members m ON m.org_id = o.id
		WHERE m.user_id = $1
		ORDER BY o.created_at`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []models.Organization{}
	for rows.Next() {
		var o models.Organization
		if err := rows.Scan(&o.ID, &o.Slug, &o.Name, &o.CreatedAt, &o.Role); err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

// GetMembership retourne le rôle d'un utilisateur dans une organisation.
// ErrNotFound signifie qu'il n'en est pas membre — donc qu'il n'y a pas accès.
func (d *DB) GetMembership(ctx context.Context, orgID, userID string) (string, error) {
	var role string
	err := d.Pool.QueryRow(ctx, `
		SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2`,
		orgID, userID).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	return role, err
}

func (d *DB) GetOrganizationBySlug(ctx context.Context, slug string) (*models.Organization, error) {
	var o models.Organization
	err := d.Pool.QueryRow(ctx, `
		SELECT id, slug, name, created_at FROM organizations WHERE slug = $1`, slug,
	).Scan(&o.ID, &o.Slug, &o.Name, &o.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	return &o, err
}

// ListMembers retourne les membres d'une organisation.
func (d *DB) ListMembers(ctx context.Context, orgID string) ([]models.Member, error) {
	rows, err := d.Pool.Query(ctx, `
		SELECT u.id, u.email, u.name, m.role, m.joined_at,
		       u.is_admin, u.is_superadmin
		FROM org_members m JOIN users u ON u.id = m.user_id
		WHERE m.org_id = $1
		ORDER BY m.joined_at`, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []models.Member{}
	for rows.Next() {
		var m models.Member
		if err := rows.Scan(&m.UserID, &m.Email, &m.Name, &m.Role, &m.JoinedAt,
			&m.IsAdmin, &m.IsSuperAdmin); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// AddMember ajoute ou met à jour le rôle d'un membre.
func (d *DB) AddMember(ctx context.Context, orgID, userID, role string) error {
	_, err := d.Pool.Exec(ctx, `
		INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, $3)
		ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
		orgID, userID, role)
	return err
}

// ErrLastOwner signale le retrait du dernier propriétaire d'une organisation.
// Sentinelle plutôt qu'erreur anonyme : les handlers doivent répondre 409 avec
// une explication, pas 500.
var ErrLastOwner = errors.New("dernier propriétaire")

// RemoveMember retire un membre, sauf s'il est le dernier propriétaire :
// l'organisation deviendrait alors ingérable.
func (d *DB) RemoveMember(ctx context.Context, orgID, userID string) error {
	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var owners int
	if err := tx.QueryRow(ctx, `
		SELECT count(*) FROM org_members WHERE org_id = $1 AND role = $2`,
		orgID, auth.RoleOwner).Scan(&owners); err != nil {
		return err
	}

	var role string
	if err := tx.QueryRow(ctx, `
		SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2`,
		orgID, userID).Scan(&role); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}

	if role == auth.RoleOwner && owners <= 1 {
		return ErrLastOwner
	}

	if _, err := tx.Exec(ctx,
		`DELETE FROM org_members WHERE org_id = $1 AND user_id = $2`, orgID, userID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

func (d *DB) CreateSession(ctx context.Context, userID, tokenHash, userAgent string, expiresAt time.Time) error {
	_, err := d.Pool.Exec(ctx, `
		INSERT INTO sessions (user_id, token_hash, expires_at, user_agent)
		VALUES ($1, $2, $3, $4)`, userID, tokenHash, expiresAt, userAgent)
	return err
}

// GetSessionUser résout une session en utilisateur. Une session expirée est
// traitée comme absente.
func (d *DB) GetSessionUser(ctx context.Context, tokenHash string) (*models.User, error) {
	var u models.User
	err := d.Pool.QueryRow(ctx, `
		SELECT u.id, u.email, u.name, u.created_at, u.last_login_at,
		       u.is_admin, u.is_superadmin, u.must_change_password, u.disabled
		FROM sessions s JOIN users u ON u.id = s.user_id
		WHERE s.token_hash = $1 AND s.expires_at > now() AND NOT u.disabled`, tokenHash,
	).Scan(&u.ID, &u.Email, &u.Name, &u.CreatedAt, &u.LastLoginAt,
		&u.IsAdmin, &u.IsSuperAdmin, &u.MustChangePassword, &u.Disabled)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}

	// Trace de dernière utilisation, sans bloquer la requête si elle échoue.
	_, _ = d.Pool.Exec(ctx,
		`UPDATE sessions SET last_used_at = now() WHERE token_hash = $1`, tokenHash)
	return &u, nil
}

func (d *DB) DeleteSession(ctx context.Context, tokenHash string) error {
	_, err := d.Pool.Exec(ctx, `DELETE FROM sessions WHERE token_hash = $1`, tokenHash)
	return err
}

// DeleteUserSessions déconnecte un utilisateur partout : utile après un
// changement de mot de passe.
func (d *DB) DeleteUserSessions(ctx context.Context, userID string) error {
	_, err := d.Pool.Exec(ctx, `DELETE FROM sessions WHERE user_id = $1`, userID)
	return err
}

func (d *DB) PurgeExpiredSessions(ctx context.Context) (int64, error) {
	tag, err := d.Pool.Exec(ctx, `DELETE FROM sessions WHERE expires_at < now()`)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// ---------------------------------------------------------------------------
// Jetons d'API
// ---------------------------------------------------------------------------

func (d *DB) CreateAPIToken(ctx context.Context, userID, orgID, name, tokenHash, prefix string, expiresAt *time.Time) (*models.APIToken, error) {
	var t models.APIToken
	var org *string
	if orgID != "" {
		org = &orgID
	}
	err := d.Pool.QueryRow(ctx, `
		INSERT INTO api_tokens (user_id, org_id, name, token_hash, prefix, expires_at)
		VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING id, name, prefix, expires_at, created_at`,
		userID, org, name, tokenHash, prefix, expiresAt,
	).Scan(&t.ID, &t.Name, &t.Prefix, &t.ExpiresAt, &t.CreatedAt)
	if err != nil {
		return nil, err
	}
	return &t, nil
}

// GetAPITokenUser résout un jeton en utilisateur. Un jeton expiré est traité
// comme absent.
func (d *DB) GetAPITokenUser(ctx context.Context, tokenHash string) (*models.User, error) {
	var u models.User
	err := d.Pool.QueryRow(ctx, `
		SELECT u.id, u.email, u.name, u.created_at, u.last_login_at,
		       u.is_admin, u.is_superadmin, u.must_change_password, u.disabled
		FROM api_tokens t JOIN users u ON u.id = t.user_id
		WHERE t.token_hash = $1 AND (t.expires_at IS NULL OR t.expires_at > now())
		  AND NOT u.disabled`,
		tokenHash,
	).Scan(&u.ID, &u.Email, &u.Name, &u.CreatedAt, &u.LastLoginAt,
		&u.IsAdmin, &u.IsSuperAdmin, &u.MustChangePassword, &u.Disabled)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}

	_, _ = d.Pool.Exec(ctx,
		`UPDATE api_tokens SET last_used_at = now() WHERE token_hash = $1`, tokenHash)
	return &u, nil
}

func (d *DB) ListAPITokens(ctx context.Context, userID string) ([]models.APIToken, error) {
	rows, err := d.Pool.Query(ctx, `
		SELECT id, name, prefix, expires_at, last_used_at, created_at
		FROM api_tokens WHERE user_id = $1 ORDER BY created_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []models.APIToken{}
	for rows.Next() {
		var t models.APIToken
		if err := rows.Scan(&t.ID, &t.Name, &t.Prefix, &t.ExpiresAt,
			&t.LastUsedAt, &t.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// DeleteAPIToken révoque un jeton. La contrainte sur user_id empêche de
// révoquer le jeton d'un autre utilisateur.
func (d *DB) DeleteAPIToken(ctx context.Context, userID, tokenID string) error {
	tag, err := d.Pool.Exec(ctx,
		`DELETE FROM api_tokens WHERE id = $1 AND user_id = $2`, tokenID, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// ---------------------------------------------------------------------------
// Administration : comptes créés par un admin
// ---------------------------------------------------------------------------

// CreateUserAsAdmin crée un compte au nom d'un administrateur.
//
// mustChange force le changement de mot de passe à la première connexion :
// l'admin connaît le mot de passe initial, l'utilisateur doit le remplacer.
// PromoteToSuperAdmin marque le compte de bootstrap comme super-administrateur.
//
// Volontairement conditionnée à l'absence de tout autre super-admin, et sans
// équivalent exposé par l'API : ce statut se gagne à l'installation, jamais par
// promotion. Un index unique en base double cette garantie.
func (d *DB) PromoteToSuperAdmin(ctx context.Context, userID string) error {
	tag, err := d.Pool.Exec(ctx, `
		UPDATE users SET is_superadmin = TRUE, is_admin = TRUE
		WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM users WHERE is_superadmin)`,
		userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return errors.New("un super-administrateur existe déjà")
	}
	return nil
}

func (d *DB) CreateUserAsAdmin(ctx context.Context, email, name, passwordHash, createdBy string, isAdmin, mustChange bool) (*models.User, error) {
	// Le tout premier compte n'a pas de créateur : PostgreSQL attend NULL, pas
	// une chaîne vide, pour une colonne UUID.
	var creator *string
	if createdBy != "" {
		creator = &createdBy
	}

	var u models.User
	err := d.Pool.QueryRow(ctx, `
		INSERT INTO users (email, name, password_hash, created_by, is_admin, must_change_password)
		VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING id, email, name, created_at, is_admin, is_superadmin, must_change_password, disabled`,
		auth.NormalizeEmail(email), name, passwordHash, creator, isAdmin, mustChange,
	).Scan(&u.ID, &u.Email, &u.Name, &u.CreatedAt, &u.IsAdmin, &u.IsSuperAdmin, &u.MustChangePassword, &u.Disabled)
	if err != nil {
		return nil, err
	}
	return &u, nil
}

// ListAllUsers retourne tous les comptes de la plateforme. Réservé aux admins.
func (d *DB) ListAllUsers(ctx context.Context) ([]models.User, error) {
	rows, err := d.Pool.Query(ctx, `
		SELECT id, email, name, created_at, last_login_at,
		       is_admin, is_superadmin, must_change_password, disabled
		FROM users ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []models.User{}
	for rows.Next() {
		var u models.User
		if err := rows.Scan(&u.ID, &u.Email, &u.Name, &u.CreatedAt, &u.LastLoginAt,
			&u.IsAdmin, &u.IsSuperAdmin, &u.MustChangePassword, &u.Disabled); err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

// SetUserAdmin promeut ou rétrograde un administrateur.
func (d *DB) SetUserAdmin(ctx context.Context, userID string, isAdmin bool) error {
	_, err := d.Pool.Exec(ctx, `UPDATE users SET is_admin = $2 WHERE id = $1`, userID, isAdmin)
	return err
}

// SetUserDisabled désactive un compte sans le supprimer : ses déploiements et
// son historique restent attribuables.
func (d *DB) SetUserDisabled(ctx context.Context, userID string, disabled bool) error {
	if disabled {
		// Un compte désactivé doit perdre ses sessions immédiatement, sinon il
		// resterait connecté jusqu'à leur expiration.
		_, _ = d.Pool.Exec(ctx, `DELETE FROM sessions WHERE user_id = $1`, userID)
	}
	_, err := d.Pool.Exec(ctx, `UPDATE users SET disabled = $2 WHERE id = $1`, userID, disabled)
	return err
}

// ResetPassword impose un nouveau mot de passe temporaire.
func (d *DB) ResetPassword(ctx context.Context, userID, passwordHash string) error {
	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	if _, err := tx.Exec(ctx, `
		UPDATE users SET password_hash = $2, must_change_password = TRUE
		WHERE id = $1`, userID, passwordHash); err != nil {
		return err
	}
	// Les sessions ouvertes deviennent caduques : un mot de passe réinitialisé
	// signifie souvent un accès compromis.
	if _, err := tx.Exec(ctx, `DELETE FROM sessions WHERE user_id = $1`, userID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ClearMustChangePassword lève l'obligation, une fois le mot de passe changé.
func (d *DB) ClearMustChangePassword(ctx context.Context, userID string) error {
	_, err := d.Pool.Exec(ctx,
		`UPDATE users SET must_change_password = FALSE WHERE id = $1`, userID)
	return err
}

// CountAdmins sert à empêcher la suppression du dernier administrateur.
func (d *DB) CountAdmins(ctx context.Context) (int, error) {
	var n int
	err := d.Pool.QueryRow(ctx,
		`SELECT count(*) FROM users WHERE is_admin AND NOT disabled`).Scan(&n)
	return n, err
}

// ---------------------------------------------------------------------------
// Permissions individuelles
// ---------------------------------------------------------------------------

// GetUserPermissions retourne les exceptions accordées ou retirées à un membre.
func (d *DB) GetUserPermissions(ctx context.Context, orgID, userID string) (map[string]bool, error) {
	rows, err := d.Pool.Query(ctx, `
		SELECT permission, granted FROM user_permissions
		WHERE org_id = $1 AND user_id = $2`, orgID, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := map[string]bool{}
	for rows.Next() {
		var perm string
		var granted bool
		if err := rows.Scan(&perm, &granted); err != nil {
			return nil, err
		}
		out[perm] = granted
	}
	return out, rows.Err()
}

// SetUserPermission enregistre une exception individuelle.
func (d *DB) SetUserPermission(ctx context.Context, orgID, userID, permission string, granted bool, grantedBy string) error {
	_, err := d.Pool.Exec(ctx, `
		INSERT INTO user_permissions (org_id, user_id, permission, granted, granted_by)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (org_id, user_id, permission)
		DO UPDATE SET granted = EXCLUDED.granted, granted_by = EXCLUDED.granted_by,
		              granted_at = now()`,
		orgID, userID, permission, granted, grantedBy)
	return err
}

// ClearUserPermission retire l'exception : le rôle reprend la main.
func (d *DB) ClearUserPermission(ctx context.Context, orgID, userID, permission string) error {
	_, err := d.Pool.Exec(ctx, `
		DELETE FROM user_permissions
		WHERE org_id = $1 AND user_id = $2 AND permission = $3`,
		orgID, userID, permission)
	return err
}

// ---------------------------------------------------------------------------
// Journal d'administration
// ---------------------------------------------------------------------------

// LogAdminAction trace une action d'administration. L'échec n'est jamais
// bloquant : un journal indisponible ne doit pas empêcher d'administrer.
func (d *DB) LogAdminAction(ctx context.Context, actorID, action, target string, details any) {
	raw, err := json.Marshal(details)
	if err != nil {
		raw = []byte("{}")
	}
	_, _ = d.Pool.Exec(ctx, `
		INSERT INTO admin_audit (actor_id, action, target, details)
		VALUES ($1, $2, $3, $4)`, actorID, action, target, raw)
}

// ListAllOrganizations retourne toutes les organisations, avec ce qu'elles
// contiennent. Réservé aux administrateurs de la plateforme.
//
// Les sous-requêtes valent mieux que des JOIN cumulés : joindre membres et
// applications dans la même passe multiplierait les lignes et fausserait les
// deux comptes.
func (d *DB) ListAllOrganizations(ctx context.Context) ([]models.Organization, error) {
	rows, err := d.Pool.Query(ctx, `
		SELECT o.id, o.slug, o.name, o.created_at,
		       (SELECT count(*) FROM org_members m WHERE m.org_id = o.id),
		       (SELECT count(*) FROM apps a WHERE a.org_id = o.id)
		FROM organizations o
		ORDER BY o.created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []models.Organization{}
	for rows.Next() {
		var o models.Organization
		if err := rows.Scan(&o.ID, &o.Slug, &o.Name, &o.CreatedAt,
			&o.MemberCount, &o.AppCount); err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

// ErrOrgNotEmpty signale une organisation qui héberge encore des applications.
var ErrOrgNotEmpty = errors.New("organisation non vide")

// DeleteOrganization supprime une organisation, ses membres et ses jetons.
//
// Les applications bloquent la suppression, car `org_id` porte ON DELETE
// CASCADE : effacées en base, elles continueraient de tourner sur le cluster
// sans que personne ne puisse plus les piloter.
//
// Les clusters, eux, appartiennent à la plateforme et non à une organisation :
// supprimer celle-ci ne les touche pas.
func (d *DB) DeleteOrganization(ctx context.Context, orgID string) error {
	var apps int
	err := d.Pool.QueryRow(ctx,
		`SELECT count(*) FROM apps WHERE org_id = $1`, orgID).Scan(&apps)
	if err != nil {
		return err
	}
	if apps > 0 {
		return ErrOrgNotEmpty
	}

	tag, err := d.Pool.Exec(ctx, `DELETE FROM organizations WHERE id = $1`, orgID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// RenameOrganization change le nom affiché. Le slug reste figé : il apparaît
// dans les URL et les jetons déjà distribués.
func (d *DB) RenameOrganization(ctx context.Context, orgID, name string) (*models.Organization, error) {
	var o models.Organization
	err := d.Pool.QueryRow(ctx, `
		UPDATE organizations SET name = $2 WHERE id = $1
		RETURNING id, slug, name, created_at`, orgID, name).
		Scan(&o.ID, &o.Slug, &o.Name, &o.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &o, nil
}
