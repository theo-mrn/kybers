package db

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/kybers/kybers/control-plane/internal/models"
)

// ---------------------------------------------------------------------------
// Registries privés
// ---------------------------------------------------------------------------

func (d *DB) CreateRegistry(ctx context.Context, orgID, name, server, username, password, email string) (*models.Registry, error) {
	enc, err := d.Cipher.Encrypt(password)
	if err != nil {
		return nil, fmt.Errorf("chiffrement du mot de passe: %w", err)
	}

	var r models.Registry
	err = d.Pool.QueryRow(ctx, `
		INSERT INTO registries (org_id, name, server, username, password_encrypted, email)
		VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (org_id, name) DO UPDATE SET
			server = EXCLUDED.server,
			username = EXCLUDED.username,
			password_encrypted = EXCLUDED.password_encrypted,
			email = EXCLUDED.email
		RETURNING id, name, server, username, email, created_at`,
		orgID, name, server, username, enc, email,
	).Scan(&r.ID, &r.Name, &r.Server, &r.Username, &r.Email, &r.CreatedAt)
	if err != nil {
		return nil, err
	}
	return &r, nil
}

func (d *DB) ListRegistries(ctx context.Context, orgID string) ([]models.Registry, error) {
	rows, err := d.Pool.Query(ctx, `
		SELECT id, name, server, username, email, created_at
		FROM registries WHERE org_id = $1 ORDER BY created_at DESC`, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []models.Registry{}
	for rows.Next() {
		var r models.Registry
		if err := rows.Scan(&r.ID, &r.Name, &r.Server, &r.Username, &r.Email, &r.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// GetRegistryWithPassword déchiffre le mot de passe. Réservé au dispatcher :
// la valeur part vers l'agent et ne doit jamais transiter par l'API REST.
func (d *DB) GetRegistryWithPassword(ctx context.Context, id string) (*models.Registry, error) {
	var r models.Registry
	var enc []byte
	err := d.Pool.QueryRow(ctx, `
		SELECT id, name, server, username, password_encrypted, email, created_at
		FROM registries WHERE id = $1`, id,
	).Scan(&r.ID, &r.Name, &r.Server, &r.Username, &enc, &r.Email, &r.CreatedAt)
	if err != nil {
		return nil, err
	}
	if r.Password, err = d.Cipher.Decrypt(enc); err != nil {
		return nil, err
	}
	return &r, nil
}

func (d *DB) DeleteRegistry(ctx context.Context, orgID, id string) error {
	tag, err := d.Pool.Exec(ctx,
		`DELETE FROM registries WHERE id = $1 AND org_id = $2`, id, orgID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// ---------------------------------------------------------------------------
// Variables sensibles
// ---------------------------------------------------------------------------

func (d *DB) SetSecretVars(ctx context.Context, appID, environment string, vars []models.EnvVar) error {
	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op après Commit

	for _, v := range vars {
		enc, err := d.Cipher.Encrypt(v.Value)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO secret_vars (app_id, environment, key, value_encrypted)
			VALUES ($1, $2, $3, $4)
			ON CONFLICT (app_id, environment, key)
			DO UPDATE SET value_encrypted = EXCLUDED.value_encrypted`,
			appID, environment, v.Key, enc); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// ListSecretKeys ne retourne que les noms : l'API n'expose jamais les valeurs.
func (d *DB) ListSecretKeys(ctx context.Context, appID, environment string) ([]string, error) {
	rows, err := d.Pool.Query(ctx, `
		SELECT key FROM secret_vars
		WHERE app_id = $1 AND environment = $2 ORDER BY key`, appID, environment)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []string{}
	for rows.Next() {
		var k string
		if err := rows.Scan(&k); err != nil {
			return nil, err
		}
		out = append(out, k)
	}
	return out, rows.Err()
}

// GetSecretVars déchiffre les valeurs. Réservé au dispatcher.
func (d *DB) GetSecretVars(ctx context.Context, appID, environment string) (map[string]string, error) {
	rows, err := d.Pool.Query(ctx, `
		SELECT key, value_encrypted FROM secret_vars
		WHERE app_id = $1 AND environment = $2`, appID, environment)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := map[string]string{}
	for rows.Next() {
		var k string
		var enc []byte
		if err := rows.Scan(&k, &enc); err != nil {
			return nil, err
		}
		v, err := d.Cipher.Decrypt(enc)
		if err != nil {
			return nil, fmt.Errorf("secret %q: %w", k, err)
		}
		out[k] = v
	}
	return out, rows.Err()
}

func (d *DB) DeleteSecretVar(ctx context.Context, appID, environment, key string) error {
	_, err := d.Pool.Exec(ctx, `
		DELETE FROM secret_vars WHERE app_id = $1 AND environment = $2 AND key = $3`,
		appID, environment, key)
	return err
}

func (d *DB) DeleteEnvVar(ctx context.Context, appID, environment, key string) error {
	_, err := d.Pool.Exec(ctx, `
		DELETE FROM env_vars WHERE app_id = $1 AND environment = $2 AND key = $3`,
		appID, environment, key)
	return err
}

// ---------------------------------------------------------------------------
// Configuration d'exécution
// ---------------------------------------------------------------------------

func (d *DB) UpsertAppConfig(ctx context.Context, c models.AppConfig) error {
	liveness, err := marshalProbe(c.LivenessProbe)
	if err != nil {
		return err
	}
	readiness, err := marshalProbe(c.ReadinessProbe)
	if err != nil {
		return err
	}
	startup, err := marshalProbe(c.StartupProbe)
	if err != nil {
		return err
	}

	_, err = d.Pool.Exec(ctx, `
		INSERT INTO app_configs (
			app_id, environment, registry_id,
			cpu_request, memory_request, cpu_limit, memory_limit,
			autoscaling_enabled, autoscaling_min, autoscaling_max, autoscaling_cpu_percent,
			liveness_probe, readiness_probe, startup_probe,
			network_policy, quota_cpu, quota_memory, quota_pods,
			run_as_non_root, run_as_user, read_only_root_fs, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21, now())
		ON CONFLICT (app_id, environment) DO UPDATE SET
			registry_id = EXCLUDED.registry_id,
			cpu_request = EXCLUDED.cpu_request,
			memory_request = EXCLUDED.memory_request,
			cpu_limit = EXCLUDED.cpu_limit,
			memory_limit = EXCLUDED.memory_limit,
			autoscaling_enabled = EXCLUDED.autoscaling_enabled,
			autoscaling_min = EXCLUDED.autoscaling_min,
			autoscaling_max = EXCLUDED.autoscaling_max,
			autoscaling_cpu_percent = EXCLUDED.autoscaling_cpu_percent,
			liveness_probe = EXCLUDED.liveness_probe,
			readiness_probe = EXCLUDED.readiness_probe,
			startup_probe = EXCLUDED.startup_probe,
			network_policy = EXCLUDED.network_policy,
			quota_cpu = EXCLUDED.quota_cpu,
			quota_memory = EXCLUDED.quota_memory,
			quota_pods = EXCLUDED.quota_pods,
			run_as_non_root = EXCLUDED.run_as_non_root,
			run_as_user = EXCLUDED.run_as_user,
			read_only_root_fs = EXCLUDED.read_only_root_fs,
			updated_at = now()`,
		c.AppID, c.Environment, c.RegistryID,
		c.CPURequest, c.MemoryRequest, c.CPULimit, c.MemoryLimit,
		c.AutoscalingEnabled, c.AutoscalingMin, c.AutoscalingMax, c.AutoscalingCPU,
		liveness, readiness, startup,
		c.NetworkPolicy, c.QuotaCPU, c.QuotaMemory, c.QuotaPods,
		c.RunAsNonRoot, c.RunAsUser, c.ReadOnlyRootFS)
	return err
}

// GetAppConfig retourne la configuration enregistrée, ou les valeurs par
// défaut si aucune n'existe encore pour ce couple (application, environnement).
func (d *DB) GetAppConfig(ctx context.Context, appID, environment string) (*models.AppConfig, error) {
	c := models.DefaultAppConfig(appID, environment)
	var liveness, readiness, startup []byte
	var registryName *string

	err := d.Pool.QueryRow(ctx, `
		SELECT ac.registry_id, r.name,
		       ac.cpu_request, ac.memory_request, ac.cpu_limit, ac.memory_limit,
		       ac.autoscaling_enabled, ac.autoscaling_min, ac.autoscaling_max, ac.autoscaling_cpu_percent,
		       ac.liveness_probe, ac.readiness_probe, ac.startup_probe,
		       ac.network_policy, ac.quota_cpu, ac.quota_memory, ac.quota_pods,
		       ac.run_as_non_root, ac.run_as_user, ac.read_only_root_fs, ac.updated_at
		FROM app_configs ac
		LEFT JOIN registries r ON r.id = ac.registry_id
		WHERE ac.app_id = $1 AND ac.environment = $2`, appID, environment,
	).Scan(&c.RegistryID, &registryName,
		&c.CPURequest, &c.MemoryRequest, &c.CPULimit, &c.MemoryLimit,
		&c.AutoscalingEnabled, &c.AutoscalingMin, &c.AutoscalingMax, &c.AutoscalingCPU,
		&liveness, &readiness, &startup,
		&c.NetworkPolicy, &c.QuotaCPU, &c.QuotaMemory, &c.QuotaPods,
		&c.RunAsNonRoot, &c.RunAsUser, &c.ReadOnlyRootFS, &c.UpdatedAt)

	if errors.Is(err, pgx.ErrNoRows) {
		return &c, nil // valeurs par défaut
	}
	if err != nil {
		return nil, err
	}

	if registryName != nil {
		c.RegistryName = *registryName
	}
	if c.LivenessProbe, err = unmarshalProbe(liveness); err != nil {
		return nil, err
	}
	if c.ReadinessProbe, err = unmarshalProbe(readiness); err != nil {
		return nil, err
	}
	if c.StartupProbe, err = unmarshalProbe(startup); err != nil {
		return nil, err
	}
	return &c, nil
}

func marshalProbe(p *models.Probe) ([]byte, error) {
	if !p.Enabled() {
		return nil, nil
	}
	return json.Marshal(p)
}

func unmarshalProbe(data []byte) (*models.Probe, error) {
	if len(data) == 0 {
		return nil, nil
	}
	var p models.Probe
	if err := json.Unmarshal(data, &p); err != nil {
		return nil, err
	}
	return &p, nil
}

// ---------------------------------------------------------------------------
// Révisions et rollback
// ---------------------------------------------------------------------------

// CreateDeploymentRevision enregistre un déploiement avec le numéro de révision
// suivant pour ce couple (application, environnement), et fige la configuration
// appliquée pour rendre un futur rollback fidèle.
func (d *DB) CreateDeploymentRevision(
	ctx context.Context,
	appID, env, image, host string,
	replicas int,
	snapshot any,
	rolledBackFrom *string,
	prov models.Provenance,
) (*models.Deployment, error) {
	raw, err := json.Marshal(snapshot)
	if err != nil {
		return nil, err
	}

	var dep models.Deployment
	// COALESCE(MAX+1, 1) dans la même instruction : deux déploiements
	// concurrents ne peuvent pas obtenir le même numéro de révision, l'index
	// unique (app_id, environment, revision) faisant foi.
	err = d.Pool.QueryRow(ctx, `
		INSERT INTO deployments
			(app_id, environment, image, replicas, host, status, revision, config_snapshot, rolled_back_from,
			 git_commit, git_ref, git_message, source)
		VALUES ($1, $2, $3, $4, $5, 'pending',
			(SELECT COALESCE(MAX(revision), 0) + 1 FROM deployments WHERE app_id = $1 AND environment = $2),
			$6, $7, $8, $9, $10, $11)
		RETURNING id, app_id, environment, image, replicas, host, status, message,
		          reason, url, revision, rolled_back_from,
		          git_commit, git_ref, git_message, source, created_at, updated_at`,
		appID, env, image, replicas, host, raw, rolledBackFrom,
		prov.GitCommit, prov.GitRef, prov.GitMessage, prov.Source,
	).Scan(&dep.ID, &dep.AppID, &dep.Environment, &dep.Image, &dep.Replicas, &dep.Host,
		&dep.Status, &dep.Message, &dep.Reason, &dep.URL, &dep.Revision,
		&dep.RolledBack,
		&dep.GitCommit, &dep.GitRef, &dep.GitMessage, &dep.Source,
		&dep.CreatedAt, &dep.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return &dep, nil
}

// ListDeploymentsByApp retourne l'historique des révisions d'un environnement.
func (d *DB) ListDeploymentsByApp(ctx context.Context, appID, environment string) ([]models.Deployment, error) {
	rows, err := d.Pool.Query(ctx, `
		SELECT d.id, d.app_id, a.name, d.environment, d.image, d.replicas, d.host,
		       d.status, d.message, d.reason, d.url, d.revision, d.rolled_back_from,
		       d.git_commit, d.git_ref, d.git_message, d.source,
		       d.created_at, d.updated_at
		FROM deployments d JOIN apps a ON a.id = d.app_id
		WHERE d.app_id = $1 AND ($2 = '' OR d.environment = $2)
		ORDER BY d.revision DESC LIMIT 50`, appID, environment)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanDeployments(rows)
}

// GetDeploymentSnapshot retourne la configuration figée d'une révision, utilisée
// pour reproduire à l'identique lors d'un rollback.
func (d *DB) GetDeploymentSnapshot(ctx context.Context, id string) (json.RawMessage, error) {
	var raw json.RawMessage
	err := d.Pool.QueryRow(ctx,
		`SELECT COALESCE(config_snapshot, '{}'::jsonb) FROM deployments WHERE id = $1`, id).Scan(&raw)
	return raw, err
}

func scanDeployments(rows pgx.Rows) ([]models.Deployment, error) {
	out := []models.Deployment{}
	for rows.Next() {
		var dep models.Deployment
		if err := rows.Scan(&dep.ID, &dep.AppID, &dep.AppName, &dep.Environment, &dep.Image,
			&dep.Replicas, &dep.Host, &dep.Status, &dep.Message, &dep.Reason, &dep.URL,
			&dep.Revision, &dep.RolledBack,
			&dep.GitCommit, &dep.GitRef, &dep.GitMessage, &dep.Source,
			&dep.CreatedAt, &dep.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, dep)
	}
	return out, rows.Err()
}

// UpdateDeploymentReason enregistre la cause technique d'un échec.
func (d *DB) UpdateDeploymentReason(ctx context.Context, id, reason string) error {
	_, err := d.Pool.Exec(ctx,
		`UPDATE deployments SET reason = $2, updated_at = now() WHERE id = $1`, id, reason)
	return err
}

// SetDeploymentReplicas reflète en base un scale demandé par l'utilisateur.
func (d *DB) SetDeploymentReplicas(ctx context.Context, id string, replicas int) error {
	status := models.StatusRunning
	if replicas == 0 {
		status = models.StatusStopped
	}
	_, err := d.Pool.Exec(ctx, `
		UPDATE deployments SET replicas = $2, status = $3, updated_at = now()
		WHERE id = $1`, id, replicas, status)
	return err
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

func (d *DB) AppendEvent(ctx context.Context, deploymentID, podName, typ, reason, message string, ts time.Time) error {
	_, err := d.Pool.Exec(ctx, `
		INSERT INTO deployment_events (deployment_id, pod_name, type, reason, message, ts)
		VALUES ($1, $2, $3, $4, $5, $6)`, deploymentID, podName, typ, reason, message, ts)
	return err
}

func (d *DB) GetEvents(ctx context.Context, deploymentID string, limit int) ([]models.Event, error) {
	rows, err := d.Pool.Query(ctx, `
		SELECT pod_name, type, reason, message, ts FROM deployment_events
		WHERE deployment_id = $1 ORDER BY id DESC LIMIT $2`, deploymentID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []models.Event{}
	for rows.Next() {
		var e models.Event
		if err := rows.Scan(&e.PodName, &e.Type, &e.Reason, &e.Message, &e.TS); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	// Ordre chronologique pour l'affichage.
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out, rows.Err()
}

// ---------------------------------------------------------------------------
// Commandes de cycle de vie
// ---------------------------------------------------------------------------

func (d *DB) CreateCommand(ctx context.Context, deploymentID, kind string, payload any) (*models.Command, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	var c models.Command
	err = d.Pool.QueryRow(ctx, `
		INSERT INTO deployment_commands (deployment_id, kind, payload)
		VALUES ($1, $2, $3)
		RETURNING id, deployment_id, kind, payload, status, message, created_at`,
		deploymentID, kind, raw,
	).Scan(&c.ID, &c.DeploymentID, &c.Kind, &c.Payload, &c.Status, &c.Message, &c.CreatedAt)
	if err != nil {
		return nil, err
	}
	return &c, nil
}

// ClaimPendingCommands réserve les commandes en attente, comme pour les
// déploiements : SKIP LOCKED évite qu'une même commande parte deux fois.
func (d *DB) ClaimPendingCommands(ctx context.Context, limit int) ([]models.Command, error) {
	rows, err := d.Pool.Query(ctx, `
		UPDATE deployment_commands SET status = 'sent', updated_at = now()
		WHERE id IN (
			SELECT id FROM deployment_commands WHERE status = 'pending'
			ORDER BY created_at LIMIT $1
			FOR UPDATE SKIP LOCKED
		)
		RETURNING id, deployment_id, kind, payload, status, message, created_at`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []models.Command{}
	for rows.Next() {
		var c models.Command
		if err := rows.Scan(&c.ID, &c.DeploymentID, &c.Kind, &c.Payload,
			&c.Status, &c.Message, &c.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (d *DB) UpdateCommandStatus(ctx context.Context, id, status, message string) error {
	_, err := d.Pool.Exec(ctx, `
		UPDATE deployment_commands SET status = $2, message = $3, updated_at = now()
		WHERE id = $1`, id, status, message)
	return err
}

func (d *DB) ResetCommandToPending(ctx context.Context, id, reason string) error {
	_, err := d.Pool.Exec(ctx, `
		UPDATE deployment_commands SET status = 'pending', message = $2, updated_at = now()
		WHERE id = $1`, id, reason)
	return err
}

// ---------------------------------------------------------------------------
// Clusters
// ---------------------------------------------------------------------------

// CreateCluster enregistre un cluster et son jeton d'authentification.
//
// Un cluster appartient à la plateforme, pas à une organisation : plusieurs
// organisations y déploient couramment, chacune dans ses propres namespaces.
// Le jeton n'est retourné qu'ici : il est ensuite fourni à l'agent lors de son
// installation, et ne peut plus être relu.
func (d *DB) CreateCluster(ctx context.Context, name, token string) (*models.Cluster, error) {
	var c models.Cluster
	err := d.Pool.QueryRow(ctx, `
		INSERT INTO clusters (name, token)
		VALUES ($1, $2)
		RETURNING id, name, connected, last_seen`,
		name, token,
	).Scan(&c.ID, &c.Name, &c.Connected, &c.LastSeen)
	if err != nil {
		return nil, err
	}
	return &c, nil
}

// ListClusters retourne les clusters visibles par une organisation.
//
// Un cluster sans restriction est visible par toutes : c'est le cas courant,
// plusieurs organisations partageant la même infrastructure. Dès qu'une
// restriction existe (au moins une ligne dans cluster_orgs), seules les
// organisations listées le voient.
//
// orgID vide = vue plateforme, sans filtre : réservé à l'administration.
func (d *DB) ListClusters(ctx context.Context, orgID string) ([]models.Cluster, error) {
	rows, err := d.Pool.Query(ctx, `
		SELECT c.id, c.name, c.connected, c.last_seen
		FROM clusters c
		WHERE $1 = ''
		   OR NOT EXISTS (SELECT 1 FROM cluster_orgs r WHERE r.cluster_id = c.id)
		   OR EXISTS (
		        SELECT 1 FROM cluster_orgs r
		        WHERE r.cluster_id = c.id AND r.org_id = $1::uuid)
		ORDER BY c.created_at`, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []models.Cluster{}
	for rows.Next() {
		var c models.Cluster
		if err := rows.Scan(&c.ID, &c.Name, &c.Connected, &c.LastSeen); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (d *DB) DeleteCluster(ctx context.Context, id string) error {
	tag, err := d.Pool.Exec(ctx,
		`DELETE FROM clusters WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// ListClusterOrgs retourne les organisations auxquelles un cluster est
// restreint. Une liste vide signifie « aucune restriction » : toutes y ont
// accès.
func (d *DB) ListClusterOrgs(ctx context.Context, clusterID string) ([]models.Organization, error) {
	rows, err := d.Pool.Query(ctx, `
		SELECT o.id, o.slug, o.name, o.created_at
		FROM cluster_orgs r JOIN organizations o ON o.id = r.org_id
		WHERE r.cluster_id = $1
		ORDER BY o.name`, clusterID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []models.Organization{}
	for rows.Next() {
		var o models.Organization
		if err := rows.Scan(&o.ID, &o.Slug, &o.Name, &o.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

// RestrictClusterToOrg réserve un cluster à une organisation de plus.
//
// La première restriction change le sens du cluster : de « visible par toutes »
// il devient « visible par celles-ci seulement ». Les organisations qui y
// déployaient déjà le perdent donc de vue — d'où la mise en garde côté API.
func (d *DB) RestrictClusterToOrg(ctx context.Context, clusterID, orgID string) error {
	_, err := d.Pool.Exec(ctx, `
		INSERT INTO cluster_orgs (cluster_id, org_id) VALUES ($1, $2)
		ON CONFLICT DO NOTHING`, clusterID, orgID)
	return err
}

// UnrestrictClusterFromOrg retire une organisation de la liste. Retirer la
// dernière rend le cluster à nouveau visible par toutes.
func (d *DB) UnrestrictClusterFromOrg(ctx context.Context, clusterID, orgID string) error {
	tag, err := d.Pool.Exec(ctx,
		`DELETE FROM cluster_orgs WHERE cluster_id = $1 AND org_id = $2`,
		clusterID, orgID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// SaveClusterInfo enregistre l'état du cluster remonté par l'agent.
func (d *DB) SaveClusterInfo(ctx context.Context, clusterID string, info any) error {
	raw, err := json.Marshal(info)
	if err != nil {
		return err
	}
	_, err = d.Pool.Exec(ctx, `
		UPDATE clusters SET info = $2, info_updated_at = now() WHERE id = $1`,
		clusterID, raw)
	return err
}

// SetClusterAgentVersion trace la version de l'agent connecté.
func (d *DB) SetClusterAgentVersion(ctx context.Context, clusterID, version string) error {
	_, err := d.Pool.Exec(ctx,
		`UPDATE clusters SET agent_version = $2 WHERE id = $1`, clusterID, version)
	return err
}

// GetClusterInfo retourne l'état brut ; vide si l'agent n'a rien remonté.
func (d *DB) GetClusterInfo(ctx context.Context, clusterID string) (json.RawMessage, *time.Time, string, error) {
	var raw json.RawMessage
	var updated *time.Time
	var version string
	err := d.Pool.QueryRow(ctx, `
		SELECT COALESCE(info, 'null'::jsonb), info_updated_at, agent_version
		FROM clusters WHERE id = $1`, clusterID).Scan(&raw, &updated, &version)
	return raw, updated, version, err
}

// ---------------------------------------------------------------------------
// Consommation (séries temporelles)
// ---------------------------------------------------------------------------

// UsageSample est un relevé de consommation à un instant donné.
type UsageSample struct {
	TS             time.Time       `json:"ts"`
	CPUMillis      int64           `json:"cpu_millis"`
	CPUCapacity    int64           `json:"cpu_capacity"`
	MemoryBytes    int64           `json:"memory_bytes"`
	MemoryCapacity int64           `json:"memory_capacity"`
	Nodes          json.RawMessage `json:"nodes,omitempty"`
	Apps           json.RawMessage `json:"apps,omitempty"`
}

func (d *DB) InsertUsageSample(ctx context.Context, clusterID string, ts time.Time,
	cpuMillis, cpuCapacity, memBytes, memCapacity int64, nodes, apps any) error {
	rawNodes, err := json.Marshal(nodes)
	if err != nil {
		return err
	}
	rawApps, err := json.Marshal(apps)
	if err != nil {
		return err
	}
	_, err = d.Pool.Exec(ctx, `
		INSERT INTO usage_samples
			(cluster_id, ts, cpu_millis, cpu_capacity, memory_bytes, memory_capacity, nodes, apps)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		clusterID, ts, cpuMillis, cpuCapacity, memBytes, memCapacity, rawNodes, rawApps)
	return err
}

// GetUsageHistory retourne les relevés des dernières heures, du plus ancien au
// plus récent — l'ordre attendu pour tracer une courbe.
func (d *DB) GetUsageHistory(ctx context.Context, clusterID string, hours int) ([]UsageSample, error) {
	rows, err := d.Pool.Query(ctx, `
		SELECT ts, cpu_millis, cpu_capacity, memory_bytes, memory_capacity
		FROM usage_samples
		WHERE cluster_id = $1 AND ts > now() - make_interval(hours => $2)
		ORDER BY ts`, clusterID, hours)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []UsageSample{}
	for rows.Next() {
		var s UsageSample
		if err := rows.Scan(&s.TS, &s.CPUMillis, &s.CPUCapacity,
			&s.MemoryBytes, &s.MemoryCapacity); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// GetLatestUsage retourne le dernier relevé, détail par nœud et application
// compris. Nil si aucun relevé n'existe.
func (d *DB) GetLatestUsage(ctx context.Context, clusterID string) (*UsageSample, error) {
	var s UsageSample
	err := d.Pool.QueryRow(ctx, `
		SELECT ts, cpu_millis, cpu_capacity, memory_bytes, memory_capacity,
		       COALESCE(nodes, 'null'::jsonb), COALESCE(apps, 'null'::jsonb)
		FROM usage_samples
		WHERE cluster_id = $1 ORDER BY ts DESC LIMIT 1`, clusterID,
	).Scan(&s.TS, &s.CPUMillis, &s.CPUCapacity, &s.MemoryBytes, &s.MemoryCapacity,
		&s.Nodes, &s.Apps)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &s, nil
}

// PurgeOldUsage supprime les relevés au-delà de la rétention.
func (d *DB) PurgeOldUsage(ctx context.Context, hours int) (int64, error) {
	tag, err := d.Pool.Exec(ctx,
		`DELETE FROM usage_samples WHERE ts < now() - make_interval(hours => $1)`, hours)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// SetClusterMetricsSource enregistre la source de métriques choisie.
// Chaîne vide = sélection automatique par l'agent.
func (d *DB) SetClusterMetricsSource(ctx context.Context, clusterID, source string) error {
	_, err := d.Pool.Exec(ctx,
		`UPDATE clusters SET metrics_source = $2 WHERE id = $1`, clusterID, source)
	return err
}

// GetClusterMetricsSource retourne le choix persisté, à réappliquer quand
// l'agent se reconnecte.
func (d *DB) GetClusterMetricsSource(ctx context.Context, clusterID string) (string, error) {
	var source string
	err := d.Pool.QueryRow(ctx,
		`SELECT metrics_source FROM clusters WHERE id = $1`, clusterID).Scan(&source)
	return source, err
}

// ---------------------------------------------------------------------------
// Rétention
// ---------------------------------------------------------------------------

// PurgeCounts détaille ce qu'une purge a supprimé, pour le journaliser.
type PurgeCounts struct {
	Logs        int64
	Events      int64
	Usage       int64
	Commands    int64
	Deployments int64
}

// PurgeOldData applique la rétention à toutes les tables qui croissent avec
// l'usage. Sans elle, logs et events s'accumulent indéfiniment.
//
// Les déploiements ne sont supprimés qu'au-delà de keepRevisions par
// environnement : l'historique et le rollback en dépendent.
func (d *DB) PurgeOldData(ctx context.Context, logsHours, usageHours, commandDays, keepRevisions int) (PurgeCounts, error) {
	var c PurgeCounts

	tag, err := d.Pool.Exec(ctx,
		`DELETE FROM deployment_logs WHERE ts < now() - make_interval(hours => $1)`, logsHours)
	if err != nil {
		return c, fmt.Errorf("purge des logs: %w", err)
	}
	c.Logs = tag.RowsAffected()

	tag, err = d.Pool.Exec(ctx,
		`DELETE FROM deployment_events WHERE ts < now() - make_interval(hours => $1)`, logsHours)
	if err != nil {
		return c, fmt.Errorf("purge des events: %w", err)
	}
	c.Events = tag.RowsAffected()

	tag, err = d.Pool.Exec(ctx,
		`DELETE FROM usage_samples WHERE ts < now() - make_interval(hours => $1)`, usageHours)
	if err != nil {
		return c, fmt.Errorf("purge des relevés: %w", err)
	}
	c.Usage = tag.RowsAffected()

	// Les commandes terminées n'ont plus d'intérêt ; celles en attente sont
	// conservées quel que soit leur âge.
	tag, err = d.Pool.Exec(ctx, `
		DELETE FROM deployment_commands
		WHERE status IN ('done', 'failed')
		  AND updated_at < now() - make_interval(days => $1)`, commandDays)
	if err != nil {
		return c, fmt.Errorf("purge des commandes: %w", err)
	}
	c.Commands = tag.RowsAffected()

	// Anciennes révisions : on garde les N plus récentes par environnement,
	// et jamais la révision courante d'un déploiement actif.
	tag, err = d.Pool.Exec(ctx, `
		DELETE FROM deployments WHERE id IN (
			SELECT id FROM (
				SELECT id, status,
				       row_number() OVER (
				           PARTITION BY app_id, environment ORDER BY revision DESC
				       ) AS rang
				FROM deployments
			) ranked
			WHERE rang > $1
			  AND status NOT IN ('running', 'provisioning', 'pending', 'dispatched')
		)`, keepRevisions)
	if err != nil {
		return c, fmt.Errorf("purge des révisions: %w", err)
	}
	c.Deployments = tag.RowsAffected()

	return c, nil
}
