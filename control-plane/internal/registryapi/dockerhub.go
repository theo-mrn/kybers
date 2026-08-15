// Package registryapi interroge l'API d'un registre d'images pour lister les
// dépôts et les tags d'un compte.
//
// Note importante : ce n'est PAS le Registry API v2 (celui qu'utilise le
// kubelet pour tirer les images). Le Registry v2 n'expose pas de catalogue par
// utilisateur ; lister les dépôts d'un compte passe par l'API applicative du
// fournisseur, spécifique à chacun. Seul Docker Hub est implémenté ici.
package registryapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const (
	dockerHubAPI = "https://hub.docker.com/v2"
	httpTimeout  = 15 * time.Second
)

// Repository est un dépôt d'images d'un compte.
type Repository struct {
	Name        string    `json:"name"` // ex: "org/mon-app"
	Description string    `json:"description"`
	Private     bool      `json:"private"`
	PullCount   int64     `json:"pull_count"`
	LastUpdated time.Time `json:"last_updated"`
	// Tag proposé par défaut au déploiement. Tous les dépôts n'ont pas
	// « latest » : supposer ce tag produirait un ImagePullBackOff.
	DefaultTag string `json:"default_tag,omitempty"`
}

// Tag est une version publiée d'un dépôt.
type Tag struct {
	Name        string    `json:"name"`
	Size        int64     `json:"size"`
	LastUpdated time.Time `json:"last_updated"`
	// Référence complète, directement utilisable comme image de déploiement.
	Image string `json:"image"`
}

type Client struct {
	http *http.Client
	// baseURL permet de pointer un serveur de test ; vide = API Docker Hub.
	baseURL string
}

func New() *Client {
	return &Client{http: &http.Client{Timeout: httpTimeout}, baseURL: dockerHubAPI}
}

// IsDockerHub reconnaît les différentes écritures du serveur Docker Hub.
func IsDockerHub(server string) bool {
	s := strings.ToLower(strings.TrimSpace(server))
	s = strings.TrimPrefix(s, "https://")
	s = strings.TrimPrefix(s, "http://")
	s = strings.TrimSuffix(s, "/")
	return s == "" ||
		s == "docker.io" ||
		s == "registry-1.docker.io" ||
		s == "index.docker.io" ||
		s == "index.docker.io/v1" ||
		s == "hub.docker.com"
}

// Login échange des identifiants contre un jeton de session Hub.
//
// Ce jeton n'est utilisé que pour lister les dépôts : les pulls d'images dans
// le cluster passent, eux, par l'imagePullSecret.
func (c *Client) Login(ctx context.Context, username, password string) (string, error) {
	body, err := json.Marshal(map[string]string{
		"username": username,
		"password": password,
	})
	if err != nil {
		return "", err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		c.base()+"/users/login", strings.NewReader(string(body)))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("docker hub injoignable: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusUnauthorized {
		return "", fmt.Errorf("identifiants refusés par docker hub")
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("docker hub a répondu %d", resp.StatusCode)
	}

	var out struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", err
	}
	if out.Token == "" {
		return "", fmt.Errorf("aucun jeton renvoyé par docker hub")
	}
	return out.Token, nil
}

// ListRepositories liste les dépôts d'un compte. Avec un jeton, les dépôts
// privés sont inclus ; sans jeton, seuls les publics remontent.
func (c *Client) ListRepositories(ctx context.Context, namespace, token string) ([]Repository, error) {
	if namespace == "" {
		return nil, fmt.Errorf("compte docker hub non précisé")
	}

	endpoint := fmt.Sprintf("%s/repositories/%s/?page_size=100&ordering=last_updated",
		c.base(), url.PathEscape(namespace))

	var payload struct {
		Results []struct {
			Name        string `json:"name"`
			Namespace   string `json:"namespace"`
			Description string `json:"description"`
			IsPrivate   bool   `json:"is_private"`
			PullCount   int64  `json:"pull_count"`
			LastUpdated string `json:"last_updated"`
		} `json:"results"`
	}
	if err := c.get(ctx, endpoint, token, &payload); err != nil {
		return nil, err
	}

	repos := make([]Repository, 0, len(payload.Results))
	for _, r := range payload.Results {
		ns := r.Namespace
		if ns == "" {
			ns = namespace
		}
		repos = append(repos, Repository{
			Name:        ns + "/" + r.Name,
			Description: r.Description,
			Private:     r.IsPrivate,
			PullCount:   r.PullCount,
			LastUpdated: parseTime(r.LastUpdated),
		})
	}
	return repos, nil
}

// ListTags liste les tags d'un dépôt. repository est au format "compte/nom".
func (c *Client) ListTags(ctx context.Context, repository, token string) ([]Tag, error) {
	parts := strings.SplitN(repository, "/", 2)
	if len(parts) != 2 {
		// Un nom sans namespace désigne une image officielle (nginx -> library/nginx).
		parts = []string{"library", repository}
	}

	endpoint := fmt.Sprintf("%s/repositories/%s/%s/tags?page_size=100&ordering=last_updated",
		c.base(), url.PathEscape(parts[0]), url.PathEscape(parts[1]))

	var payload struct {
		Results []struct {
			Name        string `json:"name"`
			FullSize    int64  `json:"full_size"`
			LastUpdated string `json:"last_updated"`
		} `json:"results"`
	}
	if err := c.get(ctx, endpoint, token, &payload); err != nil {
		return nil, err
	}

	// Les images officielles se référencent sans le préfixe "library/" :
	// "nginx:alpine", jamais "library/nginx:alpine".
	ref := repository
	if parts[0] == "library" {
		ref = parts[1]
	}

	tags := make([]Tag, 0, len(payload.Results))
	for _, t := range payload.Results {
		tags = append(tags, Tag{
			Name:        t.Name,
			Size:        t.FullSize,
			LastUpdated: parseTime(t.LastUpdated),
			Image:       ref + ":" + t.Name,
		})
	}
	return tags, nil
}

// base retourne l'URL de l'API, avec repli sur Docker Hub.
func (c *Client) base() string {
	if c.baseURL != "" {
		return c.baseURL
	}
	return dockerHubAPI
}

// ResolveDefaultTags renseigne DefaultTag pour chaque dépôt : « latest » s'il
// existe, sinon le tag nommé le plus récent, sinon le premier disponible.
//
// Un appel par dépôt est nécessaire (l'API ne renvoie pas les tags avec la
// liste) : ils sont donc lancés en parallèle, avec une borne de concurrence.
func (c *Client) ResolveDefaultTags(ctx context.Context, repos []Repository, token string) {
	const maxParallel = 8

	sem := make(chan struct{}, maxParallel)
	var wg sync.WaitGroup

	for i := range repos {
		wg.Add(1)
		go func(r *Repository) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			tags, err := c.ListTags(ctx, r.Name, token)
			if err != nil || len(tags) == 0 {
				return
			}
			r.DefaultTag = pickDefaultTag(tags)
		}(&repos[i])
	}
	wg.Wait()
}

// pickDefaultTag choisit le tag le plus pertinent pour un déploiement.
func pickDefaultTag(tags []Tag) string {
	var newestNamed string
	var newestNamedAt time.Time

	for _, t := range tags {
		if t.Name == "latest" {
			return "latest" // convention la plus courante, priorité absolue
		}
		// Les tags-hash (sha256-…, sha-abc123, hash de commit) désignent une
		// build précise : un humain ne les choisirait pas par défaut.
		if isHashTag(t.Name) {
			continue
		}
		if t.LastUpdated.After(newestNamedAt) {
			newestNamed, newestNamedAt = t.Name, t.LastUpdated
		}
	}
	if newestNamed != "" {
		return newestNamed
	}
	return tags[0].Name
}

func isHashTag(name string) bool {
	if strings.HasPrefix(name, "sha256") || strings.HasPrefix(name, "sha-") {
		return true
	}
	// Chaîne purement hexadécimale d'au moins 7 caractères : hash de commit.
	if len(name) < 7 {
		return false
	}
	for _, r := range name {
		isHex := (r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') || (r >= 'A' && r <= 'F')
		if !isHex {
			return false
		}
	}
	return true
}

func (c *Client) get(ctx context.Context, endpoint, token string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	if token != "" {
		req.Header.Set("Authorization", "JWT "+token)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("docker hub injoignable: %w", err)
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusOK:
	case http.StatusUnauthorized, http.StatusForbidden:
		return fmt.Errorf("accès refusé par docker hub")
	case http.StatusNotFound:
		return fmt.Errorf("compte ou dépôt introuvable sur docker hub")
	default:
		return fmt.Errorf("docker hub a répondu %d", resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

func parseTime(s string) time.Time {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return time.Time{}
	}
	return t
}
