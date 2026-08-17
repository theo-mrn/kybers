package api

import (
	"reflect"
	"sort"
	"strings"

	"github.com/kybers/kybers/control-plane/internal/models"
)

// Spécification OpenAPI de l'API HTTP.
//
// Elle est construite ici plutôt qu'écrite à la main : les chemins viennent de
// la table de routage réelle, les schémas de la réflexion sur les modèles. Une
// spec maintenue à part diverge du code en quelques semaines — celle-ci ne
// peut décrire que ce qui existe.
//
// Ce qui reste manuel, c'est la description de chaque route : ce qu'elle fait
// et pourquoi, qu'aucune signature ne dira. Un test compare les routes
// déclarées à celles documentées et échoue sur l'écart, pour qu'ajouter un
// endpoint sans le décrire se voie.

// operation décrit ce qu'une route fait, en complément de ce que le routeur
// en révèle.
type operation struct {
	Summary string
	// Domaine fonctionnel : regroupe les routes dans la documentation.
	Tag string
	// Modèle retourné en cas de succès ; nil quand la réponse est vide.
	Returns any
	// Vrai si la réponse est un tableau du modèle.
	List bool
	// Corps attendu, décrit à la main : les handlers utilisent des structs
	// anonymes, dont la réflexion ne tire aucun nom exploitable.
	Body map[string]string
	// Portée requise ; vide pour une route publique.
	Permission string
}

// operations associe chaque route à sa description.
//
// La clé reprend exactement le motif passé au routeur, pour que la
// correspondance soit vérifiable mécaniquement.
var operations = map[string]operation{
	// --- Authentification ---------------------------------------------------
	"GET /api/v1/auth/bootstrap": {
		Summary: "Indique si l'instance attend la création du premier compte.",
		Tag:     "Authentification",
	},
	"POST /api/v1/auth/register": {
		Summary: "Crée le premier compte administrateur de l'instance.",
		Tag:     "Authentification",
		Body:    map[string]string{"email": "string", "password": "string", "name": "string"},
	},
	"POST /api/v1/auth/login": {
		Summary: "Ouvre une session et retourne un jeton.",
		Tag:     "Authentification",
		Body:    map[string]string{"email": "string", "password": "string"},
	},
	"POST /api/v1/auth/logout": {
		Summary: "Ferme la session courante.",
		Tag:     "Authentification",
	},
	"GET /api/v1/auth/me": {
		Summary: "Retourne l'utilisateur authentifié.",
		Tag:     "Authentification",
		Returns: models.User{},
	},
	"POST /api/v1/auth/password": {
		Summary: "Change le mot de passe de l'utilisateur courant.",
		Tag:     "Authentification",
		Body:    map[string]string{"current": "string", "new": "string"},
	},

	// --- Applications -------------------------------------------------------
	"GET /api/v1/apps": {
		Summary:    "Liste les applications de l'organisation.",
		Tag:        "Applications",
		Returns:    models.App{},
		List:       true,
		Permission: "app:read",
	},
	"POST /api/v1/apps": {
		Summary:    "Crée une application.",
		Tag:        "Applications",
		Returns:    models.App{},
		Body:       map[string]string{"name": "string", "git_repo": "string", "container_port": "integer"},
		Permission: "app:create",
	},
	"GET /api/v1/apps/{id}": {
		Summary:    "Retourne une application.",
		Tag:        "Applications",
		Returns:    models.App{},
		Permission: "app:read",
	},
	"DELETE /api/v1/apps/{id}": {
		Summary:    "Supprime une application. `?cascade=true` retire aussi ses déploiements, `?delete_repo=true` son dépôt Git.",
		Tag:        "Applications",
		Permission: "app:delete",
	},

	// --- Déploiements -------------------------------------------------------
	"GET /api/v1/deployments": {
		Summary:    "Liste les déploiements de l'organisation.",
		Tag:        "Déploiements",
		Returns:    models.Deployment{},
		List:       true,
		Permission: "app:read",
	},
	"POST /api/v1/apps/{id}/deploy": {
		Summary: "Déploie une image dans un environnement. Appelé par le CI après publication de l'image.",
		Tag:     "Déploiements",
		Returns: models.Deployment{},
		Body: map[string]string{
			"environment": "string", "image": "string", "replicas": "integer",
			"git_commit": "string", "git_ref": "string", "source": "string",
		},
		Permission: "app:deploy",
	}, // --- Cycle de vie d'un déploiement --------------------------------------
	"GET /api/v1/apps/{id}/deployments": {
		Summary:    "Liste les déploiements d'une application, tous environnements confondus.",
		Tag:        "Déploiements",
		Returns:    models.Deployment{},
		List:       true,
		Permission: "app:read",
	},
	"GET /api/v1/deployments/{id}": {
		Summary:    "Retourne un déploiement.",
		Tag:        "Déploiements",
		Returns:    models.Deployment{},
		Permission: "app:read",
	},
	"POST /api/v1/deployments/{id}/scale": {
		Summary:    "Change le nombre de répliques.",
		Tag:        "Déploiements",
		Body:       map[string]string{"replicas": "integer"},
		Permission: "app:deploy",
	},
	"POST /api/v1/deployments/{id}/stop": {
		Summary:    "Arrête le déploiement sans le supprimer : les répliques tombent à zéro.",
		Tag:        "Déploiements",
		Permission: "app:deploy",
	},
	"POST /api/v1/deployments/{id}/start": {
		Summary:    "Relance un déploiement arrêté.",
		Tag:        "Déploiements",
		Permission: "app:deploy",
	},
	"POST /api/v1/deployments/{id}/restart": {
		Summary:    "Redémarre les pods sans changer l'image.",
		Tag:        "Déploiements",
		Permission: "app:deploy",
	},
	"POST /api/v1/deployments/{id}/rollback": {
		Summary:    "Revient à une révision antérieure du même environnement.",
		Tag:        "Déploiements",
		Body:       map[string]string{"revision": "integer"},
		Permission: "app:deploy",
	},
	"DELETE /api/v1/deployments/{id}": {
		Summary:    "Supprime un déploiement et les ressources Kubernetes associées.",
		Tag:        "Déploiements",
		Permission: "app:delete",
	},
	"GET /api/v1/deployments/{id}/logs": {
		Summary:    "Retourne les journaux collectés pour ce déploiement.",
		Tag:        "Observation",
		Permission: "app:read",
	},
	"GET /api/v1/deployments/{id}/events": {
		Summary:    "Retourne les événements Kubernetes du déploiement : c'est là qu'un échec de démarrage s'explique.",
		Tag:        "Observation",
		Permission: "app:read",
	},

	// --- Configuration d'exécution ------------------------------------------
	"GET /api/v1/apps/{id}/env": {
		Summary:    "Retourne les variables d'un environnement. `?environment=` désigne lequel.",
		Tag:        "Configuration",
		Permission: "app:read",
	},
	"PUT /api/v1/apps/{id}/env": {
		Summary:    "Enregistre des variables injectées dans le conteneur au déploiement.",
		Tag:        "Configuration",
		Body:       map[string]string{"environment": "string", "vars": "object"},
		Permission: "app:config",
	},
	"DELETE /api/v1/apps/{id}/env/{key}": {
		Summary:    "Retire une variable.",
		Tag:        "Configuration",
		Permission: "app:config",
	},
	"GET /api/v1/apps/{id}/config": {
		Summary:    "Retourne la configuration d'exécution : ressources, sondes, quotas.",
		Tag:        "Configuration",
		Permission: "app:read",
	},
	"PUT /api/v1/apps/{id}/config": {
		Summary:    "Met à jour la configuration d'exécution d'un environnement.",
		Tag:        "Configuration",
		Permission: "app:config",
	},
	"GET /api/v1/apps/{id}/ports": {
		Summary:    "Retourne les ports ouverts par l'image. Un seul reçoit le trafic public.",
		Tag:        "Configuration",
		Permission: "app:read",
	},
	"PUT /api/v1/apps/{id}/ports": {
		Summary:    "Déclare les ports de l'application.",
		Tag:        "Configuration",
		Permission: "app:config",
	},

	// --- Jetons -------------------------------------------------------------
	"GET /api/v1/tokens": {
		Summary:    "Liste les jetons d'API de l'organisation. Leur valeur n'est jamais restituée.",
		Tag:        "Jetons",
		Permission: "app:read",
	},
	"POST /api/v1/tokens": {
		Summary:    "Crée un jeton d'API. Sa valeur n'est retournée qu'à cet appel.",
		Tag:        "Jetons",
		Body:       map[string]string{"name": "string", "expires_at": "string"},
		Permission: "token:manage",
	},
	"DELETE /api/v1/tokens/{id}": {
		Summary:    "Révoque un jeton.",
		Tag:        "Jetons",
		Permission: "token:manage",
	},

	// --- Registres ----------------------------------------------------------
	"GET /api/v1/registries": {
		Summary:    "Liste les registres d'images configurés.",
		Tag:        "Registres",
		Permission: "app:read",
	},
	"POST /api/v1/registries": {
		Summary:    "Enregistre un registre. Les identifiants sont chiffrés avant stockage.",
		Tag:        "Registres",
		Body:       map[string]string{"name": "string", "server": "string", "username": "string", "password": "string"},
		Permission: "registry:manage",
	},
	"DELETE /api/v1/registries/{id}": {
		Summary:    "Supprime un registre.",
		Tag:        "Registres",
		Permission: "registry:manage",
	},
	"GET /api/v1/registries/{id}/repositories": {
		Summary:    "Liste les dépôts d'images du registre.",
		Tag:        "Registres",
		Permission: "app:read",
	},
	"GET /api/v1/registries/{id}/tags": {
		Summary:    "Liste les tags d'un dépôt. `?repository=` désigne lequel.",
		Tag:        "Registres",
		Permission: "app:read",
	},

	// --- Infrastructure -----------------------------------------------------
	"GET /api/v1/clusters": {
		Summary:    "Liste les clusters rattachés à l'organisation.",
		Tag:        "Infrastructure",
		Permission: "app:read",
	},
	"POST /api/v1/clusters": {
		Summary:    "Enregistre un cluster et retourne le jeton que son agent utilisera.",
		Tag:        "Infrastructure",
		Body:       map[string]string{"name": "string"},
		Permission: "cluster:manage",
	},
	"DELETE /api/v1/clusters/{id}": {
		Summary:    "Retire un cluster. Ses déploiements ne sont pas supprimés.",
		Tag:        "Infrastructure",
		Permission: "cluster:manage",
	},
	"GET /api/v1/infra": {
		Summary:    "État de l'infrastructure : plan de contrôle, clusters, consommation.",
		Tag:        "Infrastructure",
		Permission: "app:read",
	},
}

// exposedModels associe un nom de schéma au type métier qu'il décrit.
//
// Les schémas sont dérivés de ces types : ajouter un champ à models.App le
// fait apparaître dans la documentation sans qu'on y pense.
var exposedModels = map[string]any{
	"App":        models.App{},
	"Deployment": models.Deployment{},
	"User":       models.User{},
}

// openAPI est le document servi.
type openAPI struct {
	OpenAPI    string         `json:"openapi"`
	Info       map[string]any `json:"info"`
	Servers    []any          `json:"servers"`
	Paths      map[string]any `json:"paths"`
	Components map[string]any `json:"components"`
	Tags       []any          `json:"tags"`
}

// buildOpenAPI construit la spécification à partir des routes documentées.
func buildOpenAPI(baseURL string, schemas map[string]any) openAPI {
	paths := map[string]any{}
	tags := map[string]bool{}

	for pattern, op := range operations {
		method, path, ok := strings.Cut(pattern, " ")
		if !ok {
			continue
		}
		tags[op.Tag] = true

		item, _ := paths[path].(map[string]any)
		if item == nil {
			item = map[string]any{}
			paths[path] = item
		}
		item[strings.ToLower(method)] = buildOperation(op, path)
	}

	names := make([]any, 0, len(tags))
	for t := range tags {
		names = append(names, map[string]any{"name": t})
	}
	sort.Slice(names, func(i, j int) bool {
		return names[i].(map[string]any)["name"].(string) <
			names[j].(map[string]any)["name"].(string)
	})

	return openAPI{
		OpenAPI: "3.1.0",
		Info: map[string]any{
			"title":   "Kybers Control Plane",
			"version": "1",
			"description": "API du plan de contrôle. Les jetons se créent depuis " +
				"le dashboard et s'envoient en en-tête `Authorization: Bearer`.",
		},
		Servers: []any{map[string]any{"url": baseURL}},
		Paths:   paths,
		Tags:    names,
		Components: map[string]any{
			"schemas": schemas,
			"securitySchemes": map[string]any{
				"bearer": map[string]any{
					"type":   "http",
					"scheme": "bearer",
				},
			},
		},
	}
}

// buildOperation décrit une route : ses paramètres de chemin, son corps et sa
// réponse.
func buildOperation(op operation, path string) map[string]any {
	out := map[string]any{
		"summary": op.Summary,
		"tags":    []string{op.Tag},
	}

	// Les paramètres de chemin se lisent dans le motif : `{id}` en est un.
	params := []any{}
	for _, seg := range strings.Split(path, "/") {
		if !strings.HasPrefix(seg, "{") || !strings.HasSuffix(seg, "}") {
			continue
		}
		name := strings.Trim(seg, "{}")
		name = strings.TrimSuffix(name, "...")
		params = append(params, map[string]any{
			"name":     name,
			"in":       "path",
			"required": true,
			"schema":   map[string]any{"type": "string"},
		})
	}
	if len(params) > 0 {
		out["parameters"] = params
	}

	if len(op.Body) > 0 {
		props := map[string]any{}
		for k, t := range op.Body {
			props[k] = map[string]any{"type": t}
		}
		out["requestBody"] = map[string]any{
			"content": map[string]any{
				"application/json": map[string]any{
					"schema": map[string]any{"type": "object", "properties": props},
				},
			},
		}
	}

	success := map[string]any{"description": "Succès"}
	if op.Returns != nil {
		ref := map[string]any{
			"$ref": "#/components/schemas/" + schemaName(op.Returns),
		}
		var schema any = ref
		if op.List {
			schema = map[string]any{"type": "array", "items": ref}
		}
		success["content"] = map[string]any{
			"application/json": map[string]any{"schema": schema},
		}
	}

	responses := map[string]any{"200": success}
	if op.Permission != "" {
		out["security"] = []any{map[string]any{"bearer": []string{}}}
		responses["401"] = map[string]any{"description": "Jeton absent ou invalide"}
		responses["403"] = map[string]any{
			"description": "Portée « " + op.Permission + " » requise",
		}
	}
	out["responses"] = responses
	return out
}

// schemaName retourne le nom du type sous lequel il est référencé.
func schemaName(v any) string {
	t := reflect.TypeOf(v)
	for t.Kind() == reflect.Ptr {
		t = t.Elem()
	}
	return t.Name()
}

// schemaOf décrit un type par réflexion sur ses balises JSON.
//
// C'est ce qui évite à la spec de mentir : ajouter un champ à un modèle le
// fait apparaître dans la documentation sans qu'on y pense.
func schemaOf(v any) map[string]any {
	t := reflect.TypeOf(v)
	for t.Kind() == reflect.Ptr {
		t = t.Elem()
	}
	if t.Kind() != reflect.Struct {
		return map[string]any{"type": "object"}
	}

	props := map[string]any{}
	required := []string{}

	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		if !f.IsExported() {
			continue
		}
		tag := f.Tag.Get("json")
		if tag == "-" || tag == "" {
			continue
		}
		name, rest, _ := strings.Cut(tag, ",")
		if name == "" {
			continue
		}

		props[name] = jsonType(f.Type)
		if !strings.Contains(rest, "omitempty") {
			required = append(required, name)
		}
	}

	out := map[string]any{"type": "object", "properties": props}
	if len(required) > 0 {
		sort.Strings(required)
		out["required"] = required
	}
	return out
}

// jsonType traduit un type Go en type JSON Schema.
func jsonType(t reflect.Type) map[string]any {
	for t.Kind() == reflect.Ptr {
		t = t.Elem()
	}

	switch t.Kind() {
	case reflect.Bool:
		return map[string]any{"type": "boolean"}
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64,
		reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return map[string]any{"type": "integer"}
	case reflect.Float32, reflect.Float64:
		return map[string]any{"type": "number"}
	case reflect.Slice, reflect.Array:
		return map[string]any{"type": "array", "items": jsonType(t.Elem())}
	case reflect.Map:
		return map[string]any{"type": "object"}
	case reflect.Struct:
		// time.Time se sérialise en chaîne ISO 8601, pas en objet.
		if t.PkgPath() == "time" && t.Name() == "Time" {
			return map[string]any{"type": "string", "format": "date-time"}
		}
		return map[string]any{"type": "object"}
	default:
		return map[string]any{"type": "string"}
	}
}
