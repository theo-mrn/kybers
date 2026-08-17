package db

import (
	"context"

	"github.com/kybers/kybers/control-plane/internal/models"
)

// Modèles fournis avec Kybers.
//
// Ils sont insérés dans l'organisation à sa première consultation, plutôt que
// gardés dans le code du dashboard : l'équipe les voit, les modifie et les
// supprime comme les siens. Une seule bibliothèque, pas deux sources.
//
// Les substitutions {{app}}, {{repo}}, {{env}} et {{endpoint}} sont remplacées
// au moment de l'écriture.
var builtinTemplates = []models.FileTemplate{
	{
		Name:        "Pipeline GitHub Actions",
		Description: "Build, publication sur GHCR, puis déploiement sur Kybers.",
		Kind:        "pipeline",
		Path:        ".github/workflows/kybers-deploy.yml",
		IsDefault:   true,
		Content: `name: Déployer sur Kybers

on:
  push:
    branches: [main]

env:
  IMAGE: ghcr.io/${{ github.repository }}

jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write

    steps:
      - uses: actions/checkout@v4

      # Construction et publication de l'image : cette partie vous appartient,
      # Kybers ne fait que déployer ce que vous avez publié.
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - uses: docker/build-push-action@v6
        with:
          push: true
          tags: ${{ env.IMAGE }}:${{ github.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

      # Déclenchement du déploiement. Les champs git_* sont facultatifs : ils
      # permettent de retrouver quel commit tourne en production.
      - name: Déployer {{app}}
        run: |
          curl -sSf -X POST {{endpoint}} \
            -H "Authorization: Bearer ${{ secrets.KYBERS_TOKEN }}" \
            -H "Content-Type: application/json" \
            -d '{
              "environment": "{{env}}",
              "image": "${{ env.IMAGE }}:${{ github.sha }}",
              "git_commit": "${{ github.sha }}",
              "git_ref": "${{ github.ref_name }}",
              "source": "ci"
            }'
`,
	},
	{
		Name:        "README standard",
		Description: "Démarrage, configuration et déploiement.",
		Kind:        "readme",
		Path:        "README.md",
		IsDefault:   true,
		Content: `# {{app}}

> Décrivez en une phrase ce que fait ce service.

## Démarrage

` + "```bash" + `
git clone https://github.com/{{repo}}.git
cd {{app}}
# installez les dépendances, puis lancez le service
` + "```" + `

## Configuration

| Variable | Description | Défaut |
| --- | --- | --- |
| ` + "`PORT`" + ` | Port d'écoute | ` + "`8080`" + ` |

## Déploiement

Ce service est déployé par Kybers. Chaque push sur ` + "`main`" + ` construit
l'image, la publie, puis déclenche un déploiement.

Les environnements sont des namespaces Kubernetes distincts : ` + "`production`" + `,
` + "`staging`" + `, et tout autre nom que vous créez.
`,
	},
	{
		Name:        "CODEOWNERS",
		Description: "Revue obligatoire par l'équipe propriétaire.",
		Kind:        "fichier",
		Path:        ".github/CODEOWNERS",
		Content: `# Toute modification passe par une revue de l'équipe.
* @votre-organisation/votre-equipe
`,
	},
}

// SeedTemplates insère les modèles fournis, une seule fois par organisation.
//
// L'insertion est ignorée si un modèle du même nom existe déjà : une équipe
// qui les a supprimés ne doit pas les voir réapparaître.
func (d *DB) SeedTemplates(ctx context.Context, orgID string) error {
	var seeded bool
	err := d.Pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM file_templates WHERE org_id = $1)`, orgID,
	).Scan(&seeded)
	if err != nil || seeded {
		return err
	}

	for _, t := range builtinTemplates {
		// L'unicité porte sur le chemin depuis la migration 013 : viser
		// l'ancienne contrainte de nom échouait sur une instance neuve.
		if _, err := d.Pool.Exec(ctx, `
			INSERT INTO file_templates (org_id, name, description, kind, path, content, is_default)
			VALUES ($1, $2, $3, $4, $5, $6, $7)
			ON CONFLICT (org_id, COALESCE(folder_id, '00000000-0000-0000-0000-000000000000'::uuid), path)
			DO NOTHING`,
			orgID, t.Name, t.Description, t.Kind, t.Path, t.Content, t.IsDefault,
		); err != nil {
			return err
		}
	}
	return nil
}
