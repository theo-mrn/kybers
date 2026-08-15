package db

import (
	"context"
	"encoding/base64"
	"errors"

	"github.com/jackc/pgx/v5"
)

// Réglages de l'instance modifiables depuis l'interface.
//
// La variable d'environnement reste prioritaire : une instance pilotée par sa
// configuration ne doit pas voir son comportement changé depuis le dashboard.

// Clés connues. Les déclarer évite qu'une faute de frappe crée un réglage
// fantôme qu'aucun lecteur n'ira chercher.
const (
	SettingGitToken  = "git.token"
	SettingGitAPIURL = "git.api_url"
)

// GetSetting lit un réglage, en le déchiffrant s'il est marqué secret.
//
// Une clé absente retourne une chaîne vide sans erreur : un réglage non défini
// est un cas normal, pas un échec.
func (d *DB) GetSetting(ctx context.Context, key string) (string, error) {
	var value string
	var secret bool

	err := d.Pool.QueryRow(ctx,
		`SELECT value, secret FROM instance_settings WHERE key = $1`, key,
	).Scan(&value, &secret)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if !secret || value == "" {
		return value, nil
	}

	raw, err := base64.StdEncoding.DecodeString(value)
	if err != nil {
		return "", err
	}
	return d.Cipher.Decrypt(raw)
}

// SetSetting enregistre un réglage. Une valeur vide efface la clé.
func (d *DB) SetSetting(ctx context.Context, key, value string, secret bool, userID string) error {
	if value == "" {
		_, err := d.Pool.Exec(ctx, `DELETE FROM instance_settings WHERE key = $1`, key)
		return err
	}

	stored := value
	if secret {
		enc, err := d.Cipher.Encrypt(value)
		if err != nil {
			return err
		}
		// Base64 : la colonne est du texte, le chiffré est binaire.
		stored = base64.StdEncoding.EncodeToString(enc)
	}

	var by any
	if userID != "" {
		by = userID
	}

	_, err := d.Pool.Exec(ctx, `
		INSERT INTO instance_settings (key, value, secret, updated_by, updated_at)
		VALUES ($1, $2, $3, $4, now())
		ON CONFLICT (key) DO UPDATE
		SET value = $2, secret = $3, updated_by = $4, updated_at = now()`,
		key, stored, secret, by)
	return err
}
