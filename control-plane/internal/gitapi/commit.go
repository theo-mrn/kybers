package gitapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

// Écriture groupée : tous les fichiers dans un seul commit.
//
// L'API Contents crée un commit par fichier. Initialiser un dépôt de six
// fichiers produisait donc six commits « chore: initialisation », dont cinq
// décrivent un état intermédiaire que personne n'a jamais eu. L'API Git de bas
// niveau permet de construire un arbre complet et de ne référencer qu'un
// commit.
//
// Le prix est un aller-retour de plus : il faut connaître le commit parent
// avant de bâtir l'arbre. Il reste inférieur au coût d'un appel par fichier.

// File est un fichier à écrire dans le dépôt.
type File struct {
	Path    string
	Content string
}

// PutFiles écrit tous les fichiers en un seul commit sur la branche par défaut.
//
// Les fichiers existants sont remplacés, les autres conservés : l'arbre est
// construit à partir de celui du commit parent.
func (c *Client) PutFiles(ctx context.Context, fullName string, files []File, message string) error {
	if len(files) == 0 {
		return nil
	}
	token, apiURL := c.credentials(ctx)
	if token == "" {
		return ErrNotConfigured
	}

	base := apiURL + "/repos/" + fullName

	repo, err := c.GetRepo(ctx, fullName)
	if err != nil {
		return err
	}
	branch := repo.DefaultBranch
	if branch == "" {
		branch = "main"
	}

	// Le commit courant devient le parent. Son absence signifie un dépôt sans
	// aucun commit : l'arbre part alors de rien.
	var parent, baseTree string
	var ref struct {
		Object struct {
			SHA string `json:"sha"`
		} `json:"object"`
	}
	if err := c.getJSON(ctx, base+"/git/ref/heads/"+branch, &ref); err == nil {
		parent = ref.Object.SHA

		var commit struct {
			Tree struct {
				SHA string `json:"sha"`
			} `json:"tree"`
		}
		if err := c.getJSON(ctx, base+"/git/commits/"+parent, &commit); err == nil {
			baseTree = commit.Tree.SHA
		}
	}

	// Les contenus passent par des blobs : l'arbre ne peut pas porter de
	// contenu binaire, et l'encodage base64 évite les surprises d'échappement.
	entries := make([]map[string]any, 0, len(files))
	for _, f := range files {
		path := strings.TrimPrefix(strings.TrimSpace(f.Path), "/")
		if path == "" {
			continue
		}

		var blob struct {
			SHA string `json:"sha"`
		}
		if err := c.postJSON(ctx, base+"/git/blobs", map[string]any{
			"content":  base64.StdEncoding.EncodeToString([]byte(f.Content)),
			"encoding": "base64",
		}, &blob); err != nil {
			return fmt.Errorf("%s : %w", path, err)
		}

		entries = append(entries, map[string]any{
			"path": path,
			"mode": "100644",
			"type": "blob",
			"sha":  blob.SHA,
		})
	}
	if len(entries) == 0 {
		return nil
	}

	tree := map[string]any{"tree": entries}
	if baseTree != "" {
		tree["base_tree"] = baseTree
	}
	var created struct {
		SHA string `json:"sha"`
	}
	if err := c.postJSON(ctx, base+"/git/trees", tree, &created); err != nil {
		return err
	}

	payload := map[string]any{
		"message": message,
		"tree":    created.SHA,
	}
	if parent != "" {
		payload["parents"] = []string{parent}
	}
	var commit struct {
		SHA string `json:"sha"`
	}
	if err := c.postJSON(ctx, base+"/git/commits", payload, &commit); err != nil {
		return err
	}

	// Déplacer la référence publie le commit. Sans `force`, GitHub refuse si
	// la branche a avancé entre-temps — ce qui est le comportement voulu.
	if parent != "" {
		return c.patchJSON(ctx, base+"/git/refs/heads/"+branch,
			map[string]any{"sha": commit.SHA}, nil)
	}
	return c.postJSON(ctx, base+"/git/refs", map[string]any{
		"ref": "refs/heads/" + branch,
		"sha": commit.SHA,
	}, nil)
}

// getJSON lit une ressource de l'API Git.
func (c *Client) getJSON(ctx context.Context, endpoint string, out any) error {
	return c.sendJSON(ctx, http.MethodGet, endpoint, nil, out)
}

func (c *Client) postJSON(ctx context.Context, endpoint string, body, out any) error {
	return c.sendJSON(ctx, http.MethodPost, endpoint, body, out)
}

func (c *Client) patchJSON(ctx context.Context, endpoint string, body, out any) error {
	return c.sendJSON(ctx, http.MethodPatch, endpoint, body, out)
}

// sendJSON exécute une requête authentifiée et décode la réponse.
func (c *Client) sendJSON(ctx context.Context, method, endpoint string, body, out any) error {
	token, _ := c.credentials(ctx)
	if token == "" {
		return ErrNotConfigured
	}

	var reader *strings.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = strings.NewReader(string(raw))
	} else {
		reader = strings.NewReader("")
	}

	req, err := http.NewRequestWithContext(ctx, method, endpoint, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	c.auth(req, token)

	res, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()

	if res.StatusCode >= 400 {
		detail := apiMessage(res.Body)
		switch res.StatusCode {
		case http.StatusUnauthorized, http.StatusForbidden, http.StatusNotFound:
			// GitHub répond 404 plutôt que 403 quand le jeton n'a pas le droit
			// d'écrire : il masque l'existence de la ressource.
			return fmt.Errorf(
				"écriture refusée : le jeton doit avoir « Contents: write » (fine-grained) ou la portée « repo » (classique) ; un workflow exige en plus « Workflows: write » ou « workflow ». %s",
				detail)
		default:
			return fmt.Errorf("api git (statut %d) : %s", res.StatusCode, detail)
		}
	}

	if out == nil {
		return nil
	}
	return json.NewDecoder(res.Body).Decode(out)
}
