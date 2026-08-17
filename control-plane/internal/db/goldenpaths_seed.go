package db

import (
	"context"
	"fmt"
	"strings"

	"github.com/kybers/kybers/control-plane/internal/models"
)

// Types d'application fournis avec Kybers.
//
// Un type produit un dépôt qui démarre : manifeste de dépendances, serveur
// minimal exposant la sonde de santé, Dockerfile qui le construit, workflow qui
// le déploie. Livrer un Dockerfile seul, sur un dépôt sans code, ne construit
// rien — c'est la différence entre un gabarit et un point de départ.
//
// La version du runtime est le paramètre du type : elle se propage dans le FROM
// de l'image, le manifeste et le code via la substitution {{version}}.
//
// Ils sont copiés dans l'organisation à l'installation, puis lui appartiennent :
// éditables depuis /modeles, sans redéploiement de Kybers.

type goldenPath struct {
	folder models.TemplateFolder
	files  []models.FileTemplate
}

// Workflow commun aux types : Kybers ne construit pas les images, le CI s'en
// charge et appelle l'API de déploiement. Le jeton est déposé en secret à
// l'écriture des fichiers.
const deployWorkflow = `name: Déployer sur Kybers

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

      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: ${{ env.IMAGE }}:${{ github.sha }}

      - name: Déployer
        run: |
          curl -sSf -X POST {{endpoint}} \
            -H "Authorization: Bearer ${{ secrets.KYBERS_TOKEN }}" \
            -H "Content-Type: application/json" \
            -d '{
              "environment": "production",
              "image": "${{ env.IMAGE }}:${{ github.sha }}",
              "git_commit": "${{ github.sha }}",
              "git_ref": "${{ github.ref_name }}",
              "source": "ci"
            }'
`

// pipelineFile construit l'entrée « pipeline » commune à tous les types.
func pipelineFile() models.FileTemplate {
	return models.FileTemplate{
		Name:        "Pipeline de déploiement",
		Description: "Build, publication sur GHCR, appel de Kybers.",
		Kind:        "pipeline",
		Path:        ".github/workflows/deploy.yml",
		Content:     deployWorkflow,
	}
}

var builtinGoldenPaths = []goldenPath{
	// -----------------------------------------------------------------------
	{
		folder: models.TemplateFolder{
			Name:           "Service Node",
			RuntimeImage:   "node",
			Description:    "API Node.js avec Express. Serveur, Dockerfile et pipeline prêts à démarrer.",
			IsGoldenPath:   true,
			Icon:           "hexagon",
			Versions:       "24,22,20",
			DefaultVersion: "22",
			DefaultPort:    3000,
			// Node consomme plus de mémoire que de CPU : le heap V8 occupe une
			// centaine de mégaoctets au repos.
			CPURequest:        "100m",
			MemoryRequest:     "256Mi",
			CPULimit:          "1",
			MemoryLimit:       "512Mi",
			ProbePath:         "/health",
			ProbeInitialDelay: 10,
			RunAsUser:         1000, // utilisateur `node` des images officielles
		},
		files: []models.FileTemplate{
			{
				Name:        "package.json",
				Description: "Dépendances et scripts. La version verrouille le runtime.",
				Kind:        "fichier",
				Path:        "package.json",
				Content: `{
  "name": "{{app}}",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">={{version}}"
  },
  "scripts": {
    "start": "node server.js",
    "dev": "node --watch server.js"
  },
  "dependencies": {
    "express": "^5.1.0"
  }
}
`,
			},
			{
				Name:        "server.js",
				Description: "Serveur minimal exposant /health, la sonde du déploiement.",
				Kind:        "fichier",
				Path:        "server.js",
				Content: `import express from "express";

const app = express();
const port = process.env.PORT ?? 3000;

app.get("/", (_req, res) => {
  res.json({ service: "{{app}}", env: process.env.NODE_ENV ?? "development" });
});

// Kybers interroge cette route pour savoir si le conteneur est prêt.
// La déplacer demande d'ajuster la sonde dans les paramètres de l'application.
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.listen(port, "0.0.0.0", () => {
  console.log(` + "`{{app}} écoute sur :${port}`" + `);
});
`,
			},
			{
				Name:        "Dockerfile",
				Description: "Build multi-étapes, dépendances de production seules.",
				Kind:        "fichier",
				Path:        "Dockerfile",
				Content: `FROM node:{{version}}-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

FROM node:{{version}}-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# L'image officielle fournit déjà l'utilisateur ` + "`node`" + ` (UID 1000).
USER node
EXPOSE 3000

CMD ["node", "server.js"]
`,
			},
			{
				Name:        ".dockerignore",
				Description: "Évite d'embarquer node_modules et les secrets locaux.",
				Kind:        "fichier",
				Path:        ".dockerignore",
				Content: `node_modules
npm-debug.log
.env
.env.*
!.env.example
.git
.github
coverage
`,
			},
			{
				Name:        ".env.example",
				Description: "Variables attendues, à recopier en .env local.",
				Kind:        "fichier",
				Path:        ".env.example",
				Content: `PORT=3000
NODE_ENV=development
`,
			},
			pipelineFile(),
		},
	},

	// -----------------------------------------------------------------------
	{
		folder: models.TemplateFolder{
			Name:           "Service Python",
			RuntimeImage:   "python",
			Description:    "API Python avec FastAPI. Serveur, Dockerfile et pipeline prêts à démarrer.",
			IsGoldenPath:   true,
			Icon:           "circle-dot",
			Versions:       "3.13,3.12,3.11",
			DefaultVersion: "3.12",
			DefaultPort:    8000,
			CPURequest:     "100m",
			MemoryRequest:  "256Mi",
			CPULimit:       "1",
			MemoryLimit:    "512Mi",
			ProbePath:      "/health",
			// L'import des dépendances peut être long au premier démarrage.
			ProbeInitialDelay: 15,
			RunAsUser:         1000,
		},
		files: []models.FileTemplate{
			{
				Name:        "requirements.txt",
				Description: "Dépendances épinglées.",
				Kind:        "fichier",
				Path:        "requirements.txt",
				Content: `fastapi==0.118.0
uvicorn[standard]==0.37.0
`,
			},
			{
				Name:        "main.py",
				Description: "Serveur minimal exposant /health, la sonde du déploiement.",
				Kind:        "fichier",
				Path:        "main.py",
				Content: `import os

from fastapi import FastAPI

app = FastAPI(title="{{app}}")


@app.get("/")
def root():
    return {"service": "{{app}}", "env": os.getenv("ENV", "development")}


# Kybers interroge cette route pour savoir si le conteneur est prêt.
# La déplacer demande d'ajuster la sonde dans les paramètres de l'application.
@app.get("/health")
def health():
    return {"status": "ok"}
`,
			},
			{
				Name:        "Dockerfile",
				Description: "Dépendances en couche séparée, utilisateur dédié.",
				Kind:        "fichier",
				Path:        "Dockerfile",
				Content: `FROM python:{{version}}-slim
WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Les images Python n'embarquent pas d'utilisateur non-root : on le crée.
RUN useradd --uid 1000 --create-home app && chown -R app:app /app
USER app

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
`,
			},
			{
				Name:        ".dockerignore",
				Description: "Évite d'embarquer l'environnement virtuel et les caches.",
				Kind:        "fichier",
				Path:        ".dockerignore",
				Content: `__pycache__
*.py[cod]
.venv
venv
.env
.env.*
!.env.example
.git
.github
.pytest_cache
.mypy_cache
`,
			},
			{
				Name:        ".env.example",
				Description: "Variables attendues, à recopier en .env local.",
				Kind:        "fichier",
				Path:        ".env.example",
				Content: `ENV=development
PORT=8000
`,
			},
			pipelineFile(),
		},
	},

	// -----------------------------------------------------------------------
	{
		folder: models.TemplateFolder{
			Name:           "Service Go",
			RuntimeImage:   "golang",
			Description:    "API Go sur bibliothèque standard. Binaire statique, image distroless.",
			IsGoldenPath:   true,
			Icon:           "square-code",
			Versions:       "1.25,1.24,1.23",
			DefaultVersion: "1.24",
			DefaultPort:    8080,
			// Un binaire Go démarre instantanément et consomme peu.
			CPURequest:        "50m",
			MemoryRequest:     "64Mi",
			CPULimit:          "1",
			MemoryLimit:       "256Mi",
			ProbePath:         "/healthz",
			ProbeInitialDelay: 3,
			RunAsUser:         65532, // `nonroot` des images distroless
		},
		files: []models.FileTemplate{
			{
				Name:        "go.mod",
				Description: "Module et version du langage.",
				Kind:        "fichier",
				Path:        "go.mod",
				Content: `module {{app}}

go {{version}}
`,
			},
			{
				Name:        "main.go",
				Description: "Serveur minimal exposant /healthz, la sonde du déploiement.",
				Kind:        "fichier",
				Path:        "cmd/server/main.go",
				Content: `package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
)

func main() {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]string{
			"service": "{{app}}",
			"env":     env("ENV", "development"),
		})
	})

	// Kybers interroge cette route pour savoir si le conteneur est prêt.
	// La déplacer demande d'ajuster la sonde dans les paramètres de l'application.
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]string{"status": "ok"})
	})

	addr := ":" + env("PORT", "8080")
	log.Printf("{{app}} écoute sur %s", addr)
	log.Fatal(http.ListenAndServe(addr, mux))
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
`,
			},
			{
				Name:        "Dockerfile",
				Description: "Compilation statique, image finale sans shell.",
				Kind:        "fichier",
				Path:        "Dockerfile",
				Content: `FROM golang:{{version}}-alpine AS build
WORKDIR /src

COPY go.mod ./
RUN go mod download

COPY . .
# CGO désactivé : le binaire doit tourner sur une image sans libc.
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /app ./cmd/server

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /app /app

USER nonroot:nonroot
EXPOSE 8080

ENTRYPOINT ["/app"]
`,
			},
			{
				Name:        ".dockerignore",
				Description: "Évite d'embarquer les artefacts de build locaux.",
				Kind:        "fichier",
				Path:        ".dockerignore",
				Content: `.env
.env.*
!.env.example
.git
.github
*.test
`,
			},
			{
				Name:        ".env.example",
				Description: "Variables attendues, à recopier en .env local.",
				Kind:        "fichier",
				Path:        ".env.example",
				Content: `ENV=development
PORT=8080
`,
			},
			pipelineFile(),
		},
	},
}

// BuiltinGoldenPath décrit un type fourni, sans l'installer.
//
// Le dashboard les propose à côté de ceux de l'organisation : un type supprimé,
// ou jamais reçu par une organisation antérieure, doit rester accessible.
type BuiltinGoldenPath struct {
	Key    string                `json:"key"`
	Folder models.TemplateFolder `json:"folder"`
	Files  []models.FileTemplate `json:"files"`
}

// ListBuiltinGoldenPaths retourne les types fournis avec Kybers.
func ListBuiltinGoldenPaths() []BuiltinGoldenPath {
	out := make([]BuiltinGoldenPath, 0, len(builtinGoldenPaths))
	for _, gp := range builtinGoldenPaths {
		out = append(out, BuiltinGoldenPath{
			Key:    slugOf(gp.folder.Name),
			Folder: gp.folder,
			Files:  gp.files,
		})
	}
	return out
}

// InstallGoldenPath installe un type fourni dans l'organisation.
//
// Le nom est rendu unique si besoin : réinstaller « Service Node » alors qu'un
// dossier du même nom existe doit aboutir, pas échouer sur une contrainte.
func (d *DB) InstallGoldenPath(ctx context.Context, orgID, key string) (*models.TemplateFolder, error) {
	for _, gp := range builtinGoldenPaths {
		if slugOf(gp.folder.Name) != key {
			continue
		}

		f := gp.folder
		f.OrgID = orgID
		f.Name = d.uniqueFolderName(ctx, orgID, f.Name)

		saved, err := d.SaveFolder(ctx, orgID, f)
		if err != nil {
			return nil, err
		}
		for _, t := range gp.files {
			t.FolderID = saved.ID
			// Un seul modèle par catégorie peut porter le statut « par
			// défaut » : le conserver ferait échouer une seconde installation
			// sur l'index partiel.
			t.IsDefault = false
			if _, err := d.SaveTemplate(ctx, orgID, "", t); err != nil {
				return nil, err
			}
		}
		return saved, nil
	}
	return nil, ErrNotFound
}

// uniqueFolderName suffixe le nom tant qu'il est pris.
func (d *DB) uniqueFolderName(ctx context.Context, orgID, name string) string {
	candidate := name
	for i := 2; i < 100; i++ {
		var taken bool
		if err := d.Pool.QueryRow(ctx,
			`SELECT EXISTS(SELECT 1 FROM template_folders WHERE org_id = $1 AND name = $2)`,
			orgID, candidate,
		).Scan(&taken); err != nil || !taken {
			return candidate
		}
		candidate = fmt.Sprintf("%s (%d)", name, i)
	}
	return candidate
}

// slugOf réduit un nom à une clé stable, utilisée par l'API.
func slugOf(name string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(name) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == ' ', r == '-', r == '_':
			b.WriteByte('-')
		}
	}
	return strings.Trim(b.String(), "-")
}

// SeedGoldenPaths insère les types fournis, une seule fois par organisation.
//
// Une équipe qui les a supprimés ne doit pas les voir réapparaître : la
// présence d'un seul dossier suffit à considérer l'organisation comme servie.
func (d *DB) SeedGoldenPaths(ctx context.Context, orgID string) error {
	var seeded bool
	err := d.Pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM template_folders WHERE org_id = $1)`, orgID,
	).Scan(&seeded)
	if err != nil || seeded {
		return err
	}

	for _, gp := range builtinGoldenPaths {
		if _, err := d.InstallGoldenPath(ctx, orgID, slugOf(gp.folder.Name)); err != nil {
			return err
		}
	}
	return nil
}
