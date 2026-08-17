// Package gitapi interroge l'API d'un hébergeur Git pour rattacher un dépôt à
// une application : documentation, pipelines, métadonnées.
//
// Kybers est installé chez le client : le jeton est fourni par la
// configuration de l'instance, comme l'accès à la base ou au cluster. Les
// appels sont sortants — rien à exposer côté Kybers.
//
// Seul GitHub est implémenté pour l'instant ; l'URL de base est configurable
// pour couvrir GitHub Enterprise aussi bien que github.com.
package gitapi

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/nacl/box"
)

const (
	defaultAPI  = "https://api.github.com"
	httpTimeout = 15 * time.Second
)

// ErrNotConfigured signale qu'aucun jeton n'a été fourni à l'instance.
var ErrNotConfigured = errors.New("intégration Git non configurée")

// Repo est un dépôt rattaché à une application.
type Repo struct {
	FullName      string    `json:"full_name"` // "owner/name"
	Description   string    `json:"description"`
	Private       bool      `json:"private"`
	HTMLURL       string    `json:"html_url"`
	DefaultBranch string    `json:"default_branch"`
	Language      string    `json:"language"`
	PushedAt      time.Time `json:"pushed_at"`
}

// Doc est un fichier de documentation du dépôt.
type Doc struct {
	Path string `json:"path"`
	Name string `json:"name"`
	Size int    `json:"size"`
	/** Contenu rendu en HTML ; renseigné seulement à la lecture d'un fichier. */
	HTML string `json:"html,omitempty"`
}

// Run est une exécution de pipeline.
type Run struct {
	ID         int64     `json:"id"`
	Name       string    `json:"name"`
	Status     string    `json:"status"`     // queued, in_progress, completed
	Conclusion string    `json:"conclusion"` // success, failure, cancelled…
	Branch     string    `json:"branch"`
	Commit     string    `json:"commit"`
	Message    string    `json:"message"`
	Actor      string    `json:"actor"`
	HTMLURL    string    `json:"html_url"`
	StartedAt  time.Time `json:"started_at"`
	UpdatedAt  time.Time `json:"updated_at"`
}

type Client struct {
	http    *http.Client
	baseURL string
	token   string
	// login est résolu au premier Whoami et lu par CreateRepo : les deux
	// peuvent survenir sur des requêtes concurrentes.
	mu    sync.RWMutex
	login string

	// resolve fournit le jeton et l'URL courants. Le jeton peut être modifié
	// depuis l'interface : le figer à la construction imposerait un
	// redémarrage à chaque changement.
	resolve func(context.Context) (token, apiURL string)
}

// WithResolver branche une source dynamique de configuration.
//
// Elle prime sur les valeurs de construction quand elle renvoie un jeton ; à
// défaut, la variable d'environnement continue de s'appliquer.
func (c *Client) WithResolver(f func(context.Context) (string, string)) *Client {
	c.resolve = f
	return c
}

// credentials retourne le jeton et l'URL à utiliser pour un appel.
func (c *Client) credentials(ctx context.Context) (string, string) {
	token, apiURL := c.token, c.baseURL
	if c.resolve != nil {
		if t, u := c.resolve(ctx); t != "" {
			token = t
			if u != "" {
				apiURL = strings.TrimRight(u, "/")
			}
		}
	}
	if apiURL == "" {
		apiURL = defaultAPI
	}
	return token, apiURL
}

// New construit le client depuis la configuration de l'instance.
//
// Un jeton vide donne un client inerte : toutes les méthodes renvoient
// ErrNotConfigured plutôt que d'échouer au démarrage, l'intégration Git étant
// facultative.
func New(token, apiURL string) *Client {
	base := strings.TrimRight(strings.TrimSpace(apiURL), "/")
	if base == "" {
		base = defaultAPI
	}
	return &Client{
		http:    &http.Client{Timeout: httpTimeout},
		baseURL: base,
		token:   strings.TrimSpace(token),
	}
}

// Configured indique si l'instance dispose d'un jeton, de sa configuration ou
// de ses réglages.
func (c *Client) Configured(ctx context.Context) bool {
	if c == nil {
		return false
	}
	token, _ := c.credentials(ctx)
	return token != ""
}

// ParseRepo normalise une référence de dépôt.
//
// Accepte « owner/name » comme une URL complète : les utilisateurs collent
// naturellement l'URL de leur navigateur.
func ParseRepo(ref string) (string, error) {
	s := strings.TrimSpace(ref)
	s = strings.TrimSuffix(s, ".git")
	s = strings.TrimRight(s, "/")

	// URL HTTP(S) : on retire le schéma puis l'hôte.
	if i := strings.Index(s, "://"); i >= 0 {
		s = s[i+3:]
		if j := strings.Index(s, "/"); j >= 0 {
			s = s[j+1:]
		}
	}

	// Forme SSH « git@hôte:owner/nom » : le chemin suit le deux-points.
	if strings.HasPrefix(s, "git@") {
		if i := strings.Index(s, ":"); i >= 0 {
			s = s[i+1:]
		}
	}

	parts := strings.Split(s, "/")
	if len(parts) < 2 {
		return "", fmt.Errorf("dépôt attendu au format « owner/nom »")
	}
	// Une URL peut porter des segments supplémentaires — /tree/main,
	// /blob/… — mais le dépôt est toujours identifié par les deux premiers.
	owner, name := parts[0], parts[1]
	if owner == "" || name == "" {
		return "", fmt.Errorf("dépôt attendu au format « owner/nom »")
	}
	return owner + "/" + name, nil
}

// Identity décrit ce que l'instance peut faire avec son jeton.
type Identity struct {
	Login string `json:"login"`
	/** Vrai si le jeton autorise la création de dépôts. */
	CanCreate bool `json:"can_create"`
	/** Organisations où l'utilisateur peut créer, en plus de son compte. */
	Owners []string `json:"owners"`
	/** Portées annoncées par GitHub ; vide pour un jeton fine-grained. */
	Scopes string `json:"scopes,omitempty"`
}

// Whoami vérifie le jeton et déduit ce qu'il permet.
//
// La portée est lue dans l'en-tête `X-OAuth-Scopes`, que GitHub renseigne pour
// les jetons classiques. Les jetons fine-grained ne l'exposent pas : à défaut
// d'information, on suppose la création possible et l'API tranchera.
func (c *Client) Whoami(ctx context.Context) (*Identity, error) {
	res, err := c.do(ctx, "/user", "application/vnd.github+json")
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()

	var user struct {
		Login string `json:"login"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&user); err != nil {
		return nil, err
	}

	c.mu.Lock()
	c.login = user.Login
	c.mu.Unlock()

	scopes := res.Header.Get("X-OAuth-Scopes")
	canCreate := scopes == "" || strings.Contains(scopes, "repo")

	out := &Identity{
		Login:     user.Login,
		CanCreate: canCreate,
		Owners:    []string{user.Login},
		Scopes:    scopes,
	}

	// Les organisations ne sont listées que si le jeton les voit ; leur absence
	// n'est pas une erreur.
	var orgs []struct {
		Login string `json:"login"`
	}
	if err := c.get(ctx, "/user/orgs", &orgs); err == nil {
		for _, o := range orgs {
			out.Owners = append(out.Owners, o.Login)
		}
	}
	return out, nil
}

// CreateRepo crée un dépôt, sur le compte du jeton ou dans une organisation.
//
// L'appel échoue si le jeton n'a pas la portée d'écriture : c'est l'API qui
// fait foi, la portée annoncée par `Whoami` n'étant qu'indicative.
func (c *Client) CreateRepo(ctx context.Context, owner, name, description string, private bool) (*Repo, error) {
	token, apiURL := c.credentials(ctx)
	if token == "" {
		return nil, ErrNotConfigured
	}

	body, err := json.Marshal(map[string]any{
		"name":        name,
		"description": description,
		"private":     private,
		// Un dépôt vide n'a pas de branche : sans README, la création du
		// workflow échouerait faute de référence.
		"auto_init": true,
	})
	if err != nil {
		return nil, err
	}

	// Un dépôt personnel et un dépôt d'organisation n'ont pas le même point
	// d'entrée.
	c.mu.RLock()
	self := c.login
	c.mu.RUnlock()

	// Le compte du jeton n'est connu qu'après un Whoami : sans lui, un dépôt
	// personnel partirait sur /orgs/… et GitHub répondrait 404.
	if self == "" {
		if id, err := c.Whoami(ctx); err == nil {
			self = id.Login
		}
	}

	endpoint := "/user/repos"
	if owner != "" && !strings.EqualFold(owner, self) {
		endpoint = "/orgs/" + owner + "/repos"
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, apiURL+endpoint,
		strings.NewReader(string(body)))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("Content-Type", "application/json")
	c.auth(req, token)

	res, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("création du dépôt : %w", err)
	}
	defer res.Body.Close()

	if res.StatusCode >= 400 {
		switch res.StatusCode {
		case http.StatusUnauthorized, http.StatusForbidden:
			return nil, fmt.Errorf("le jeton ne permet pas de créer un dépôt")
		case http.StatusUnprocessableEntity:
			return nil, fmt.Errorf("un dépôt « %s » existe déjà, ou son nom est refusé", name)
		case http.StatusNotFound:
			// GitHub masque l'absence de droit derrière un 404 : sur /user/repos
			// cela signale un jeton sans portée d'écriture, sur /orgs/… une
			// organisation inconnue du jeton.
			return nil, fmt.Errorf(
				"création refusée : vérifiez que le jeton porte « repo » et que « %s » lui est accessible. %s",
				owner, apiMessage(res.Body))
		default:
			return nil, fmt.Errorf("création refusée (statut %d) : %s",
				res.StatusCode, apiMessage(res.Body))
		}
	}

	var out Repo
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ReadFile retourne le contenu brut d'un fichier.
func (c *Client) ReadFile(ctx context.Context, fullName, path string) (string, error) {
	raw, err := c.raw(ctx, "/repos/"+fullName+"/contents/"+path)
	if err != nil {
		return "", err
	}
	return string(raw), nil
}

// PutFile écrit — ou remplace — un fichier dans un dépôt.
//
// L'API exige le SHA du fichier existant pour le remplacer : sans lui, elle
// refuse d'écraser. On le lit donc au préalable, en tolérant son absence.
func (c *Client) PutFile(ctx context.Context, fullName, path, content, message string) error {
	token, apiURL := c.credentials(ctx)
	if token == "" {
		return ErrNotConfigured
	}

	payload := map[string]any{
		"message": message,
		"content": base64.StdEncoding.EncodeToString([]byte(content)),
	}
	if sha, err := c.fileSHA(ctx, fullName, path); err == nil && sha != "" {
		payload["sha"] = sha
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPut,
		apiURL+"/repos/"+fullName+"/contents/"+path, strings.NewReader(string(body)))
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("Content-Type", "application/json")
	c.auth(req, token)

	res, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("écriture du fichier : %w", err)
	}
	defer res.Body.Close()

	if res.StatusCode >= 400 {
		detail := apiMessage(res.Body)
		if res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden ||
			res.StatusCode == http.StatusNotFound {
			// GitHub répond 404 — et non 403 — quand le jeton n'a pas le droit
			// d'écrire : il masque l'existence de la ressource.
			if strings.HasPrefix(path, ".github/workflows/") {
				// Écrire un workflow exige une portée dédiée, distincte de
				// l'écriture ordinaire : `repo` seul ne suffit pas.
				return fmt.Errorf(
					"écriture refusée dans %s : écrire sous .github/workflows/ exige la portée « workflow » (jeton classique) ou « Workflows: write » (fine-grained), en plus de l'accès au dépôt. %s",
					fullName, detail)
			}
			return fmt.Errorf(
				"écriture refusée dans %s : le jeton doit avoir « Contents: write » (fine-grained) ou la portée « repo » (classique). %s",
				fullName, detail)
		}
		return fmt.Errorf("écriture refusée (statut %d) : %s", res.StatusCode, detail)
	}
	return nil
}

// apiMessage extrait le message d'erreur renvoyé par l'API.
func apiMessage(r io.Reader) string {
	var body struct {
		Message string `json:"message"`
	}
	if err := json.NewDecoder(io.LimitReader(r, 1<<16)).Decode(&body); err != nil {
		return ""
	}
	return body.Message
}

// fileSHA retourne l'empreinte d'un fichier existant, ou une chaîne vide.
func (c *Client) fileSHA(ctx context.Context, fullName, path string) (string, error) {
	var out struct {
		SHA string `json:"sha"`
	}
	if err := c.get(ctx, "/repos/"+fullName+"/contents/"+path, &out); err != nil {
		return "", err
	}
	return out.SHA, nil
}

// PutSecret dépose un secret de dépôt, chiffré comme l'exige l'API.
//
// GitHub impose un chiffrement à clé publique (libsodium sealed box) : le
// secret ne transite jamais en clair, même vers son API.
// Secret d'un dépôt : son nom et sa date, jamais sa valeur.
type Secret struct {
	Name      string    `json:"name"`
	UpdatedAt time.Time `json:"updated_at"`
}

// ListSecrets retourne les secrets Actions du dépôt.
//
// GitHub ne renvoie jamais les valeurs — elles sont chiffrées pour une clé que
// seul le runner détient. Les noms suffisent à savoir ce que le CI connaît, et
// c'est la seule chose que Kybers puisse en dire.
// Variable d'un dépôt : contrairement au secret, sa valeur est lisible.
type Variable struct {
	Name      string    `json:"name"`
	Value     string    `json:"value"`
	UpdatedAt time.Time `json:"updated_at"`
}

// ListVariables retourne les variables Actions du dépôt, valeurs comprises.
//
// GitHub les distingue des secrets : une variable n'est pas chiffrée, elle est
// faite pour être relue. C'est ce qui permet de les afficher telles quelles.
func (c *Client) ListVariables(ctx context.Context, fullName string) ([]Variable, error) {
	var payload struct {
		Variables []struct {
			Name      string `json:"name"`
			Value     string `json:"value"`
			UpdatedAt string `json:"updated_at"`
		} `json:"variables"`
	}
	if err := c.get(ctx, "/repos/"+fullName+"/actions/variables?per_page=100", &payload); err != nil {
		return nil, err
	}

	out := make([]Variable, 0, len(payload.Variables))
	for _, v := range payload.Variables {
		ts, _ := time.Parse(time.RFC3339, v.UpdatedAt)
		out = append(out, Variable{Name: v.Name, Value: v.Value, UpdatedAt: ts})
	}
	return out, nil
}

// PutVariable crée ou met à jour une variable du dépôt.
//
// L'API distingue création (POST) et mise à jour (PATCH) : on tente la
// création, et on bascule si elle existe déjà.
func (c *Client) PutVariable(ctx context.Context, fullName, name, value string) error {
	token, apiURL := c.credentials(ctx)
	if token == "" {
		return ErrNotConfigured
	}

	base := apiURL + "/repos/" + fullName + "/actions/variables"
	body := map[string]any{"name": name, "value": value}

	err := c.sendJSON(ctx, http.MethodPost, base, body, nil)
	if err == nil {
		return nil
	}
	// Déjà présente : l'API refuse la création, la mise à jour porte le nom
	// dans l'URL et non dans le corps.
	return c.sendJSON(ctx, http.MethodPatch, base+"/"+name,
		map[string]any{"name": name, "value": value}, nil)
}

// DeleteVariable retire une variable du dépôt.
func (c *Client) DeleteVariable(ctx context.Context, fullName, name string) error {
	return c.sendJSON(ctx, http.MethodDelete,
		c.apiBase(ctx)+"/repos/"+fullName+"/actions/variables/"+name, nil, nil)
}

// DeleteSecret retire un secret du dépôt.
func (c *Client) DeleteSecret(ctx context.Context, fullName, name string) error {
	return c.sendJSON(ctx, http.MethodDelete,
		c.apiBase(ctx)+"/repos/"+fullName+"/actions/secrets/"+name, nil, nil)
}

// apiBase retourne l'URL de l'API pour la requête courante.
func (c *Client) apiBase(ctx context.Context) string {
	_, apiURL := c.credentials(ctx)
	return apiURL
}

func (c *Client) ListSecrets(ctx context.Context, fullName string) ([]Secret, error) {
	var payload struct {
		Secrets []struct {
			Name      string `json:"name"`
			UpdatedAt string `json:"updated_at"`
		} `json:"secrets"`
	}
	if err := c.get(ctx, "/repos/"+fullName+"/actions/secrets?per_page=100", &payload); err != nil {
		return nil, err
	}

	out := make([]Secret, 0, len(payload.Secrets))
	for _, s := range payload.Secrets {
		// Une date illisible ne justifie pas de perdre le nom : c'est lui qui
		// porte l'information utile.
		ts, _ := time.Parse(time.RFC3339, s.UpdatedAt)
		out = append(out, Secret{Name: s.Name, UpdatedAt: ts})
	}
	return out, nil
}

// PutSecret dépose un secret au niveau du dépôt.
//
// Il est alors visible par tous les workflows, quel que soit l'environnement
// visé : réservé à ce qui est réellement commun, comme un jeton de registre.
func (c *Client) PutSecret(ctx context.Context, fullName, name, value string) error {
	return c.putSecretIn(ctx, "/repos/"+fullName+"/actions", name, value)
}

// PutEnvSecret dépose un secret dans un environnement du dépôt.
//
// C'est le cloisonnement qu'attend un déploiement : le secret de production
// n'est pas lisible par un workflow visant la recette. L'environnement est
// créé s'il n'existe pas — sinon la première écriture échouerait sur un
// environnement que personne n'a pensé à déclarer.
func (c *Client) PutEnvSecret(ctx context.Context, fullName, env, name, value string) error {
	if err := c.EnsureEnvironment(ctx, fullName, env); err != nil {
		return err
	}
	return c.putSecretIn(ctx,
		"/repos/"+fullName+"/environments/"+url.PathEscape(env), name, value)
}

// EnsureEnvironment crée l'environnement s'il n'existe pas.
//
// L'appel est idempotent côté GitHub : recréer un environnement existant ne
// perd ni ses secrets ni ses règles de protection.
func (c *Client) EnsureEnvironment(ctx context.Context, fullName, env string) error {
	return c.sendJSON(ctx, http.MethodPut,
		c.apiBase(ctx)+"/repos/"+fullName+"/environments/"+url.PathEscape(env),
		map[string]any{}, nil)
}

// DeleteEnvironment supprime un environnement et tout ce qu'il contient.
//
// GitHub emporte ses secrets et ses variables : l'opération est définitive, et
// les valeurs ne sont récupérables nulle part.
func (c *Client) DeleteEnvironment(ctx context.Context, fullName, env string) error {
	return c.sendJSON(ctx, http.MethodDelete,
		c.apiBase(ctx)+"/repos/"+fullName+"/environments/"+url.PathEscape(env),
		nil, nil)
}

// ListEnvironments retourne les environnements déclarés sur le dépôt.
func (c *Client) ListEnvironments(ctx context.Context, fullName string) ([]string, error) {
	var payload struct {
		Environments []struct {
			Name string `json:"name"`
		} `json:"environments"`
	}
	if err := c.get(ctx, "/repos/"+fullName+"/environments", &payload); err != nil {
		return nil, err
	}
	out := make([]string, 0, len(payload.Environments))
	for _, e := range payload.Environments {
		out = append(out, e.Name)
	}
	return out, nil
}

// ListEnvSecrets retourne les noms des secrets d'un environnement.
func (c *Client) ListEnvSecrets(ctx context.Context, fullName, env string) ([]Secret, error) {
	var payload struct {
		Secrets []struct {
			Name      string `json:"name"`
			UpdatedAt string `json:"updated_at"`
		} `json:"secrets"`
	}
	if err := c.get(ctx, "/repos/"+fullName+"/environments/"+url.PathEscape(env)+
		"/secrets?per_page=100", &payload); err != nil {
		return nil, err
	}
	out := make([]Secret, 0, len(payload.Secrets))
	for _, s := range payload.Secrets {
		ts, _ := time.Parse(time.RFC3339, s.UpdatedAt)
		out = append(out, Secret{Name: s.Name, UpdatedAt: ts})
	}
	return out, nil
}

// ListEnvVariables retourne les variables d'un environnement, valeurs comprises.
func (c *Client) ListEnvVariables(ctx context.Context, fullName, env string) ([]Variable, error) {
	var payload struct {
		Variables []struct {
			Name      string `json:"name"`
			Value     string `json:"value"`
			UpdatedAt string `json:"updated_at"`
		} `json:"variables"`
	}
	if err := c.get(ctx, "/repos/"+fullName+"/environments/"+url.PathEscape(env)+
		"/variables?per_page=100", &payload); err != nil {
		return nil, err
	}
	out := make([]Variable, 0, len(payload.Variables))
	for _, v := range payload.Variables {
		ts, _ := time.Parse(time.RFC3339, v.UpdatedAt)
		out = append(out, Variable{Name: v.Name, Value: v.Value, UpdatedAt: ts})
	}
	return out, nil
}

// PutEnvVariable crée ou met à jour une variable d'environnement.
func (c *Client) PutEnvVariable(ctx context.Context, fullName, env, name, value string) error {
	if err := c.EnsureEnvironment(ctx, fullName, env); err != nil {
		return err
	}
	base := c.apiBase(ctx) + "/repos/" + fullName + "/environments/" +
		url.PathEscape(env) + "/variables"
	body := map[string]any{"name": name, "value": value}

	if err := c.sendJSON(ctx, http.MethodPost, base, body, nil); err == nil {
		return nil
	}
	return c.sendJSON(ctx, http.MethodPatch, base+"/"+name, body, nil)
}

// DeleteEnvSecret retire un secret d'un environnement.
func (c *Client) DeleteEnvSecret(ctx context.Context, fullName, env, name string) error {
	return c.sendJSON(ctx, http.MethodDelete, c.apiBase(ctx)+"/repos/"+fullName+
		"/environments/"+url.PathEscape(env)+"/secrets/"+name, nil, nil)
}

// DeleteEnvVariable retire une variable d'un environnement.
func (c *Client) DeleteEnvVariable(ctx context.Context, fullName, env, name string) error {
	return c.sendJSON(ctx, http.MethodDelete, c.apiBase(ctx)+"/repos/"+fullName+
		"/environments/"+url.PathEscape(env)+"/variables/"+name, nil, nil)
}

// putSecretIn chiffre puis dépose un secret sous le chemin donné.
//
// Le chiffrement est le même pour un dépôt et pour un environnement : seule la
// clé publique diffère, et elle vient du chemin.
func (c *Client) putSecretIn(ctx context.Context, scope, name, value string) error {
	token, apiURL := c.credentials(ctx)
	if token == "" {
		return ErrNotConfigured
	}

	var key struct {
		KeyID string `json:"key_id"`
		Key   string `json:"key"`
	}
	if err := c.get(ctx, scope+"/secrets/public-key", &key); err != nil {
		return fmt.Errorf("clé publique : %w", err)
	}

	pub, err := base64.StdEncoding.DecodeString(key.Key)
	if err != nil {
		return err
	}
	if len(pub) != 32 {
		return fmt.Errorf("clé publique inattendue")
	}
	var pubKey [32]byte
	copy(pubKey[:], pub)

	sealed, err := box.SealAnonymous(nil, []byte(value), &pubKey, rand.Reader)
	if err != nil {
		return fmt.Errorf("chiffrement du secret : %w", err)
	}

	body, err := json.Marshal(map[string]string{
		"encrypted_value": base64.StdEncoding.EncodeToString(sealed),
		"key_id":          key.KeyID,
	})
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPut,
		apiURL+scope+"/secrets/"+name, strings.NewReader(string(body)))
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("Content-Type", "application/json")
	c.auth(req, token)

	res, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("dépôt du secret : %w", err)
	}
	defer res.Body.Close()

	if res.StatusCode >= 400 {
		detail := apiMessage(res.Body)
		if res.StatusCode == http.StatusUnauthorized || res.StatusCode == http.StatusForbidden ||
			res.StatusCode == http.StatusNotFound {
			return fmt.Errorf(
				"secret refusé : le jeton doit avoir « Secrets: write » (fine-grained) ou la portée « repo ». %s",
				detail)
		}
		return fmt.Errorf("dépôt du secret refusé (statut %d) : %s", res.StatusCode, detail)
	}
	return nil
}

// DeleteRepo supprime un dépôt.
//
// Irréversible côté GitHub : l'appelant doit avoir obtenu un accord explicite.
// La portée requise (`delete_repo`, ou « Administration: write ») est distincte
// de celle qui autorise la création.
func (c *Client) DeleteRepo(ctx context.Context, fullName string) error {
	token, apiURL := c.credentials(ctx)
	if token == "" {
		return ErrNotConfigured
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodDelete,
		apiURL+"/repos/"+fullName, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	c.auth(req, token)

	res, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("suppression du dépôt : %w", err)
	}
	defer res.Body.Close()

	if res.StatusCode >= 400 {
		detail := apiMessage(res.Body)
		switch res.StatusCode {
		case http.StatusForbidden, http.StatusUnauthorized:
			return fmt.Errorf(
				"suppression refusée : le jeton doit avoir la portée « delete_repo » (classique) ou « Administration: write » (fine-grained). %s",
				detail)
		case http.StatusNotFound:
			// Déjà supprimé, ou invisible pour ce jeton : dans les deux cas,
			// l'objectif est atteint.
			return nil
		default:
			return fmt.Errorf("suppression refusée (statut %d) : %s", res.StatusCode, detail)
		}
	}
	return nil
}

// GetRepo valide qu'un dépôt existe et est accessible avec le jeton.
func (c *Client) GetRepo(ctx context.Context, fullName string) (*Repo, error) {
	var out Repo
	if err := c.get(ctx, "/repos/"+fullName, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ListDocs retourne les fichiers Markdown à la racine du dépôt.
//
// La documentation vit majoritairement à la racine (README, CONTRIBUTING…) ;
// parcourir toute l'arborescence multiplierait les appels pour peu de gain.
func (c *Client) ListDocs(ctx context.Context, fullName string) ([]Doc, error) {
	var entries []struct {
		Name string `json:"name"`
		Path string `json:"path"`
		Type string `json:"type"`
		Size int    `json:"size"`
	}
	if err := c.get(ctx, "/repos/"+fullName+"/contents", &entries); err != nil {
		return nil, err
	}

	out := []Doc{}
	for _, e := range entries {
		if e.Type != "file" || !strings.HasSuffix(strings.ToLower(e.Name), ".md") {
			continue
		}
		out = append(out, Doc{Path: e.Path, Name: e.Name, Size: e.Size})
	}
	return out, nil
}

// GetDoc lit un fichier Markdown et le rend en HTML.
//
// Le rendu est délégué à GitHub : il gère les extensions GFM (tableaux, listes
// de tâches, alertes) qu'un moteur générique rendrait différemment.
func (c *Client) GetDoc(ctx context.Context, fullName, path string) (*Doc, error) {
	raw, err := c.raw(ctx, "/repos/"+fullName+"/contents/"+path)
	if err != nil {
		return nil, err
	}

	html, err := c.renderMarkdown(ctx, string(raw), fullName)
	if err != nil {
		// Le rendu échoue : le texte brut reste préférable à une page vide.
		html = ""
	}

	name := path
	if i := strings.LastIndex(path, "/"); i >= 0 {
		name = path[i+1:]
	}
	return &Doc{Path: path, Name: name, Size: len(raw), HTML: html}, nil
}

// ListRuns retourne les dernières exécutions de pipeline.
func (c *Client) ListRuns(ctx context.Context, fullName string, limit int) ([]Run, error) {
	if limit <= 0 || limit > 50 {
		limit = 20
	}

	var body struct {
		Runs []struct {
			ID         int64     `json:"id"`
			Name       string    `json:"name"`
			Status     string    `json:"status"`
			Conclusion string    `json:"conclusion"`
			Branch     string    `json:"head_branch"`
			SHA        string    `json:"head_sha"`
			HTMLURL    string    `json:"html_url"`
			RunStarted time.Time `json:"run_started_at"`
			UpdatedAt  time.Time `json:"updated_at"`
			Actor      struct {
				Login string `json:"login"`
			} `json:"actor"`
			HeadCommit struct {
				Message string `json:"message"`
			} `json:"head_commit"`
		} `json:"workflow_runs"`
	}
	endpoint := fmt.Sprintf("/repos/%s/actions/runs?per_page=%d", fullName, limit)
	if err := c.get(ctx, endpoint, &body); err != nil {
		return nil, err
	}

	out := make([]Run, 0, len(body.Runs))
	for _, r := range body.Runs {
		msg := r.HeadCommit.Message
		// Seule la première ligne du message tient dans un tableau.
		if i := strings.IndexByte(msg, '\n'); i >= 0 {
			msg = msg[:i]
		}
		out = append(out, Run{
			ID:         r.ID,
			Name:       r.Name,
			Status:     r.Status,
			Conclusion: r.Conclusion,
			Branch:     r.Branch,
			Commit:     r.SHA,
			Message:    msg,
			Actor:      r.Actor.Login,
			HTMLURL:    r.HTMLURL,
			StartedAt:  r.RunStarted,
			UpdatedAt:  r.UpdatedAt,
		})
	}
	return out, nil
}

// ---------------------------------------------------------------------------

func (c *Client) renderMarkdown(ctx context.Context, text, context_ string) (string, error) {
	payload, err := json.Marshal(map[string]string{
		"text":    text,
		"mode":    "gfm",
		"context": context_,
	})
	if err != nil {
		return "", err
	}

	token, apiURL := c.credentials(ctx)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, apiURL+"/markdown",
		strings.NewReader(string(payload)))
	if err != nil {
		return "", err
	}
	c.auth(req, token)

	res, err := c.http.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("rendu Markdown refusé (%d)", res.StatusCode)
	}

	html, err := io.ReadAll(io.LimitReader(res.Body, 2<<20))
	return string(html), err
}

func (c *Client) get(ctx context.Context, endpoint string, out any) error {
	res, err := c.do(ctx, endpoint, "application/vnd.github+json")
	if err != nil {
		return err
	}
	defer res.Body.Close()
	return json.NewDecoder(io.LimitReader(res.Body, 4<<20)).Decode(out)
}

// raw récupère le contenu brut d'un fichier, sans encodage base64.
func (c *Client) raw(ctx context.Context, endpoint string) ([]byte, error) {
	res, err := c.do(ctx, endpoint, "application/vnd.github.raw")
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	return io.ReadAll(io.LimitReader(res.Body, 2<<20))
}

func (c *Client) do(ctx context.Context, endpoint, accept string) (*http.Response, error) {
	token, apiURL := c.credentials(ctx)
	if token == "" {
		return nil, ErrNotConfigured
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, apiURL+endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", accept)
	c.auth(req, token)

	res, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("appel à l'API Git : %w", err)
	}

	if res.StatusCode >= 400 {
		res.Body.Close()
		switch res.StatusCode {
		case http.StatusNotFound:
			return nil, fmt.Errorf("dépôt ou fichier introuvable")
		case http.StatusUnauthorized, http.StatusForbidden:
			// Le rate limit se manifeste aussi par un 403 : le distinguer
			// évite de faire chercher un problème de jeton inexistant.
			if res.Header.Get("X-RateLimit-Remaining") == "0" {
				return nil, fmt.Errorf("quota d'appels à l'API Git épuisé")
			}
			return nil, fmt.Errorf("jeton Git refusé ou droits insuffisants")
		default:
			return nil, fmt.Errorf("API Git : statut %d", res.StatusCode)
		}
	}
	return res, nil
}

func (c *Client) auth(req *http.Request, token string) {
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
}
