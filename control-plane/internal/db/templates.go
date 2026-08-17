package db

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/kybers/kybers/control-plane/internal/models"
)

// Modèles de fichiers écrits dans les dépôts.
//
// Ils appartiennent à l'organisation : une entreprise impose ainsi ses
// conventions — pipeline standard, README maison, CODEOWNERS — sans que le
// dashboard ait à les connaître.

// ListTemplates retourne les modèles d'une organisation, filtrés par catégorie
// quand elle est précisée.
func (d *DB) ListTemplates(ctx context.Context, orgID, kind string) ([]models.FileTemplate, error) {
	rows, err := d.Pool.Query(ctx, `
		SELECT id, org_id, COALESCE(folder_id::text, ''), name, description, kind,
		       path, content, is_default, created_at, updated_at
		FROM file_templates
		WHERE org_id = $1 AND ($2 = '' OR kind = $2)
		ORDER BY kind, is_default DESC, name`, orgID, kind)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []models.FileTemplate{}
	for rows.Next() {
		var t models.FileTemplate
		if err := rows.Scan(&t.ID, &t.OrgID, &t.FolderID, &t.Name, &t.Description,
			&t.Kind, &t.Path, &t.Content, &t.IsDefault, &t.CreatedAt,
			&t.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// GetTemplate retourne un modèle de l'organisation.
func (d *DB) GetTemplate(ctx context.Context, orgID, id string) (*models.FileTemplate, error) {
	var t models.FileTemplate
	err := d.Pool.QueryRow(ctx, `
		SELECT id, org_id, COALESCE(folder_id::text, ''), name, description, kind,
		       path, content, is_default, created_at, updated_at
		FROM file_templates WHERE id = $1 AND org_id = $2`, id, orgID,
	).Scan(&t.ID, &t.OrgID, &t.FolderID, &t.Name, &t.Description, &t.Kind,
		&t.Path, &t.Content, &t.IsDefault, &t.CreatedAt, &t.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &t, nil
}

// SaveTemplate crée ou met à jour un modèle.
//
// L'écriture est transactionnelle : désigner un modèle par défaut doit retirer
// ce statut au précédent, sinon l'index unique refuserait l'enregistrement.
func (d *DB) SaveTemplate(ctx context.Context, orgID, userID string, t models.FileTemplate) (*models.FileTemplate, error) {
	name := strings.TrimSpace(t.Name)
	path := strings.TrimSpace(t.Path)
	if name == "" {
		return nil, fmt.Errorf("le nom du modèle est requis")
	}
	if path == "" {
		return nil, fmt.Errorf("le chemin de destination est requis")
	}
	switch t.Kind {
	case "pipeline", "readme", "fichier":
	default:
		t.Kind = "fichier"
	}

	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	if t.IsDefault {
		if _, err := tx.Exec(ctx, `
			UPDATE file_templates SET is_default = false
			WHERE org_id = $1 AND kind = $2 AND ($3 = '' OR id <> $3::uuid)`,
			orgID, t.Kind, t.ID); err != nil {
			return nil, err
		}
	}

	var out models.FileTemplate
	if t.ID == "" {
		err = tx.QueryRow(ctx, `
			INSERT INTO file_templates
				(org_id, folder_id, name, description, kind, path, content, is_default, updated_by)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
			RETURNING id, org_id, COALESCE(folder_id::text, ''), name, description,
			          kind, path, content, is_default, created_at, updated_at`,
			orgID, nullable(t.FolderID), name, t.Description, t.Kind, path,
			t.Content, t.IsDefault, nullable(userID),
		).Scan(&out.ID, &out.OrgID, &out.FolderID, &out.Name, &out.Description,
			&out.Kind, &out.Path, &out.Content, &out.IsDefault, &out.CreatedAt,
			&out.UpdatedAt)
	} else {
		err = tx.QueryRow(ctx, `
			UPDATE file_templates
			SET folder_id = $3, name = $4, description = $5, kind = $6, path = $7,
			    content = $8, is_default = $9, updated_by = $10, updated_at = now()
			WHERE id = $1 AND org_id = $2
			RETURNING id, org_id, COALESCE(folder_id::text, ''), name, description,
			          kind, path, content, is_default, created_at, updated_at`,
			t.ID, orgID, nullable(t.FolderID), name, t.Description, t.Kind, path,
			t.Content, t.IsDefault, nullable(userID),
		).Scan(&out.ID, &out.OrgID, &out.FolderID, &out.Name, &out.Description,
			&out.Kind, &out.Path, &out.Content, &out.IsDefault, &out.CreatedAt,
			&out.UpdatedAt)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		// L'index d'unicité porte sur le chemin : le dire, plutôt que de
		// laisser remonter un SQLSTATE que personne ne peut interpréter.
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return nil, fmt.Errorf(
				"un modèle écrit déjà dans %q à cet endroit ; changez le chemin ou le dossier", path)
		}
		return nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &out, nil
}

// DeleteTemplate retire un modèle de l'organisation.
func (d *DB) DeleteTemplate(ctx context.Context, orgID, id string) error {
	tag, err := d.Pool.Exec(ctx,
		`DELETE FROM file_templates WHERE id = $1 AND org_id = $2`, id, orgID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// zeroToNull distingue « non renseigné » de « zéro » : un port 0 ou un UID 0
// n'ont pas de sens, mais NULL laisse jouer les défauts de l'instance.
func zeroToNull(n int) any {
	if n == 0 {
		return nil
	}
	return n
}

// nullable évite d'écrire une chaîne vide dans une colonne UUID.
func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// ---------------------------------------------------------------------------
// Dossiers de modèles
// ---------------------------------------------------------------------------

// ListFolders retourne les dossiers d'une organisation, avec leur effectif.
func (d *DB) ListFolders(ctx context.Context, orgID string) ([]models.TemplateFolder, error) {
	rows, err := d.Pool.Query(ctx, `
		SELECT f.id, f.org_id, f.name, f.description, count(t.id),
		       f.is_golden_path, f.icon, f.runtime_image, f.versions, f.default_version,
		       COALESCE(f.default_port, 0),
			       f.cpu_request, f.memory_request, f.cpu_limit, f.memory_limit,
			       f.probe_path, COALESCE(f.probe_initial_delay, 0),
			       COALESCE(f.run_as_user, 0),
		       f.created_at, f.updated_at
		FROM template_folders f
		LEFT JOIN file_templates t ON t.folder_id = f.id
		WHERE f.org_id = $1
		GROUP BY f.id
		ORDER BY f.is_golden_path DESC, f.name`, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []models.TemplateFolder{}
	for rows.Next() {
		var f models.TemplateFolder
		if err := rows.Scan(&f.ID, &f.OrgID, &f.Name, &f.Description, &f.FileCount,
			&f.IsGoldenPath, &f.Icon, &f.RuntimeImage, &f.Versions, &f.DefaultVersion, &f.DefaultPort,
			&f.CPURequest, &f.MemoryRequest, &f.CPULimit, &f.MemoryLimit,
			&f.ProbePath, &f.ProbeInitialDelay, &f.RunAsUser,
			&f.CreatedAt, &f.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

// SaveFolder crée ou renomme un dossier.
func (d *DB) SaveFolder(ctx context.Context, orgID string, f models.TemplateFolder) (*models.TemplateFolder, error) {
	name := strings.TrimSpace(f.Name)
	if name == "" {
		return nil, fmt.Errorf("le nom du dossier est requis")
	}

	var out models.TemplateFolder
	var err error
	if f.ID == "" {
		err = d.Pool.QueryRow(ctx, `
			INSERT INTO template_folders
				(org_id, name, description, is_golden_path, icon, runtime_image,
				 versions, default_version, default_port,
				 cpu_request, memory_request, cpu_limit, memory_limit,
				 probe_path, probe_initial_delay, run_as_user)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
			RETURNING id, org_id, name, description, 0,
				          is_golden_path, icon, runtime_image, versions, default_version,
				          COALESCE(default_port, 0),
				          cpu_request, memory_request, cpu_limit, memory_limit,
				          probe_path, COALESCE(probe_initial_delay, 0),
				          COALESCE(run_as_user, 0), created_at, updated_at`,
			orgID, name, f.Description, f.IsGoldenPath, f.Icon, f.RuntimeImage,
			f.Versions, f.DefaultVersion, zeroToNull(f.DefaultPort), f.CPURequest, f.MemoryRequest,
			f.CPULimit, f.MemoryLimit, f.ProbePath,
			zeroToNull(f.ProbeInitialDelay), zeroToNull(f.RunAsUser),
		).Scan(&out.ID, &out.OrgID, &out.Name, &out.Description, &out.FileCount,
			&out.IsGoldenPath, &out.Icon, &out.RuntimeImage, &out.Versions, &out.DefaultVersion, &out.DefaultPort,
			&out.CPURequest, &out.MemoryRequest, &out.CPULimit, &out.MemoryLimit,
			&out.ProbePath, &out.ProbeInitialDelay, &out.RunAsUser,
			&out.CreatedAt, &out.UpdatedAt)
	} else {
		err = d.Pool.QueryRow(ctx, `
			UPDATE template_folders
			SET name = $3, description = $4, is_golden_path = $5, icon = $6,
			    runtime_image = $7, versions = $8, default_version = $9,
			    default_port = $10, cpu_request = $11, memory_request = $12,
			    cpu_limit = $13, memory_limit = $14, probe_path = $15,
			    probe_initial_delay = $16, run_as_user = $17, updated_at = now()
			WHERE id = $1 AND org_id = $2
			RETURNING id, org_id, name, description, (SELECT count(*) FROM file_templates WHERE folder_id = $1),
				          is_golden_path, icon, runtime_image, versions, default_version,
				          COALESCE(default_port, 0),
				          cpu_request, memory_request, cpu_limit, memory_limit,
				          probe_path, COALESCE(probe_initial_delay, 0),
				          COALESCE(run_as_user, 0), created_at, updated_at`,
			f.ID, orgID, name, f.Description, f.IsGoldenPath, f.Icon, f.RuntimeImage,
			f.Versions, f.DefaultVersion, zeroToNull(f.DefaultPort), f.CPURequest, f.MemoryRequest,
			f.CPULimit, f.MemoryLimit, f.ProbePath,
			zeroToNull(f.ProbeInitialDelay), zeroToNull(f.RunAsUser),
		).Scan(&out.ID, &out.OrgID, &out.Name, &out.Description, &out.FileCount,
			&out.IsGoldenPath, &out.Icon, &out.RuntimeImage, &out.Versions, &out.DefaultVersion, &out.DefaultPort,
			&out.CPURequest, &out.MemoryRequest, &out.CPULimit, &out.MemoryLimit,
			&out.ProbePath, &out.ProbeInitialDelay, &out.RunAsUser,
			&out.CreatedAt, &out.UpdatedAt)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return nil, fmt.Errorf("un dossier nommé %q existe déjà", name)
		}
		return nil, err
	}
	return &out, nil
}

// DeleteFolder supprime un dossier ; ses modèles retournent à la racine.
//
// Les effacer aussi ferait perdre du travail sur un geste d'organisation : la
// contrainte ON DELETE SET NULL s'en charge.
func (d *DB) DeleteFolder(ctx context.Context, orgID, id string) error {
	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	// Les modèles remontent à la racine par ON DELETE SET NULL, où leur chemin
	// peut déjà être pris — un dossier supprimé plus tôt y a laissé le sien.
	// Préfixer conserve le travail, là où une cascade le détruirait.
	//
	// Le préfixe lui-même peut heurter : on suffixe alors jusqu'à trouver un
	// chemin libre, plutôt que de laisser la contrainte refuser la suppression.
	rows, err := tx.Query(ctx, `
		SELECT t.id, t.path, f.name
		FROM file_templates t
		JOIN template_folders f ON f.id = t.folder_id
		WHERE t.folder_id = $1 AND t.org_id = $2`, id, orgID)
	if err != nil {
		return err
	}

	type move struct{ id, path, folder string }
	moves := []move{}
	for rows.Next() {
		var m move
		if err := rows.Scan(&m.id, &m.path, &m.folder); err != nil {
			rows.Close()
			return err
		}
		moves = append(moves, m)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	for _, m := range moves {
		var taken bool
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS(
				SELECT 1 FROM file_templates
				WHERE org_id = $1 AND folder_id IS NULL AND path = $2)`,
			orgID, m.path).Scan(&taken); err != nil {
			return err
		}
		if !taken {
			continue
		}

		candidate := m.folder + "/" + m.path
		for i := 2; ; i++ {
			if err := tx.QueryRow(ctx, `
				SELECT EXISTS(
					SELECT 1 FROM file_templates
					WHERE org_id = $1 AND folder_id IS NULL AND path = $2)`,
				orgID, candidate).Scan(&taken); err != nil {
				return err
			}
			if !taken || i > 50 {
				break
			}
			candidate = fmt.Sprintf("%s-%d/%s", m.folder, i, m.path)
		}

		if _, err := tx.Exec(ctx,
			`UPDATE file_templates SET path = $3 WHERE id = $1 AND org_id = $2`,
			m.id, orgID, candidate); err != nil {
			return err
		}
	}

	tag, err := tx.Exec(ctx,
		`DELETE FROM template_folders WHERE id = $1 AND org_id = $2`, id, orgID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}
