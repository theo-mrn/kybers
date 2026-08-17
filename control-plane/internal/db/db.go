// Package db encapsule l'accès PostgreSQL du Control Plane.
package db

import (
	"context"
	"embed"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kybers/kybers/control-plane/internal/crypto"
	"github.com/kybers/kybers/control-plane/internal/models"
)

//go:embed all:migrations
var migrationsFS embed.FS

type DB struct {
	Pool *pgxpool.Pool
	// Chiffre les secrets applicatifs (mots de passe de registry, variables
	// sensibles) avant écriture en base.
	Cipher *crypto.Cipher
}

// Connect ouvre le pool et attend que Postgres réponde. Le compose démarre les
// deux services en parallèle, donc on retente pendant ~30s avant d'abandonner.
func Connect(ctx context.Context, dsn string, cipher *crypto.Cipher) (*DB, error) {
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, fmt.Errorf("pgxpool: %w", err)
	}

	var lastErr error
	for i := 0; i < 30; i++ {
		if err := pool.Ping(ctx); err == nil {
			return &DB{Pool: pool, Cipher: cipher}, nil
		} else {
			lastErr = err
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(time.Second):
		}
	}
	pool.Close()
	return nil, fmt.Errorf("postgres injoignable: %w", lastErr)
}

func (d *DB) Close() { d.Pool.Close() }

// Migrate applique les fichiers SQL embarqués. Ils sont idempotents
// (CREATE TABLE IF NOT EXISTS), donc rejouables à chaque démarrage.
func (d *DB) Migrate(ctx context.Context) error {
	// Sans registre, chaque démarrage rejouait toute l'histoire : cela n'a
	// tenu que tant que tout était idempotent, et cassait dès qu'une migration
	// ultérieure défaisait la précédente.
	if _, err := d.Pool.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS schema_migrations (
			name       TEXT PRIMARY KEY,
			applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
		)`); err != nil {
		return err
	}

	applied := map[string]bool{}
	rows, err := d.Pool.Query(ctx, `SELECT name FROM schema_migrations`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			rows.Close()
			return err
		}
		applied[name] = true
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	entries, err := migrationsFS.ReadDir("migrations")
	if err != nil {
		return err
	}
	// L'ordre est significatif : 002 modifie des tables créées par 001.
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	sort.Strings(names)

	for _, name := range names {
		if applied[name] {
			continue
		}
		sql, err := migrationsFS.ReadFile("migrations/" + name)
		if err != nil {
			return err
		}

		// Une migration et son enregistrement forment un tout : les séparer
		// laisserait une migration appliquée mais non retenue, donc rejouée.
		tx, err := d.Pool.Begin(ctx)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, string(sql)); err != nil {
			tx.Rollback(ctx)
			return fmt.Errorf("migration %s: %w", name, err)
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO schema_migrations (name) VALUES ($1)`, name); err != nil {
			tx.Rollback(ctx)
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
	}
	return nil
}

// ---------------------------------------------------------------------------
// Apps
// ---------------------------------------------------------------------------

// CreateApp crée une application. clusterID vide laisse le choix au dispatcher,
// ce qui n'est sûr que si un seul cluster est connecté.
func (d *DB) CreateApp(ctx context.Context, orgID, name, gitRepo string, port int, clusterID *string) (*models.App, error) {
	var a models.App
	err := d.Pool.QueryRow(ctx, `
		INSERT INTO apps (org_id, name, git_repo, container_port, cluster_id)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id, name, git_repo, container_port, cluster_id, created_at`,
		orgID, name, gitRepo, port, clusterID,
	).Scan(&a.ID, &a.Name, &a.GitRepo, &a.ContainerPort, &a.ClusterID, &a.CreatedAt)
	if err != nil {
		return nil, err
	}

	// Toute application a au moins un port : celui de sa création, exposé.
	if port > 0 {
		if err := d.SetAppPorts(ctx, a.ID, []models.AppPort{
			{Port: port, Name: "http", Exposed: true, Protocol: "TCP"},
		}); err != nil {
			return nil, err
		}
		a.Ports, _ = d.ListAppPorts(ctx, a.ID)
	}
	return &a, nil
}

// ListApps ne retourne que les applications de l'organisation : le filtre est
// porté par la requête, pas par l'appelant, pour qu'aucun handler ne puisse
// l'oublier.
func (d *DB) ListApps(ctx context.Context, orgID string) ([]models.App, error) {
	rows, err := d.Pool.Query(ctx, `
		SELECT id, name, git_repo, container_port, cluster_id, created_at
		FROM apps WHERE org_id = $1 ORDER BY created_at DESC`, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	apps := []models.App{}
	for rows.Next() {
		var a models.App
		if err := rows.Scan(&a.ID, &a.Name, &a.GitRepo, &a.ContainerPort, &a.ClusterID, &a.CreatedAt); err != nil {
			return nil, err
		}
		apps = append(apps, a)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	ids := make([]string, len(apps))
	for i, a := range apps {
		ids[i] = a.ID
	}
	byApp, err := d.listPortsFor(ctx, ids)
	if err != nil {
		return nil, err
	}
	for i := range apps {
		apps[i].Ports = byApp[apps[i].ID]
	}
	return apps, nil
}

// GetApp exige l'organisation : demander une application d'une autre
// organisation retourne « introuvable », sans révéler son existence.
func (d *DB) GetApp(ctx context.Context, orgID, id string) (*models.App, error) {
	var a models.App
	err := d.Pool.QueryRow(ctx, `
		SELECT id, name, git_repo, container_port, cluster_id, created_at
		FROM apps WHERE id = $1 AND org_id = $2`, id, orgID,
	).Scan(&a.ID, &a.Name, &a.GitRepo, &a.ContainerPort, &a.ClusterID, &a.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	a.Ports, err = d.ListAppPorts(ctx, a.ID)
	if err != nil {
		return nil, err
	}
	return &a, nil
}

// GetAppUnscoped sert au dispatcher, qui agit hors requête utilisateur.
func (d *DB) GetAppUnscoped(ctx context.Context, id string) (*models.App, error) {
	var a models.App
	err := d.Pool.QueryRow(ctx, `
		SELECT id, name, git_repo, container_port, cluster_id, created_at
		FROM apps WHERE id = $1`, id,
	).Scan(&a.ID, &a.Name, &a.GitRepo, &a.ContainerPort, &a.ClusterID, &a.CreatedAt)
	if err != nil {
		return nil, err
	}
	// C'est ce chemin qu'emprunte le dispatcher : sans les ports, l'agent ne
	// recevrait que le port principal.
	a.Ports, err = d.ListAppPorts(ctx, a.ID)
	if err != nil {
		return nil, err
	}
	return &a, nil
}

// SetAppRepo rattache — ou détache — un dépôt Git à une application.
func (d *DB) SetAppRepo(ctx context.Context, appID, repo string) error {
	_, err := d.Pool.Exec(ctx,
		`UPDATE apps SET git_repo = $2 WHERE id = $1`, appID, repo)
	return err
}

// ---------------------------------------------------------------------------
// Variables d'environnement
// ---------------------------------------------------------------------------

func (d *DB) SetEnvVars(ctx context.Context, appID, environment string, vars []models.EnvVar) error {
	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op après Commit

	for _, v := range vars {
		if _, err := tx.Exec(ctx, `
			INSERT INTO env_vars (app_id, environment, key, value)
			VALUES ($1, $2, $3, $4)
			ON CONFLICT (app_id, environment, key) DO UPDATE SET value = EXCLUDED.value`,
			appID, environment, v.Key, v.Value); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (d *DB) GetEnvVars(ctx context.Context, appID, environment string) (map[string]string, error) {
	rows, err := d.Pool.Query(ctx, `
		SELECT key, value FROM env_vars WHERE app_id = $1 AND environment = $2`,
		appID, environment)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := map[string]string{}
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		out[k] = v
	}
	return out, rows.Err()
}

// ---------------------------------------------------------------------------
// Déploiements
// ---------------------------------------------------------------------------

func (d *DB) GetDeployment(ctx context.Context, id string) (*models.Deployment, error) {
	var dep models.Deployment
	err := d.Pool.QueryRow(ctx, `
		SELECT d.id, d.app_id, a.name, d.environment, d.image, d.replicas, d.host,
		       d.status, d.message, d.reason, d.url, d.revision, d.rolled_back_from,
		       d.git_commit, d.git_ref, d.git_message, d.source,
		       d.created_at, d.updated_at
		FROM deployments d JOIN apps a ON a.id = d.app_id
		WHERE d.id = $1`, id,
	).Scan(&dep.ID, &dep.AppID, &dep.AppName, &dep.Environment, &dep.Image, &dep.Replicas,
		&dep.Host, &dep.Status, &dep.Message, &dep.Reason, &dep.URL, &dep.Revision,
		&dep.RolledBack,
		&dep.GitCommit, &dep.GitRef, &dep.GitMessage, &dep.Source,
		&dep.CreatedAt, &dep.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return &dep, nil
}

func (d *DB) ListDeployments(ctx context.Context, orgID string) ([]models.Deployment, error) {
	rows, err := d.Pool.Query(ctx, `
		SELECT d.id, d.app_id, a.name, d.environment, d.image, d.replicas, d.host,
		       d.status, d.message, d.reason, d.url, d.revision, d.rolled_back_from,
		       d.git_commit, d.git_ref, d.git_message, d.source,
		       d.created_at, d.updated_at
		FROM deployments d JOIN apps a ON a.id = d.app_id
		WHERE a.org_id = $1
		ORDER BY d.created_at DESC LIMIT 100`, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanDeployments(rows)
}

// ClaimPendingDeployments passe les déploiements "pending" à "dispatched" et
// les retourne. L'UPDATE ... RETURNING est atomique : si plusieurs instances du
// Control Plane tournent, chaque déploiement n'est réclamé qu'une seule fois.
func (d *DB) ClaimPendingDeployments(ctx context.Context, limit int) ([]models.Deployment, error) {
	rows, err := d.Pool.Query(ctx, `
		UPDATE deployments SET status = 'dispatched', updated_at = now()
		WHERE id IN (
			SELECT id FROM deployments WHERE status = 'pending'
			ORDER BY created_at LIMIT $1
			FOR UPDATE SKIP LOCKED
		)
		RETURNING id, app_id, environment, image, replicas, host, status, message,
		          reason, url, revision, rolled_back_from, created_at, updated_at`,
		limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []models.Deployment{}
	for rows.Next() {
		var dep models.Deployment
		if err := rows.Scan(&dep.ID, &dep.AppID, &dep.Environment, &dep.Image, &dep.Replicas,
			&dep.Host, &dep.Status, &dep.Message, &dep.Reason, &dep.URL, &dep.Revision,
			&dep.RolledBack, &dep.CreatedAt, &dep.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, dep)
	}
	return out, rows.Err()
}

// ResetToPending remet un déploiement en file d'attente (aucun agent dispo, ou
// échec d'envoi sur le stream).
func (d *DB) ResetToPending(ctx context.Context, id, reason string) error {
	_, err := d.Pool.Exec(ctx, `
		UPDATE deployments SET status = 'pending', message = $2, updated_at = now()
		WHERE id = $1`, id, reason)
	return err
}

func (d *DB) UpdateDeploymentStatus(ctx context.Context, id, status, message, url string) error {
	_, err := d.Pool.Exec(ctx, `
		UPDATE deployments
		SET status = $2, message = $3, url = COALESCE(NULLIF($4, ''), url), updated_at = now()
		WHERE id = $1`, id, status, message, url)
	return err
}

// ---------------------------------------------------------------------------
// Clusters & logs
// ---------------------------------------------------------------------------

// AuthenticateCluster valide le couple (nom, token) présenté par un agent.
func (d *DB) AuthenticateCluster(ctx context.Context, name, token string) (*models.Cluster, error) {
	var c models.Cluster
	err := d.Pool.QueryRow(ctx, `
		SELECT id, name FROM clusters WHERE name = $1 AND token = $2`,
		name, token).Scan(&c.ID, &c.Name)
	if err != nil {
		return nil, err
	}
	return &c, nil
}

func (d *DB) MarkClusterConnected(ctx context.Context, id string, connected bool) error {
	_, err := d.Pool.Exec(ctx, `
		UPDATE clusters SET connected = $2, last_seen = now() WHERE id = $1`, id, connected)
	return err
}

func (d *DB) AppendLog(ctx context.Context, deploymentID, podName, line string, ts time.Time) error {
	_, err := d.Pool.Exec(ctx, `
		INSERT INTO deployment_logs (deployment_id, pod_name, line, ts)
		VALUES ($1, $2, $3, $4)`, deploymentID, podName, line, ts)
	return err
}

func (d *DB) GetLogs(ctx context.Context, deploymentID string, limit int) ([]models.LogLine, error) {
	rows, err := d.Pool.Query(ctx, `
		SELECT pod_name, line, ts FROM deployment_logs
		WHERE deployment_id = $1 ORDER BY id DESC LIMIT $2`, deploymentID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []models.LogLine{}
	for rows.Next() {
		var l models.LogLine
		if err := rows.Scan(&l.PodName, &l.Line, &l.TS); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	// Renvoyé en ordre chronologique pour l'affichage.
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out, rows.Err()
}

// ErrAppNotEmpty signale une application dont des environnements tournent
// encore sur un cluster.
var ErrAppNotEmpty = errors.New("application non vide")

// LiveDeployments retourne les déploiements encore présents sur un cluster.
//
// Un déploiement « deleted » a déjà été retiré par l'agent ; les autres
// correspondent à des ressources réelles qu'une suppression en base laisserait
// orphelines.
func (d *DB) LiveDeployments(ctx context.Context, appID string) ([]models.Deployment, error) {
	rows, err := d.Pool.Query(ctx, `
		SELECT DISTINCT ON (environment)
		       id, app_id, environment, image, replicas, host, status, message,
		       reason, url, revision, created_at, updated_at
		FROM deployments
		WHERE app_id = $1 AND status <> 'deleted'
		ORDER BY environment, revision DESC`, appID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []models.Deployment{}
	for rows.Next() {
		var dep models.Deployment
		if err := rows.Scan(&dep.ID, &dep.AppID, &dep.Environment, &dep.Image,
			&dep.Replicas, &dep.Host, &dep.Status, &dep.Message, &dep.Reason,
			&dep.URL, &dep.Revision, &dep.CreatedAt, &dep.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, dep)
	}
	return out, rows.Err()
}

// DeleteApp supprime une application et, en cascade, ses déploiements, sa
// configuration, ses variables et ses ports.
//
// Les ressources du cluster ne sont PAS retirées ici : c'est l'agent qui en a
// la charge. L'appelant doit avoir ordonné leur suppression au préalable, sans
// quoi les namespaces resteraient en place sans que Kybers les pilote encore.
func (d *DB) DeleteApp(ctx context.Context, orgID, appID string) error {
	tag, err := d.Pool.Exec(ctx,
		`DELETE FROM apps WHERE id = $1 AND org_id = $2`, appID, orgID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// DisconnectAllClusters remet tous les clusters à l'état déconnecté.
//
// Le drapeau `connected` reflète un stream gRPC vivant, qui meurt avec le
// process : au redémarrage, la valeur en base décrit des connexions qui
// n'existent plus. Sans cette remise à zéro, l'interface affiche « connecté »
// pour un agent injoignable, et les déploiements partent vers le vide.
func (d *DB) DisconnectAllClusters(ctx context.Context) (int64, error) {
	tag, err := d.Pool.Exec(ctx, `UPDATE clusters SET connected = false WHERE connected`)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}
