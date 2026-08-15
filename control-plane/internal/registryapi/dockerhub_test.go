package registryapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestIsDockerHub(t *testing.T) {
	// Docker Hub s'écrit de nombreuses façons selon l'outil qui a produit la
	// valeur (docker login, config.json, saisie manuelle).
	hub := []string{
		"", "docker.io", "DOCKER.IO", "index.docker.io",
		"https://index.docker.io/v1/", "registry-1.docker.io", "hub.docker.com",
	}
	for _, s := range hub {
		if !IsDockerHub(s) {
			t.Errorf("IsDockerHub(%q) = false, attendu true", s)
		}
	}

	autres := []string{"ghcr.io", "quay.io", "registry.gitlab.com", "10.0.0.1:5000"}
	for _, s := range autres {
		if IsDockerHub(s) {
			t.Errorf("IsDockerHub(%q) = true, attendu false", s)
		}
	}
}

// testClient renvoie un client pointant sur un serveur simulé.
func testClient(h http.HandlerFunc) (*Client, func()) {
	srv := httptest.NewServer(h)
	return &Client{http: srv.Client(), baseURL: srv.URL}, srv.Close
}

func TestLogin(t *testing.T) {
	c, done := testClient(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["password"] != "bon" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"token": "jwt-123"})
	})
	defer done()

	token, err := c.Login(context.Background(), "moi", "bon")
	if err != nil {
		t.Fatal(err)
	}
	if token != "jwt-123" {
		t.Errorf("token = %q", token)
	}

	if _, err := c.Login(context.Background(), "moi", "mauvais"); err == nil {
		t.Error("un mot de passe invalide doit produire une erreur")
	}
}

func TestListRepositoriesTransmetLeJeton(t *testing.T) {
	var gotAuth string
	c, done := testClient(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"results": []map[string]any{
				{"name": "mon-app", "namespace": "org", "is_private": true, "pull_count": 42},
				{"name": "site", "namespace": "org", "is_private": false},
			},
		})
	})
	defer done()

	repos, err := c.ListRepositories(context.Background(), "org", "jwt-123")
	if err != nil {
		t.Fatal(err)
	}
	// Sans le jeton, les dépôts privés seraient absents de la réponse.
	if gotAuth != "JWT jwt-123" {
		t.Errorf("Authorization = %q", gotAuth)
	}
	if len(repos) != 2 {
		t.Fatalf("%d dépôts, attendu 2", len(repos))
	}
	if repos[0].Name != "org/mon-app" {
		t.Errorf("name = %q, attendu org/mon-app", repos[0].Name)
	}
	if !repos[0].Private {
		t.Error("le premier dépôt devait être marqué privé")
	}
}

func TestListTagsConstruitLaReference(t *testing.T) {
	c, done := testClient(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"results": []map[string]any{{"name": "v1", "full_size": 1234}},
		})
	})
	defer done()

	// Dépôt d'un compte : la référence garde le namespace.
	tags, err := c.ListTags(context.Background(), "org/mon-app", "")
	if err != nil {
		t.Fatal(err)
	}
	if tags[0].Image != "org/mon-app:v1" {
		t.Errorf("image = %q, attendu org/mon-app:v1", tags[0].Image)
	}

	// Image officielle : "library/" ne doit jamais apparaître dans la
	// référence, sous peine d'un pull invalide.
	for _, in := range []string{"nginx", "library/nginx"} {
		tags, err = c.ListTags(context.Background(), in, "")
		if err != nil {
			t.Fatal(err)
		}
		if tags[0].Image != "nginx:v1" {
			t.Errorf("ListTags(%q) → image = %q, attendu nginx:v1", in, tags[0].Image)
		}
	}
}

// Tous les dépôts ne publient pas « latest » : proposer ce tag par défaut
// produirait un ImagePullBackOff.
func TestPickDefaultTag(t *testing.T) {
	recent := time.Now()
	vieux := recent.Add(-72 * time.Hour)

	cases := []struct {
		nom  string
		tags []Tag
		want string
	}{
		{
			"latest est prioritaire",
			[]Tag{{Name: "v1", LastUpdated: recent}, {Name: "latest", LastUpdated: vieux}},
			"latest",
		},
		{
			"sinon le tag nommé le plus récent",
			[]Tag{{Name: "v1", LastUpdated: vieux}, {Name: "demo", LastUpdated: recent}},
			"demo",
		},
		{
			"les hashs de commit sont ignorés",
			[]Tag{
				{Name: "2f80fb2306e3a12b4546863a44fe2cbc6e2291bf", LastUpdated: recent},
				{Name: "stag", LastUpdated: vieux},
			},
			"stag",
		},
		{
			"les tags sha- sont ignorés",
			[]Tag{{Name: "sha-44d54d2", LastUpdated: recent}, {Name: "v2", LastUpdated: vieux}},
			"v2",
		},
		{
			"repli sur le premier si tout est hash",
			[]Tag{{Name: "abc1234", LastUpdated: recent}, {Name: "def5678", LastUpdated: vieux}},
			"abc1234",
		},
	}

	for _, c := range cases {
		if got := pickDefaultTag(c.tags); got != c.want {
			t.Errorf("%s: pickDefaultTag = %q, attendu %q", c.nom, got, c.want)
		}
	}
}

func TestIsHashTag(t *testing.T) {
	hashs := []string{
		"sha256-abc", "sha-44d54d2", "2f80fb2306e3a12b4546863a44fe2cbc6e2291bf", "abc1234",
	}
	for _, h := range hashs {
		if !isHashTag(h) {
			t.Errorf("isHashTag(%q) = false, attendu true", h)
		}
	}

	nommes := []string{"latest", "stag", "demo", "v1.2.3", "alpine", "1.27"}
	for _, n := range nommes {
		if isHashTag(n) {
			t.Errorf("isHashTag(%q) = true, attendu false", n)
		}
	}
}

func TestErreursHTTP(t *testing.T) {
	c, done := testClient(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	})
	defer done()

	if _, err := c.ListRepositories(context.Background(), "inconnu", ""); err == nil {
		t.Error("un 404 doit produire une erreur")
	}
	if _, err := c.ListRepositories(context.Background(), "", ""); err == nil {
		t.Error("un compte vide doit être rejeté")
	}
}
