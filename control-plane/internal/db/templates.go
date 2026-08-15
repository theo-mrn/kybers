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
		SELECT f.id, f.org_id, f.name, f.description,
		       count(t.id), f.created_at, f.updated_at
		FROM template_folders f
		LEFT JOIN file_templates t ON t.folder_id = f.id
		WHERE f.org_id = $1
		GROUP BY f.id
		ORDER BY f.name`, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []models.TemplateFolder{}
	for rows.Next() {
		var f models.TemplateFolder
		if err := rows.Scan(&f.ID, &f.OrgID, &f.Name, &f.Description,
			&f.FileCount, &f.CreatedAt, &f.UpdatedAt); err != nil {
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
			INSERT INTO template_folders (org_id, name, description)
			VALUES ($1, $2, $3)
			RETURNING id, org_id, name, description, 0, created_at, updated_at`,
			orgID, name, f.Description,
		).Scan(&out.ID, &out.OrgID, &out.Name, &out.Description,
			&out.FileCount, &out.CreatedAt, &out.UpdatedAt)
	} else {
		err = d.Pool.QueryRow(ctx, `
			UPDATE template_folders
			SET name = $3, description = $4, updated_at = now()
			WHERE id = $1 AND org_id = $2
			RETURNING id, org_id, name, description,
			          (SELECT count(*) FROM file_templates WHERE folder_id = $1),
			          created_at, updated_at`,
			f.ID, orgID, name, f.Description,
		).Scan(&out.ID, &out.OrgID, &out.Name, &out.Description,
			&out.FileCount, &out.CreatedAt, &out.UpdatedAt)
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
	tag, err := d.Pool.Exec(ctx,
		`DELETE FROM template_folders WHERE id = $1 AND org_id = $2`, id, orgID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}
