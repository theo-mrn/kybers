package api

import (
	"bufio"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/kybers/kybers/control-plane/internal/models"
)

// routePattern capture le motif passé au routeur : « GET /api/v1/apps ».
var routePattern = regexp.MustCompile(`mux\.(?:Handle|HandleFunc)\("([A-Z]+ [^"]+)"`)

// declaredRoutes lit les routes réellement enregistrées.
//
// La source est le fichier plutôt que le routeur : net/http n'expose pas sa
// table, et l'analyser à l'exécution demanderait de démarrer le serveur avec
// ses dépendances.
func declaredRoutes(t *testing.T) []string {
	t.Helper()

	f, err := os.Open(filepath.Join(".", "api.go"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	out := []string{}
	scan := bufio.NewScanner(f)
	scan.Buffer(make([]byte, 1<<20), 1<<20)
	for scan.Scan() {
		if m := routePattern.FindStringSubmatch(scan.Text()); m != nil {
			out = append(out, m[1])
		}
	}
	if err := scan.Err(); err != nil {
		t.Fatal(err)
	}
	if len(out) == 0 {
		t.Fatal("aucune route détectée : le motif de lecture a dû changer")
	}
	return out
}

// Ce qui n'a pas vocation à figurer dans la spécification : sondes, scripts
// d'installation, et la spec elle-même.
var undocumented = map[string]bool{
	"GET /healthz":                 true,
	"GET /install.sh":              true,
	"GET /api/v1/openapi.json":     true,
	"GET /api/v1/agent/install.sh": true,
}

// Toute route documentée doit exister : une description qui survit à la
// suppression de sa route décrit un contrat qu'on ne peut plus honorer.
func TestDocumentedRoutesExist(t *testing.T) {
	declared := map[string]bool{}
	for _, r := range declaredRoutes(t) {
		declared[r] = true
	}

	for pattern := range operations {
		if !declared[pattern] {
			t.Errorf("%s est documentée mais n'existe plus dans le routeur", pattern)
		}
	}
}

// Chaque route documentée porte de quoi être comprise.
func TestOperationsAreDescribed(t *testing.T) {
	for pattern, op := range operations {
		if strings.TrimSpace(op.Summary) == "" {
			t.Errorf("%s : résumé vide", pattern)
		}
		if strings.TrimSpace(op.Tag) == "" {
			t.Errorf("%s : sans domaine, la route n'apparaîtra nulle part", pattern)
		}
		if op.List && op.Returns == nil {
			t.Errorf("%s : annoncée comme liste sans modèle de retour", pattern)
		}
	}
}

// La spécification produite doit être exploitable par un générateur de client.
func TestBuildOpenAPI(t *testing.T) {
	schemas := map[string]any{}
	for name, model := range exposedModels {
		schemas[name] = schemaOf(model)
	}
	spec := buildOpenAPI("https://kybers.example", schemas)

	if spec.OpenAPI != "3.1.0" {
		t.Errorf("version = %q", spec.OpenAPI)
	}
	if len(spec.Paths) == 0 {
		t.Fatal("aucun chemin produit")
	}

	// Un paramètre de chemin non déclaré rend la route inutilisable.
	app, ok := spec.Paths["/api/v1/apps/{id}"].(map[string]any)
	if !ok {
		t.Fatal("/api/v1/apps/{id} absent")
	}
	get, ok := app["get"].(map[string]any)
	if !ok {
		t.Fatal("GET absent sur /api/v1/apps/{id}")
	}
	params, ok := get["parameters"].([]any)
	if !ok || len(params) != 1 {
		t.Fatalf("paramètres = %v, attendu le seul {id}", get["parameters"])
	}
	if name := params[0].(map[string]any)["name"]; name != "id" {
		t.Errorf("paramètre = %v, attendu id", name)
	}

	// Une route protégée doit annoncer sa sécurité, sinon un client tentera
	// l'appel sans jeton.
	if _, ok := get["security"]; !ok {
		t.Error("route protégée sans exigence de sécurité")
	}
}

// Le schéma d'un modèle suit ses balises JSON : c'est ce qui évite à la
// documentation de mentir quand un champ est ajouté.
func TestSchemaOfFollowsJSONTags(t *testing.T) {
	schema := schemaOf(models.App{})

	props, ok := schema["properties"].(map[string]any)
	if !ok {
		t.Fatal("propriétés absentes")
	}
	for _, field := range []string{"id", "name", "git_repo", "container_port"} {
		if _, ok := props[field]; !ok {
			t.Errorf("%s absent du schéma", field)
		}
	}

	// Les types doivent être traduits, pas repris tels quels.
	if got := props["container_port"].(map[string]any)["type"]; got != "integer" {
		t.Errorf("container_port = %v, attendu integer", got)
	}
	if got := props["name"].(map[string]any)["type"]; got != "string" {
		t.Errorf("name = %v, attendu string", got)
	}

	// Un champ `omitempty` est facultatif : l'exiger ferait échouer une
	// validation sur une réponse pourtant correcte.
	required, _ := schema["required"].([]string)
	for _, r := range required {
		if r == "ports" {
			t.Error("ports est omitempty : il ne doit pas être requis")
		}
	}
}

// time.Time se sérialise en chaîne ISO 8601 : le décrire comme un objet
// casserait tout client généré.
func TestSchemaOfHandlesTime(t *testing.T) {
	props := schemaOf(models.Deployment{})["properties"].(map[string]any)

	created, ok := props["created_at"].(map[string]any)
	if !ok {
		t.Fatal("created_at absent")
	}
	if created["type"] != "string" || created["format"] != "date-time" {
		t.Errorf("created_at = %v, attendu string/date-time", created)
	}
}

// Les routes non documentées sont signalées, sans faire échouer le test : la
// documentation se complète au fil de l'eau, mais l'écart doit rester visible.
func TestUndocumentedRoutesAreReported(t *testing.T) {
	missing := []string{}
	for _, r := range declaredRoutes(t) {
		if !undocumented[r] && operations[r].Summary == "" {
			missing = append(missing, r)
		}
	}

	if len(missing) > 0 {
		t.Logf("%d route(s) sans documentation :", len(missing))
		for _, r := range missing {
			t.Logf("  %s", r)
		}
	}
}
