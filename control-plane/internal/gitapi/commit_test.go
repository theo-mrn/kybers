package gitapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Vérifie qu'une écriture groupée produit un seul commit, et que l'arbre
// reprend celui du parent pour ne pas effacer les fichiers existants.
func TestPutFilesUnSeulCommit(t *testing.T) {
	var blobs, trees, commits, refs int
	var treeBody map[string]any

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == "GET" && r.URL.Path == "/repos/acme/api":
			json.NewEncoder(w).Encode(map[string]any{"default_branch": "main"})
		case r.Method == "GET" && r.URL.Path == "/repos/acme/api/git/ref/heads/main":
			json.NewEncoder(w).Encode(map[string]any{
				"object": map[string]string{"sha": "PARENT"},
			})
		case r.Method == "GET" && r.URL.Path == "/repos/acme/api/git/commits/PARENT":
			json.NewEncoder(w).Encode(map[string]any{
				"tree": map[string]string{"sha": "BASETREE"},
			})
		case r.Method == "POST" && r.URL.Path == "/repos/acme/api/git/blobs":
			blobs++
			json.NewEncoder(w).Encode(map[string]string{"sha": "BLOB"})
		case r.Method == "POST" && r.URL.Path == "/repos/acme/api/git/trees":
			trees++
			body, _ := io.ReadAll(r.Body)
			json.Unmarshal(body, &treeBody)
			json.NewEncoder(w).Encode(map[string]string{"sha": "TREE"})
		case r.Method == "POST" && r.URL.Path == "/repos/acme/api/git/commits":
			commits++
			json.NewEncoder(w).Encode(map[string]string{"sha": "COMMIT"})
		case r.Method == "PATCH" && r.URL.Path == "/repos/acme/api/git/refs/heads/main":
			refs++
			json.NewEncoder(w).Encode(map[string]string{"sha": "COMMIT"})
		default:
			t.Errorf("appel inattendu : %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	c := New("tok", srv.URL)

	files := []File{
		{Path: "package.json", Content: "{}"},
		{Path: "server.js", Content: "x"},
		{Path: ".github/workflows/deploy.yml", Content: "y"},
		{Path: "/Dockerfile", Content: "FROM node"}, // slash initial à normaliser
		{Path: "  ", Content: "ignoré"},             // vide : écarté
	}
	if err := c.PutFiles(context.Background(), "acme/api", files, "chore: init"); err != nil {
		t.Fatal(err)
	}

	if blobs != 4 {
		t.Errorf("blobs = %d, attendu 4 (le chemin vide est écarté)", blobs)
	}
	if trees != 1 || commits != 1 || refs != 1 {
		t.Errorf("arbres=%d commits=%d refs=%d, attendu 1 chacun", trees, commits, refs)
	}
	if treeBody["base_tree"] != "BASETREE" {
		t.Errorf("base_tree = %v : les fichiers existants seraient effacés", treeBody["base_tree"])
	}

	entries, _ := treeBody["tree"].([]any)
	if len(entries) != 4 {
		t.Fatalf("entrées = %d, attendu 4", len(entries))
	}
	for _, e := range entries {
		m := e.(map[string]any)
		if strings.HasPrefix(m["path"].(string), "/") {
			t.Errorf("chemin non normalisé : %v", m["path"])
		}
	}
}

// Un dépôt vierge n'a ni ref ni commit parent : l'arbre part de rien et la
// référence est créée.
func TestPutFilesDepotVierge(t *testing.T) {
	var created bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/repos/acme/api":
			json.NewEncoder(w).Encode(map[string]any{"default_branch": "main"})
		case strings.Contains(r.URL.Path, "/git/ref/heads/main"):
			w.WriteHeader(404)
		case strings.HasSuffix(r.URL.Path, "/git/blobs"):
			json.NewEncoder(w).Encode(map[string]string{"sha": "BLOB"})
		case strings.HasSuffix(r.URL.Path, "/git/trees"):
			body, _ := io.ReadAll(r.Body)
			var m map[string]any
			json.Unmarshal(body, &m)
			if _, ok := m["base_tree"]; ok {
				t.Error("base_tree envoyé alors qu'aucun commit n'existe")
			}
			json.NewEncoder(w).Encode(map[string]string{"sha": "TREE"})
		case strings.HasSuffix(r.URL.Path, "/git/commits"):
			body, _ := io.ReadAll(r.Body)
			if strings.Contains(string(body), "parents") {
				t.Error("parents envoyé sur un dépôt vierge")
			}
			json.NewEncoder(w).Encode(map[string]string{"sha": "COMMIT"})
		case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/git/refs"):
			created = true
			json.NewEncoder(w).Encode(map[string]string{"sha": "COMMIT"})
		default:
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	c := New("tok", srv.URL)
	if err := c.PutFiles(context.Background(), "acme/api",
		[]File{{Path: "README.md", Content: "#"}}, "chore: init"); err != nil {
		t.Fatal(err)
	}
	if !created {
		t.Error("la référence n'a pas été créée")
	}
}

func TestPutFilesSansFichier(t *testing.T) {
	c := New("tok", "http://x")
	if err := c.PutFiles(context.Background(), "acme/api", nil, "m"); err != nil {
		t.Errorf("aucun fichier ne doit pas être une erreur : %v", err)
	}
}
