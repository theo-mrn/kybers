// Package api expose l'API REST consommée par le dashboard et la CLI.
package api

import (
	_ "embed"

	"crypto/rand"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/kybers/kybers/control-plane/internal/auth"
	"github.com/kybers/kybers/control-plane/internal/db"
	"github.com/kybers/kybers/control-plane/internal/gitapi"
	"github.com/kybers/kybers/control-plane/internal/grpcserver"
	"github.com/kybers/kybers/control-plane/internal/hostname"
	"github.com/kybers/kybers/control-plane/internal/models"
	"github.com/kybers/kybers/control-plane/internal/registryapi"
)

//go:embed install.sh
var installScript string

type API struct {
	db   *db.DB
	grpc *grpcserver.Server
	log  *slog.Logger
	// Interroge le catalogue d'un registre (Docker Hub) pour lister dépôts et tags.
	hub *registryapi.Client
	// Attribue une URL publique aux déploiements qui n'en précisent pas.
	hosts *hostname.Generator
	// Lit les dépôts rattachés aux applications ; inerte sans jeton.
	git *gitapi.Client

	// openRegistration autorise l'inscription libre au-delà du premier compte.
	openRegistration bool

	// Paramètres injectés dans le script d'installation de l'agent.
	agentAddr     string
	agentImage    string
	chartURL      string
	agentInsecure bool
}

// InstallConfig décrit ce que le script d'installation doit annoncer à l'agent.
type InstallConfig struct {
	// AgentAddr : adresse gRPC joignable DEPUIS LES CLUSTERS CLIENTS, host:port.
	AgentAddr string
	// AgentImage : image de l'agent, au format repository:tag.
	AgentImage string
	// ChartURL : référence Helm du chart (OCI ou URL d'archive).
	ChartURL string
	// Insecure : true = gRPC en clair, à réserver au développement.
	Insecure bool
	// OpenRegistration : true = n'importe qui peut créer un compte. Faux par
	// défaut : seul le premier compte d'une instance vierge est libre.
	OpenRegistration bool

	// GitToken : jeton de l'instance pour lire les dépôts rattachés aux
	// applications. Vide = intégration Git désactivée.
	GitToken string
	// GitAPIURL : vide = github.com. À renseigner pour GitHub Enterprise.
	GitAPIURL string
}

func New(database *db.DB, grpc *grpcserver.Server, log *slog.Logger,
	hosts *hostname.Generator, install InstallConfig) *API {
	return &API{
		db:               database,
		grpc:             grpc,
		log:              log,
		hub:              registryapi.New(),
		git: gitapi.New(install.GitToken, install.GitAPIURL).
			// Le jeton peut être posé depuis l'interface : sans cette
			// résolution, il faudrait redémarrer pour qu'il prenne effet.
			WithResolver(func(ctx context.Context) (string, string) {
				if install.GitToken != "" {
					return install.GitToken, install.GitAPIURL
				}
				token, err := database.GetSetting(ctx, db.SettingGitToken)
				if err != nil || token == "" {
					return "", ""
				}
				apiURL, _ := database.GetSetting(ctx, db.SettingGitAPIURL)
				return token, apiURL
			}),
		hosts:            hosts,
		agentAddr:        install.AgentAddr,
		agentImage:       install.AgentImage,
		chartURL:         install.ChartURL,
		agentInsecure:    install.Insecure,
		openRegistration: install.OpenRegistration,
	}
}

func (a *API) Routes() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /healthz", a.health)
	// Script d'installation de l'agent, servi sans authentification : il ne
	// contient aucun secret, le jeton est fourni par l'utilisateur.
	mux.HandleFunc("GET /install.sh", a.installSh)

	// Authentification : les seules routes accessibles sans session.
	mux.HandleFunc("GET /api/v1/auth/bootstrap", a.bootstrapStatus)
	mux.HandleFunc("POST /api/v1/auth/register", a.register)
	mux.HandleFunc("POST /api/v1/auth/login", a.login)
	mux.HandleFunc("POST /api/v1/auth/logout", a.logout)
	mux.Handle("GET /api/v1/auth/me", a.requireAuth(a.me))
	mux.Handle("POST /api/v1/auth/password", a.requireAuth(a.changePassword))

	// Organisations et membres.
	mux.Handle("GET /api/v1/organizations", a.requireAuth(a.listOrganizations))
	mux.Handle("POST /api/v1/organizations", a.requireAuth(a.createOrganization))
	mux.Handle("GET /api/v1/members", a.requirePerm(a.listMembers, auth.PermAppRead))
	mux.Handle("POST /api/v1/members", a.requirePerm(a.addMember, auth.PermMemberManage))
	mux.Handle("PUT /api/v1/members/{userID}", a.requirePerm(a.updateMemberRole, auth.PermMemberManage))
	mux.Handle("DELETE /api/v1/members/{userID}", a.requirePerm(a.removeMember, auth.PermMemberManage))

	// Administration de la plateforme : création de comptes et d'organisations.
	mux.Handle("GET /api/v1/admin/users", a.requireAdmin(a.adminListUsers))
	mux.Handle("POST /api/v1/admin/users", a.requireAdmin(a.adminCreateUser))
	mux.Handle("PUT /api/v1/admin/users/{id}", a.requireAdmin(a.adminSetUserStatus))
	mux.Handle("POST /api/v1/admin/users/{id}/password", a.requireAdmin(a.adminResetPassword))
	mux.Handle("POST /api/v1/admin/assign", a.requireAdmin(a.adminAssignOrg))
	mux.Handle("GET /api/v1/admin/organizations", a.requireAdmin(a.adminListOrganizations))
	mux.Handle("POST /api/v1/admin/organizations", a.requireAdmin(a.adminCreateOrganization))
	mux.Handle("PUT /api/v1/admin/organizations/{id}", a.requireAdmin(a.adminRenameOrganization))
	mux.Handle("DELETE /api/v1/admin/organizations/{id}", a.requireAdmin(a.adminDeleteOrganization))
	mux.Handle("GET /api/v1/admin/organizations/{id}/members", a.requireAdmin(a.adminListOrgMembers))
	mux.Handle("DELETE /api/v1/admin/organizations/{id}/members/{userID}", a.requireAdmin(a.adminRemoveOrgMember))

	// Portée des clusters : partagés par défaut, restreignables au besoin.
	mux.Handle("GET /api/v1/admin/clusters", a.requireAdmin(a.adminListClusters))
	mux.Handle("PUT /api/v1/admin/clusters/{id}/organizations/{orgID}", a.requireAdmin(a.adminRestrictCluster))
	mux.Handle("DELETE /api/v1/admin/clusters/{id}/organizations/{orgID}", a.requireAdmin(a.adminUnrestrictCluster))

	// Droits individuels, gérés par un propriétaire d'organisation.
	mux.Handle("GET /api/v1/members/{userID}/permissions",
		a.requirePerm(a.getUserPermissions, auth.PermMemberManage))
	mux.Handle("PUT /api/v1/members/{userID}/permissions",
		a.requirePerm(a.setUserPermission, auth.PermMemberManage))

	// Jetons d'API, personnels.
	mux.Handle("GET /api/v1/tokens", a.requireAuth(a.listTokens))
	mux.Handle("POST /api/v1/tokens", a.requireAuth(a.createToken))
	mux.Handle("DELETE /api/v1/tokens/{id}", a.requireAuth(a.deleteToken))

	// Applications
	mux.Handle("GET /api/v1/apps", a.requirePerm(a.listApps, auth.PermAppRead))
	mux.Handle("POST /api/v1/apps", a.requirePerm(a.createApp, auth.PermAppConfig))
	mux.Handle("GET /api/v1/apps/{id}", a.requirePerm(a.getApp, auth.PermAppRead))

	// Variables d'environnement
	mux.Handle("PUT /api/v1/apps/{id}/env", a.requirePerm(a.setEnv, auth.PermAppConfig))
	mux.Handle("GET /api/v1/apps/{id}/env", a.requirePerm(a.getEnv, auth.PermAppRead))
	mux.Handle("DELETE /api/v1/apps/{id}/env/{key}", a.requirePerm(a.deleteEnv, auth.PermAppConfig))

	// Variables sensibles : écriture seule, jamais relues en clair.
	mux.Handle("PUT /api/v1/apps/{id}/secrets", a.requirePerm(a.setSecrets, auth.PermSecretWrite))
	mux.Handle("GET /api/v1/apps/{id}/secrets", a.requirePerm(a.listSecretKeys, auth.PermSecretRead))
	mux.Handle("DELETE /api/v1/apps/{id}/secrets/{key}", a.requirePerm(a.deleteSecret, auth.PermSecretWrite))

	// Configuration d'exécution
	mux.Handle("GET /api/v1/apps/{id}/config", a.requirePerm(a.getConfig, auth.PermAppRead))
	mux.Handle("PUT /api/v1/apps/{id}/config", a.requirePerm(a.setConfig, auth.PermAppConfig))

	// Déploiement et historique
	mux.Handle("PUT /api/v1/git/settings", a.requireAdmin(a.setGitSettings))
	mux.Handle("GET /api/v1/template-folders", a.requirePerm(a.listFolders, auth.PermAppRead))
	mux.Handle("POST /api/v1/template-folders", a.requirePerm(a.saveFolder, auth.PermAppConfig))
	mux.Handle("PUT /api/v1/template-folders/{id}", a.requirePerm(a.saveFolder, auth.PermAppConfig))
	mux.Handle("DELETE /api/v1/template-folders/{id}", a.requirePerm(a.deleteFolder, auth.PermAppConfig))
	mux.Handle("GET /api/v1/templates", a.requirePerm(a.listTemplates, auth.PermAppRead))
	mux.Handle("POST /api/v1/templates", a.requirePerm(a.saveTemplate, auth.PermAppConfig))
	mux.Handle("PUT /api/v1/templates/{id}", a.requirePerm(a.saveTemplate, auth.PermAppConfig))
	mux.Handle("DELETE /api/v1/templates/{id}", a.requirePerm(a.deleteTemplate, auth.PermAppConfig))
	mux.Handle("GET /api/v1/git/status", a.requireAuth(a.gitStatus))
	mux.Handle("GET /api/v1/git/repo", a.requireAuth(a.gitLookup))
	mux.Handle("GET /api/v1/git/file", a.requirePerm(a.gitReadFile, auth.PermAppRead))
	mux.Handle("PUT /api/v1/git/file", a.requirePerm(a.gitWriteFile, auth.PermAppConfig))
	mux.Handle("POST /api/v1/git/files", a.requirePerm(a.gitWriteFiles, auth.PermAppConfig))
	mux.Handle("POST /api/v1/git/workflow", a.requirePerm(a.gitInstallWorkflow, auth.PermAppConfig))
	mux.Handle("POST /api/v1/git/repos", a.requirePerm(a.gitCreateRepo, auth.PermAppConfig))
	mux.Handle("DELETE /api/v1/apps/{id}", a.requirePerm(a.deleteApp, auth.PermAppDelete))
	mux.Handle("GET /api/v1/apps/{id}/repo", a.requirePerm(a.getAppRepo, auth.PermAppRead))
	mux.Handle("PUT /api/v1/apps/{id}/repo", a.requirePerm(a.setAppRepo, auth.PermAppConfig))
	mux.Handle("GET /api/v1/apps/{id}/docs", a.requirePerm(a.listAppDocs, auth.PermAppRead))
	mux.Handle("GET /api/v1/apps/{id}/docs/{path...}", a.requirePerm(a.getAppDoc, auth.PermAppRead))
	mux.Handle("GET /api/v1/apps/{id}/runs", a.requirePerm(a.listAppRuns, auth.PermAppRead))
	mux.Handle("GET /api/v1/apps/{id}/ports", a.requirePerm(a.listAppPorts, auth.PermAppRead))
	mux.Handle("PUT /api/v1/apps/{id}/ports", a.requirePerm(a.setAppPorts, auth.PermAppConfig))
	mux.Handle("POST /api/v1/apps/{id}/deploy", a.requirePerm(a.deploy, auth.PermAppDeploy))
	mux.Handle("GET /api/v1/apps/{id}/deployments", a.requirePerm(a.listAppDeployments, auth.PermAppRead))

	// Cycle de vie
	mux.Handle("GET /api/v1/deployments", a.requirePerm(a.listDeployments, auth.PermAppRead))
	mux.Handle("GET /api/v1/deployments/{id}", a.requirePerm(a.getDeployment, auth.PermAppRead))
	mux.Handle("GET /api/v1/deployments/{id}/logs", a.requirePerm(a.getLogs, auth.PermLogsRead))
	mux.Handle("GET /api/v1/deployments/{id}/events", a.requirePerm(a.getEvents, auth.PermLogsRead))
	mux.Handle("POST /api/v1/deployments/{id}/scale", a.requirePerm(a.scale, auth.PermAppLifecyle))
	mux.Handle("POST /api/v1/deployments/{id}/stop", a.requirePerm(a.stop, auth.PermAppLifecyle))
	mux.Handle("POST /api/v1/deployments/{id}/start", a.requirePerm(a.start, auth.PermAppLifecyle))
	mux.Handle("POST /api/v1/deployments/{id}/restart", a.requirePerm(a.restart, auth.PermAppLifecyle))
	mux.Handle("POST /api/v1/deployments/{id}/rollback", a.requirePerm(a.rollback, auth.PermAppLifecyle))
	mux.Handle("DELETE /api/v1/deployments/{id}", a.requirePerm(a.deleteDeployment, auth.PermAppDelete))
	mux.Handle("POST /api/v1/deployments/{id}/logs/follow", a.requirePerm(a.followLogs, auth.PermLogsRead))

	// Registries privés
	mux.Handle("GET /api/v1/registries", a.requirePerm(a.listRegistries, auth.PermRegistryRead))
	mux.Handle("POST /api/v1/registries", a.requirePerm(a.createRegistry, auth.PermRegistryWrite))
	mux.Handle("DELETE /api/v1/registries/{id}", a.requirePerm(a.deleteRegistry, auth.PermRegistryWrite))
	// Parcours du catalogue d'un compte (Docker Hub uniquement pour l'instant).
	mux.Handle("GET /api/v1/registries/{id}/repositories", a.requirePerm(a.listRepositories, auth.PermRegistryRead))
	mux.Handle("GET /api/v1/registries/{id}/tags", a.requirePerm(a.listTags, auth.PermRegistryRead))
	mux.Handle("POST /api/v1/registries/test", a.requirePerm(a.testRegistry, auth.PermRegistryWrite))

	// Clusters : un agent par cluster, avec son propre jeton.
	mux.Handle("GET /api/v1/clusters", a.requirePerm(a.listClusters, auth.PermClusterRead))
	mux.Handle("POST /api/v1/clusters", a.requirePerm(a.createCluster, auth.PermClusterWrite))
	mux.Handle("DELETE /api/v1/clusters/{id}", a.requirePerm(a.deleteCluster, auth.PermClusterWrite))
	// Vue d'ensemble de l'infrastructure : Control Plane + clusters.
	mux.Handle("GET /api/v1/infra", a.requirePerm(a.infra, auth.PermClusterRead))
	mux.Handle("PUT /api/v1/clusters/{id}/metrics-source", a.requirePerm(a.setMetricsSource, auth.PermClusterWrite))

	return cors(mux)
}

// ---------------------------------------------------------------------------
// Middlewares
// ---------------------------------------------------------------------------

func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ---------------------------------------------------------------------------
// Santé & clusters
// ---------------------------------------------------------------------------

func (a *API) health(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"status": "ok",
		"agents": a.grpc.ConnectedAgents(),
	})
}

// installCommand construit la ligne à coller pour installer l'agent.
//
// L'URL est déduite de la requête : le dashboard et l'utilisateur peuvent
// joindre le Control Plane par des adresses différentes.
func (a *API) installCommand(r *http.Request, clusterName, token string) string {
	scheme := "http"
	if r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" {
		scheme = "https"
	}
	base := scheme + "://" + r.Host

	return "curl -sSL " + base + "/install.sh | KYBERS_TOKEN=" + token +
		" KYBERS_CLUSTER=" + clusterName + " sh"
}

// installSh sert le script d'installation de l'agent, avec l'adresse du
// Control Plane et l'image déjà renseignées.
//
// Le script ne contient pas de jeton : celui-ci est passé en variable
// d'environnement par l'utilisateur, ce qui évite de servir un secret sur un
// endpoint public.
func (a *API) installSh(w http.ResponseWriter, r *http.Request) {
	script := installScript
	script = strings.ReplaceAll(script, "__ADDR__", a.agentAddr)
	script = strings.ReplaceAll(script, "__IMAGE__", a.agentImage)
	script = strings.ReplaceAll(script, "__CHART_URL__", a.chartURL)
	script = strings.ReplaceAll(script, "__INSECURE__", strconv.FormatBool(a.agentInsecure))

	w.Header().Set("Content-Type", "text/x-shellscript; charset=utf-8")
	_, _ = w.Write([]byte(script))
}

func (a *API) listClusters(w http.ResponseWriter, r *http.Request) {
	// Les clusters sont partagés : une organisation voit ceux de la plateforme
	// et peut y déployer, dans ses propres namespaces — sauf restriction
	// explicite à d'autres organisations.
	orgID, _ := currentOrg(r)
	clusters, err := a.db.ListClusters(r.Context(), orgID)
	if err != nil {
		a.fail(w, "ListClusters", err)
		return
	}

	// L'état "connected" en base est mis à jour par les heartbeats ; le registre
	// gRPC reflète la réalité immédiate.
	live := map[string]bool{}
	for _, name := range a.grpc.ConnectedAgents() {
		live[name] = true
	}
	for i := range clusters {
		clusters[i].Connected = live[clusters[i].Name]
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"clusters":  clusters,
		"connected": a.grpc.ConnectedAgents(),
	})
}

// createCluster enregistre un cluster et génère son jeton.
//
// Le jeton n'est retourné qu'à la création : il sert à installer l'agent et
// n'est plus jamais relisible ensuite.
func (a *API) createCluster(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name string `json:"name"`
	}
	if err := decode(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "JSON invalide")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		writeErr(w, http.StatusBadRequest, "le champ 'name' est requis")
		return
	}

	token, err := randomToken()
	if err != nil {
		a.fail(w, "randomToken", err)
		return
	}

	cluster, err := a.db.CreateCluster(r.Context(), req.Name, token)
	if err != nil {
		a.fail(w, "CreateCluster", err)
		return
	}
	a.log.Info("cluster enregistré", "cluster", cluster.Name)

	writeJSON(w, http.StatusCreated, map[string]any{
		"cluster": cluster,
		// Affiché une seule fois, à reporter dans la commande d'installation.
		"token": token,
		// Commande prête à coller : c'est la voie normale d'installation.
		"install_command": a.installCommand(r, cluster.Name, token),
	})
}

func (a *API) deleteCluster(w http.ResponseWriter, r *http.Request) {
	if err := a.db.DeleteCluster(r.Context(), r.PathValue("id")); err != nil {
		a.fail(w, "DeleteCluster", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// usageWindowHours est la fenêtre d'historique renvoyée pour les courbes.
const usageWindowHours = 24

// infra agrège l'état du plan de contrôle et de chaque cluster : c'est la
// source unique de la page Infrastructure du dashboard.
func (a *API) infra(w http.ResponseWriter, r *http.Request) {
	orgID, _ := currentOrg(r)
	clusters, err := a.db.ListClusters(r.Context(), orgID)
	if err != nil {
		a.fail(w, "ListClusters", err)
		return
	}

	live := map[string]bool{}
	for _, name := range a.grpc.ConnectedAgents() {
		live[name] = true
	}

	out := make([]map[string]any, 0, len(clusters))
	for _, c := range clusters {
		entry := map[string]any{
			"id":        c.ID,
			"name":      c.Name,
			"connected": live[c.Name],
			"last_seen": c.LastSeen,
		}

		// L'état détaillé n'existe que si un agent l'a déjà remonté.
		raw, updated, version, err := a.db.GetClusterInfo(r.Context(), c.ID)
		if err == nil {
			if len(raw) > 0 && string(raw) != "null" {
				entry["info"] = json.RawMessage(raw)
			}
			entry["info_updated_at"] = updated
			entry["agent_version"] = version
		}

		if pref, err := a.db.GetClusterMetricsSource(r.Context(), c.ID); err == nil {
			entry["metrics_source_preference"] = pref
		}

		// Consommation : dernier relevé + historique pour la courbe.
		if latest, err := a.db.GetLatestUsage(r.Context(), c.ID); err == nil && latest != nil {
			entry["usage"] = latest
		}
		if history, err := a.db.GetUsageHistory(r.Context(), c.ID, usageWindowHours); err == nil &&
			len(history) > 0 {
			entry["usage_history"] = history
		}

		out = append(out, entry)
	}

	// Santé de la base : sans elle, plus rien ne fonctionne.
	dbOK := a.db.Pool.Ping(r.Context()) == nil

	writeJSON(w, http.StatusOK, map[string]any{
		"control_plane": map[string]any{
			"database_ok":      dbOK,
			"agents_connected": len(a.grpc.ConnectedAgents()),
			"url_generation":   a.hosts.Enabled(),
			"url_tls":          a.hosts.TLS(),
			// L'authentification est désormais toujours active : toute route
			// applicative exige une session ou un jeton.
			"api_auth": true,
			// Intégration Git : sans jeton, documentation et pipelines des
			// dépôts rattachés restent inaccessibles.
			"git_integration": a.git.Configured(r.Context()),
		},
		"clusters": out,
	})
}

// setMetricsSource applique le choix de source fait dans le dashboard.
//
// Le choix est persisté puis poussé à l'agent : il survit ainsi aux
// reconnexions et prend effet immédiatement.
func (a *API) setMetricsSource(w http.ResponseWriter, r *http.Request) {
	clusterID := r.PathValue("id")

	var req struct {
		Source        string `json:"source"`
		PrometheusURL string `json:"prometheus_url"`
	}
	if err := decode(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "JSON invalide")
		return
	}

	switch req.Source {
	case "", "metrics-server", "prometheus":
	default:
		writeErr(w, http.StatusBadRequest,
			"source invalide : attendu 'metrics-server', 'prometheus' ou vide")
		return
	}

	if err := a.db.SetClusterMetricsSource(r.Context(), clusterID, req.Source); err != nil {
		a.fail(w, "SetClusterMetricsSource", err)
		return
	}

	// L'agent peut être déconnecté : le choix est enregistré et sera appliqué
	// à sa prochaine connexion.
	applied := true
	if err := a.grpc.SendMetricsSource("", clusterID, req.Source, req.PrometheusURL); err != nil {
		a.log.Warn("source de métriques non transmise", "cluster", clusterID, "err", err)
		applied = false
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"source":  req.Source,
		"applied": applied,
	})
}

// randomToken produit un secret de 32 octets, encodé en hexadécimal.
func randomToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------

func (a *API) listApps(w http.ResponseWriter, r *http.Request) {
	orgID, _ := currentOrg(r)
	apps, err := a.db.ListApps(r.Context(), orgID)
	if err != nil {
		a.fail(w, "ListApps", err)
		return
	}
	writeJSON(w, http.StatusOK, apps)
}

func (a *API) getApp(w http.ResponseWriter, r *http.Request) {
	orgID, _ := currentOrg(r)
	app, err := a.db.GetApp(r.Context(), orgID, r.PathValue("id"))
	if err != nil {
		writeErr(w, http.StatusNotFound, "application introuvable")
		return
	}
	writeJSON(w, http.StatusOK, app)
}

type createAppReq struct {
	Name          string `json:"name"`
	GitRepo       string `json:"git_repo"`
	ContainerPort int    `json:"container_port"`
	// Cluster cible ; vide n'est sûr que si un seul cluster est connecté.
	ClusterID string `json:"cluster_id"`
}

func (a *API) createApp(w http.ResponseWriter, r *http.Request) {
	var req createAppReq
	if err := decode(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "JSON invalide")
		return
	}
	if req.Name == "" {
		writeErr(w, http.StatusBadRequest, "le champ 'name' est requis")
		return
	}
	if req.ContainerPort == 0 {
		req.ContainerPort = 8080
	}

	var clusterID *string
	if req.ClusterID != "" {
		clusterID = &req.ClusterID
	}

	orgID, _ := currentOrg(r)
	app, err := a.db.CreateApp(r.Context(), orgID, req.Name, req.GitRepo, req.ContainerPort, clusterID)
	if err != nil {
		a.fail(w, "CreateApp", err)
		return
	}
	writeJSON(w, http.StatusCreated, app)
}

// ---------------------------------------------------------------------------
// Variables d'environnement
// ---------------------------------------------------------------------------

func (a *API) setEnv(w http.ResponseWriter, r *http.Request) {
	appID := r.PathValue("id")

	var req struct {
		Environment string            `json:"environment"`
		Vars        map[string]string `json:"vars"`
	}
	if err := decode(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "JSON invalide")
		return
	}
	if req.Environment == "" {
		writeErr(w, http.StatusBadRequest, "le champ 'environment' est requis")
		return
	}

	vars := make([]models.EnvVar, 0, len(req.Vars))
	for k, v := range req.Vars {
		vars = append(vars, models.EnvVar{Key: k, Value: v})
	}
	if err := a.db.SetEnvVars(r.Context(), appID, req.Environment, vars); err != nil {
		a.fail(w, "SetEnvVars", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"updated": len(vars)})
}

func (a *API) getEnv(w http.ResponseWriter, r *http.Request) {
	env := envParam(r)
	vars, err := a.db.GetEnvVars(r.Context(), r.PathValue("id"), env)
	if err != nil {
		a.fail(w, "GetEnvVars", err)
		return
	}
	writeJSON(w, http.StatusOK, vars)
}

func (a *API) deleteEnv(w http.ResponseWriter, r *http.Request) {
	if err := a.db.DeleteEnvVar(r.Context(), r.PathValue("id"), envParam(r), r.PathValue("key")); err != nil {
		a.fail(w, "DeleteEnvVar", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---------------------------------------------------------------------------
// Variables sensibles
// ---------------------------------------------------------------------------

func (a *API) setSecrets(w http.ResponseWriter, r *http.Request) {
	appID := r.PathValue("id")

	var req struct {
		Environment string            `json:"environment"`
		Vars        map[string]string `json:"vars"`
	}
	if err := decode(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "JSON invalide")
		return
	}
	if req.Environment == "" {
		writeErr(w, http.StatusBadRequest, "le champ 'environment' est requis")
		return
	}

	vars := make([]models.EnvVar, 0, len(req.Vars))
	for k, v := range req.Vars {
		vars = append(vars, models.EnvVar{Key: k, Value: v})
	}
	if err := a.db.SetSecretVars(r.Context(), appID, req.Environment, vars); err != nil {
		a.fail(w, "SetSecretVars", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"updated": len(vars)})
}

// listSecretKeys ne retourne que les noms : les valeurs ne quittent jamais le
// Control Plane autrement que vers l'agent.
func (a *API) listSecretKeys(w http.ResponseWriter, r *http.Request) {
	keys, err := a.db.ListSecretKeys(r.Context(), r.PathValue("id"), envParam(r))
	if err != nil {
		a.fail(w, "ListSecretKeys", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"keys": keys})
}

func (a *API) deleteSecret(w http.ResponseWriter, r *http.Request) {
	if err := a.db.DeleteSecretVar(r.Context(), r.PathValue("id"), envParam(r), r.PathValue("key")); err != nil {
		a.fail(w, "DeleteSecretVar", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---------------------------------------------------------------------------
// Configuration d'exécution
// ---------------------------------------------------------------------------

func (a *API) getConfig(w http.ResponseWriter, r *http.Request) {
	cfg, err := a.db.GetAppConfig(r.Context(), r.PathValue("id"), envParam(r))
	if err != nil {
		a.fail(w, "GetAppConfig", err)
		return
	}
	writeJSON(w, http.StatusOK, cfg)
}

func (a *API) setConfig(w http.ResponseWriter, r *http.Request) {
	appID := r.PathValue("id")

	var cfg models.AppConfig
	if err := decode(r, &cfg); err != nil {
		writeErr(w, http.StatusBadRequest, "JSON invalide")
		return
	}
	cfg.AppID = appID
	if cfg.Environment == "" {
		cfg.Environment = envParam(r)
	}
	if cfg.Environment == "" {
		writeErr(w, http.StatusBadRequest, "le champ 'environment' est requis")
		return
	}

	// Complète les champs laissés vides avec les valeurs par défaut, pour ne
	// pas produire un Deployment sans requests ni limits.
	def := models.DefaultAppConfig(appID, cfg.Environment)
	if cfg.CPURequest == "" {
		cfg.CPURequest = def.CPURequest
	}
	if cfg.MemoryRequest == "" {
		cfg.MemoryRequest = def.MemoryRequest
	}
	if cfg.CPULimit == "" {
		cfg.CPULimit = def.CPULimit
	}
	if cfg.MemoryLimit == "" {
		cfg.MemoryLimit = def.MemoryLimit
	}
	if cfg.AutoscalingMin <= 0 {
		cfg.AutoscalingMin = def.AutoscalingMin
	}
	if cfg.AutoscalingMax <= 0 {
		cfg.AutoscalingMax = def.AutoscalingMax
	}
	if cfg.AutoscalingCPU <= 0 {
		cfg.AutoscalingCPU = def.AutoscalingCPU
	}

	if err := a.db.UpsertAppConfig(r.Context(), cfg); err != nil {
		a.fail(w, "UpsertAppConfig", err)
		return
	}
	writeJSON(w, http.StatusOK, cfg)
}

// ---------------------------------------------------------------------------
// Déploiement
// ---------------------------------------------------------------------------

type deployReq struct {
	Environment string `json:"environment"`
	Image       string `json:"image"`
	Replicas    int    `json:"replicas"`
	Host        string `json:"host"`

	// Provenance, facultative : Kybers ne construit pas les images, c'est le
	// CI appelant qui sait de quel commit elles proviennent.
	GitCommit  string `json:"git_commit"`
	GitRef     string `json:"git_ref"`
	GitMessage string `json:"git_message"`
	Source     string `json:"source"`
}

// deploy est le point d'entrée du flux : il enregistre la demande en "pending"
// et rend la main immédiatement. Le dispatcher se charge de l'envoi à l'agent.
func (a *API) deploy(w http.ResponseWriter, r *http.Request) {
	appID := r.PathValue("id")

	var req deployReq
	if err := decode(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "JSON invalide")
		return
	}
	if req.Environment == "" {
		req.Environment = "staging"
	}
	if req.Image == "" {
		writeErr(w, http.StatusBadRequest, "le champ 'image' est requis")
		return
	}
	if req.Replicas <= 0 {
		req.Replicas = 1
	}

	orgID, _ := currentOrg(r)
	app, err := a.db.GetApp(r.Context(), orgID, appID)
	if err != nil {
		writeErr(w, http.StatusNotFound, "application introuvable")
		return
	}

	// Sans hostname, l'application ne serait joignable que depuis l'intérieur
	// du cluster : on lui en attribue un automatiquement.
	if req.Host == "" {
		req.Host = a.hosts.For(app.Name, req.Environment)
	}

	// La configuration est figée dans le déploiement : un rollback rejouera
	// exactement ce qui a été appliqué, même si la config a changé depuis.
	cfg, err := a.db.GetAppConfig(r.Context(), appID, req.Environment)
	if err != nil {
		a.fail(w, "GetAppConfig", err)
		return
	}

	// Une requête sans origine explicite vient du dashboard : l'API est le
	// seul chemin, et le CI, lui, se déclare.
	source := req.Source
	if source == "" {
		source = "dashboard"
	}

	dep, err := a.db.CreateDeploymentRevision(
		r.Context(), appID, req.Environment, req.Image, req.Host, req.Replicas, cfg, nil,
		models.Provenance{
			GitCommit:  req.GitCommit,
			GitRef:     req.GitRef,
			GitMessage: req.GitMessage,
			Source:     source,
		})
	if err != nil {
		a.fail(w, "CreateDeploymentRevision", err)
		return
	}

	a.log.Info("déploiement mis en attente",
		"deployment", dep.ID, "app_id", appID, "env", req.Environment,
		"image", req.Image, "révision", dep.Revision)
	writeJSON(w, http.StatusAccepted, dep)
}

func (a *API) listAppDeployments(w http.ResponseWriter, r *http.Request) {
	deps, err := a.db.ListDeploymentsByApp(r.Context(), r.PathValue("id"), envParam(r))
	if err != nil {
		a.fail(w, "ListDeploymentsByApp", err)
		return
	}
	writeJSON(w, http.StatusOK, deps)
}

func (a *API) listDeployments(w http.ResponseWriter, r *http.Request) {
	orgID, _ := currentOrg(r)
	deps, err := a.db.ListDeployments(r.Context(), orgID)
	if err != nil {
		a.fail(w, "ListDeployments", err)
		return
	}
	writeJSON(w, http.StatusOK, deps)
}

func (a *API) getDeployment(w http.ResponseWriter, r *http.Request) {
	dep, err := a.db.GetDeployment(r.Context(), r.PathValue("id"))
	if err != nil {
		writeErr(w, http.StatusNotFound, "déploiement introuvable")
		return
	}
	writeJSON(w, http.StatusOK, dep)
}

// ---------------------------------------------------------------------------
// Cycle de vie
// ---------------------------------------------------------------------------

// enqueue crée une commande et la confie au dispatcher.
func (a *API) enqueue(w http.ResponseWriter, r *http.Request, kind string, payload any) {
	depID := r.PathValue("id")
	if _, err := a.db.GetDeployment(r.Context(), depID); err != nil {
		writeErr(w, http.StatusNotFound, "déploiement introuvable")
		return
	}

	cmd, err := a.db.CreateCommand(r.Context(), depID, kind, payload)
	if err != nil {
		a.fail(w, "CreateCommand", err)
		return
	}
	a.log.Info("commande mise en attente", "command", cmd.ID, "type", kind, "deployment", depID)
	writeJSON(w, http.StatusAccepted, cmd)
}

func (a *API) scale(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Replicas *int `json:"replicas"`
	}
	if err := decode(r, &req); err != nil || req.Replicas == nil {
		writeErr(w, http.StatusBadRequest, "le champ 'replicas' est requis")
		return
	}
	if *req.Replicas < 0 {
		writeErr(w, http.StatusBadRequest, "'replicas' ne peut pas être négatif")
		return
	}

	if err := a.db.SetDeploymentReplicas(r.Context(), r.PathValue("id"), *req.Replicas); err != nil {
		a.fail(w, "SetDeploymentReplicas", err)
		return
	}
	a.enqueue(w, r, models.CommandScale, map[string]int{"replicas": *req.Replicas})
}

// stop met l'application à zéro replica sans supprimer sa configuration.
func (a *API) stop(w http.ResponseWriter, r *http.Request) {
	if err := a.db.SetDeploymentReplicas(r.Context(), r.PathValue("id"), 0); err != nil {
		a.fail(w, "SetDeploymentReplicas", err)
		return
	}
	a.enqueue(w, r, models.CommandScale, map[string]int{"replicas": 0})
}

// start redémarre une application arrêtée, avec 1 replica par défaut.
func (a *API) start(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Replicas int `json:"replicas"`
	}
	_ = decode(r, &req)
	if req.Replicas <= 0 {
		req.Replicas = 1
	}

	if err := a.db.SetDeploymentReplicas(r.Context(), r.PathValue("id"), req.Replicas); err != nil {
		a.fail(w, "SetDeploymentReplicas", err)
		return
	}
	a.enqueue(w, r, models.CommandScale, map[string]int{"replicas": req.Replicas})
}

func (a *API) restart(w http.ResponseWriter, r *http.Request) {
	a.enqueue(w, r, models.CommandRestart, map[string]any{})
}

func (a *API) deleteDeployment(w http.ResponseWriter, r *http.Request) {
	// ?namespace=true supprime tout l'environnement, pas seulement l'app.
	deleteNS := r.URL.Query().Get("namespace") == "true"
	a.enqueue(w, r, models.CommandDelete, map[string]bool{"delete_namespace": deleteNS})
}

// rollback crée une nouvelle révision reprenant l'image et la configuration
// figées d'une révision antérieure. L'historique reste ainsi linéaire.
func (a *API) rollback(w http.ResponseWriter, r *http.Request) {
	sourceID := r.PathValue("id")

	source, err := a.db.GetDeployment(r.Context(), sourceID)
	if err != nil {
		writeErr(w, http.StatusNotFound, "déploiement introuvable")
		return
	}

	// La configuration figée lors de la révision cible est réappliquée : sans
	// cela, un rollback rejouerait l'ancienne image avec la configuration
	// COURANTE, ce qui ne restaure pas l'état d'origine.
	snapshot, err := a.db.GetDeploymentSnapshot(r.Context(), sourceID)
	restored := false
	if err == nil && len(snapshot) > 0 && string(snapshot) != "{}" && string(snapshot) != "null" {
		var cfg models.AppConfig
		if err := json.Unmarshal(snapshot, &cfg); err == nil && cfg.Environment != "" {
			cfg.AppID = source.AppID
			if err := a.db.UpsertAppConfig(r.Context(), cfg); err != nil {
				a.log.Error("restauration de la configuration", "err", err)
			} else {
				restored = true
			}
		}
	}

	dep, err := a.db.CreateDeploymentRevision(
		r.Context(), source.AppID, source.Environment, source.Image, source.Host,
		source.Replicas, snapshot, &sourceID,
		// Le rollback rejoue le code de la révision source : sa provenance est
		// donc celle de l'image restaurée, pas une nouvelle.
		models.Provenance{
			GitCommit:  source.GitCommit,
			GitRef:     source.GitRef,
			GitMessage: source.GitMessage,
			Source:     "rollback",
		})
	if err != nil {
		a.fail(w, "CreateDeploymentRevision", err)
		return
	}

	a.log.Info("rollback demandé",
		"nouveau", dep.ID, "source", sourceID,
		"révision_source", source.Revision, "nouvelle_révision", dep.Revision,
		"config_restaurée", restored)
	writeJSON(w, http.StatusAccepted, dep)
}

// followLogs démarre ou arrête le suivi des logs en continu côté agent.
func (a *API) followLogs(w http.ResponseWriter, r *http.Request) {
	depID := r.PathValue("id")

	dep, err := a.db.GetDeployment(r.Context(), depID)
	if err != nil {
		writeErr(w, http.StatusNotFound, "déploiement introuvable")
		return
	}

	var req struct {
		Follow bool `json:"follow"`
	}
	_ = decode(r, &req)

	if err := a.grpc.SendLogStream(dep.ID, dep.AppName, dep.Environment, req.Follow); err != nil {
		writeErr(w, http.StatusServiceUnavailable, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"follow": req.Follow})
}

func (a *API) getLogs(w http.ResponseWriter, r *http.Request) {
	logs, err := a.db.GetLogs(r.Context(), r.PathValue("id"), limitParam(r, 200, 1000))
	if err != nil {
		a.fail(w, "GetLogs", err)
		return
	}
	writeJSON(w, http.StatusOK, logs)
}

func (a *API) getEvents(w http.ResponseWriter, r *http.Request) {
	events, err := a.db.GetEvents(r.Context(), r.PathValue("id"), limitParam(r, 100, 500))
	if err != nil {
		a.fail(w, "GetEvents", err)
		return
	}
	writeJSON(w, http.StatusOK, events)
}

// ---------------------------------------------------------------------------
// Registries
// ---------------------------------------------------------------------------

func (a *API) listRegistries(w http.ResponseWriter, r *http.Request) {
	orgID, _ := currentOrg(r)
	regs, err := a.db.ListRegistries(r.Context(), orgID)
	if err != nil {
		a.fail(w, "ListRegistries", err)
		return
	}
	writeJSON(w, http.StatusOK, regs)
}

func (a *API) createRegistry(w http.ResponseWriter, r *http.Request) {
	orgID, _ := currentOrg(r)
	var req struct {
		Name     string `json:"name"`
		Server   string `json:"server"`
		Username string `json:"username"`
		Password string `json:"password"`
		Email    string `json:"email"`
	}
	if err := decode(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "JSON invalide")
		return
	}
	if req.Name == "" || req.Server == "" || req.Username == "" || req.Password == "" {
		writeErr(w, http.StatusBadRequest, "'name', 'server', 'username' et 'password' sont requis")
		return
	}

	reg, err := a.db.CreateRegistry(r.Context(), orgID, req.Name, req.Server, req.Username, req.Password, req.Email)
	if err != nil {
		a.fail(w, "CreateRegistry", err)
		return
	}
	writeJSON(w, http.StatusCreated, reg)
}

func (a *API) deleteRegistry(w http.ResponseWriter, r *http.Request) {
	orgID, _ := currentOrg(r)
	if err := a.db.DeleteRegistry(r.Context(), orgID, r.PathValue("id")); err != nil {
		a.fail(w, "DeleteRegistry", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// testRegistry valide des identifiants sans les enregistrer : le formulaire
// peut ainsi signaler une erreur avant que l'utilisateur ne valide.
func (a *API) testRegistry(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Server   string `json:"server"`
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := decode(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "JSON invalide")
		return
	}

	if !registryapi.IsDockerHub(req.Server) {
		// Les autres registres n'exposent pas d'API de connexion uniforme :
		// les identifiants ne seront validés qu'au premier pull.
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":      true,
			"checked": false,
			"message": "identifiants non vérifiables pour ce registre ; ils seront testés au premier déploiement",
		})
		return
	}

	if _, err := a.hub.Login(r.Context(), req.Username, req.Password); err != nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":      false,
			"checked": true,
			"message": err.Error(),
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"checked": true,
		"message": "connexion à docker hub réussie",
	})
}

// listRepositories liste les dépôts du compte associé à un registry.
func (a *API) listRepositories(w http.ResponseWriter, r *http.Request) {
	reg, err := a.db.GetRegistryWithPassword(r.Context(), r.PathValue("id"))
	if err != nil {
		writeErr(w, http.StatusNotFound, "registry introuvable")
		return
	}
	if !registryapi.IsDockerHub(reg.Server) {
		writeErr(w, http.StatusNotImplemented,
			"le catalogue n'est disponible que pour docker hub")
		return
	}

	// Le jeton donne accès aux dépôts privés. S'il ne peut pas être obtenu, on
	// poursuit sans : les dépôts publics du compte restent listables, ce qui
	// vaut mieux qu'une page vide.
	token, err := a.hub.Login(r.Context(), reg.Username, reg.Password)
	authenticated := err == nil
	if err != nil {
		a.log.Warn("connexion docker hub échouée, catalogue public uniquement",
			"registry", reg.Name, "err", err)
	}

	// Le compte à parcourir est celui du registry, sauf override explicite.
	namespace := r.URL.Query().Get("namespace")
	if namespace == "" {
		namespace = reg.Username
	}

	repos, err := a.hub.ListRepositories(r.Context(), namespace, token)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}

	// Sans cette résolution, l'interface proposerait « :latest » pour tous les
	// dépôts — or beaucoup ne publient pas ce tag, ce qui produirait un
	// ImagePullBackOff au déploiement.
	a.hub.ResolveDefaultTags(r.Context(), repos, token)
	writeJSON(w, http.StatusOK, map[string]any{
		"repositories": repos,
		// Permet au dashboard de signaler que les dépôts privés sont absents.
		"authenticated": authenticated,
		"namespace":     namespace,
	})
}

// listTags liste les tags d'un dépôt : ?repository=compte/nom
func (a *API) listTags(w http.ResponseWriter, r *http.Request) {
	repository := r.URL.Query().Get("repository")
	if repository == "" {
		writeErr(w, http.StatusBadRequest, "le paramètre 'repository' est requis")
		return
	}

	reg, err := a.db.GetRegistryWithPassword(r.Context(), r.PathValue("id"))
	if err != nil {
		writeErr(w, http.StatusNotFound, "registry introuvable")
		return
	}
	if !registryapi.IsDockerHub(reg.Server) {
		writeErr(w, http.StatusNotImplemented,
			"le catalogue n'est disponible que pour docker hub")
		return
	}

	// Comme pour les dépôts : sans jeton valide, les tags publics restent
	// accessibles.
	token, _ := a.hub.Login(r.Context(), reg.Username, reg.Password)

	tags, err := a.hub.ListTags(r.Context(), repository, token)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, tags)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// decode lit le corps JSON ; un corps vide est accepté et laisse la structure
// à ses valeurs par défaut.
func decode(r *http.Request, v any) error {
	err := json.NewDecoder(r.Body).Decode(v)
	if err != nil && err.Error() == "EOF" {
		return nil
	}
	return err
}

func envParam(r *http.Request) string {
	return r.URL.Query().Get("environment")
}

func limitParam(r *http.Request, def, max int) int {
	v := r.URL.Query().Get("limit")
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 || n > max {
		return def
	}
	return n
}

// fail logue la cause réelle et renvoie un message générique au client.
func (a *API) fail(w http.ResponseWriter, op string, err error) {
	a.log.Error(op, "err", err)
	writeErr(w, http.StatusInternalServerError, "erreur interne")
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

// ---------------------------------------------------------------------------
// Ports d'une application
// ---------------------------------------------------------------------------

func (a *API) listAppPorts(w http.ResponseWriter, r *http.Request) {
	orgID, _ := currentOrg(r)
	app, err := a.db.GetApp(r.Context(), orgID, r.PathValue("id"))
	if err != nil {
		writeErr(w, http.StatusNotFound, "application introuvable")
		return
	}
	writeJSON(w, http.StatusOK, app.Ports)
}

// setAppPorts remplace la liste des ports.
//
// La prise d'effet demande un nouveau déploiement : le Service et le
// Deployment ne sont reconstruits que par l'agent, sur ordre du dispatcher.
func (a *API) setAppPorts(w http.ResponseWriter, r *http.Request) {
	orgID, _ := currentOrg(r)
	appID := r.PathValue("id")

	if _, err := a.db.GetApp(r.Context(), orgID, appID); err != nil {
		writeErr(w, http.StatusNotFound, "application introuvable")
		return
	}

	var req struct {
		Ports []models.AppPort `json:"ports"`
	}
	if err := decode(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "JSON invalide")
		return
	}

	if err := a.db.SetAppPorts(r.Context(), appID, req.Ports); err != nil {
		// Les refus viennent de la validation (port invalide, deux ports
		// publics) : ce sont des erreurs de saisie, pas des pannes.
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}

	ports, err := a.db.ListAppPorts(r.Context(), appID)
	if err != nil {
		a.fail(w, "ListAppPorts", err)
		return
	}
	writeJSON(w, http.StatusOK, ports)
}

// ---------------------------------------------------------------------------
// Dépôt Git rattaché à une application
// ---------------------------------------------------------------------------

// repoOf résout le dépôt d'une application, en refusant tôt les cas où
// l'intégration ne peut rien produire.
func (a *API) repoOf(r *http.Request) (string, error) {
	if !a.git.Configured(r.Context()) {
		return "", gitapi.ErrNotConfigured
	}
	orgID, _ := currentOrg(r)
	app, err := a.db.GetApp(r.Context(), orgID, r.PathValue("id"))
	if err != nil {
		return "", err
	}
	if app.GitRepo == "" {
		return "", fmt.Errorf("aucun dépôt rattaché à cette application")
	}
	return gitapi.ParseRepo(app.GitRepo)
}

func (a *API) getAppRepo(w http.ResponseWriter, r *http.Request) {
	full, err := a.repoOf(r)
	if err != nil {
		writeErr(w, http.StatusNotFound, err.Error())
		return
	}
	repo, err := a.git.GetRepo(r.Context(), full)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, repo)
}

// setAppRepo rattache un dépôt, après avoir vérifié qu'il est accessible.
//
// Valider ici évite d'enregistrer une référence que la documentation et les
// pipelines ne sauraient pas résoudre ensuite.
func (a *API) setAppRepo(w http.ResponseWriter, r *http.Request) {
	orgID, _ := currentOrg(r)
	appID := r.PathValue("id")

	if _, err := a.db.GetApp(r.Context(), orgID, appID); err != nil {
		writeErr(w, http.StatusNotFound, "application introuvable")
		return
	}

	var req struct {
		Repo string `json:"repo"`
	}
	if err := decode(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "JSON invalide")
		return
	}

	// Détacher est toujours permis, même sans intégration configurée.
	if strings.TrimSpace(req.Repo) == "" {
		if err := a.db.SetAppRepo(r.Context(), appID, ""); err != nil {
			a.fail(w, "SetAppRepo", err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"repo": ""})
		return
	}

	full, err := gitapi.ParseRepo(req.Repo)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}

	if a.git.Configured(r.Context()) {
		if _, err := a.git.GetRepo(r.Context(), full); err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
	}

	if err := a.db.SetAppRepo(r.Context(), appID, full); err != nil {
		a.fail(w, "SetAppRepo", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"repo": full})
}

func (a *API) listAppDocs(w http.ResponseWriter, r *http.Request) {
	full, err := a.repoOf(r)
	if err != nil {
		writeErr(w, http.StatusNotFound, err.Error())
		return
	}
	docs, err := a.git.ListDocs(r.Context(), full)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, docs)
}

func (a *API) getAppDoc(w http.ResponseWriter, r *http.Request) {
	full, err := a.repoOf(r)
	if err != nil {
		writeErr(w, http.StatusNotFound, err.Error())
		return
	}
	doc, err := a.git.GetDoc(r.Context(), full, r.PathValue("path"))
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, doc)
}

func (a *API) listAppRuns(w http.ResponseWriter, r *http.Request) {
	full, err := a.repoOf(r)
	if err != nil {
		writeErr(w, http.StatusNotFound, err.Error())
		return
	}
	runs, err := a.git.ListRuns(r.Context(), full, 20)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, runs)
}

// deleteApp supprime une application.
//
// Par défaut, une application dont des environnements tournent encore est
// refusée : la cascade en base les effacerait sans rien retirer du cluster,
// laissant des namespaces que plus personne ne pilote.
//
// Avec `?cascade=true`, l'ordre de suppression est transmis à l'agent pour
// chaque environnement, namespace compris. L'application n'est PAS supprimée
// dans la foulée : `deployment_commands` référence `deployments` en cascade,
// si bien qu'effacer tout de suite emporterait les ordres avant que l'agent
// ne les ait lus. La suppression en base intervient une fois les
// environnements passés à « deleted ».
func (a *API) deleteApp(w http.ResponseWriter, r *http.Request) {
	orgID, _ := currentOrg(r)
	appID := r.PathValue("id")

	app, err := a.db.GetApp(r.Context(), orgID, appID)
	if err != nil {
		writeErr(w, http.StatusNotFound, "application introuvable")
		return
	}

	live, err := a.db.LiveDeployments(r.Context(), appID)
	if err != nil {
		a.fail(w, "LiveDeployments", err)
		return
	}

	// Le dépôt n'est supprimé que sur demande explicite, et avant de perdre la
	// référence : l'application effacée, on ne saurait plus lequel viser.
	if r.URL.Query().Get("delete_repo") == "true" && app.GitRepo != "" {
		full, perr := gitapi.ParseRepo(app.GitRepo)
		if perr == nil {
			if derr := a.git.DeleteRepo(r.Context(), full); derr != nil {
				// L'échec ne bloque pas : l'application part quand même, mais
				// l'appelant doit savoir que le dépôt reste.
				writeErr(w, http.StatusBadGateway, derr.Error())
				return
			}
			a.log.Info("dépôt supprimé", "repo", full, "app", app.Name)
		}
	}

	// Plus rien sur le cluster : la suppression est immédiate.
	if len(live) == 0 {
		if err := a.db.DeleteApp(r.Context(), orgID, appID); err != nil {
			a.fail(w, "DeleteApp", err)
			return
		}
		a.log.Info("application supprimée", "app", app.Name, "id", appID)
		w.WriteHeader(http.StatusNoContent)
		return
	}

	if r.URL.Query().Get("cascade") != "true" {
		envs := make([]string, 0, len(live))
		for _, d := range live {
			envs = append(envs, d.Environment)
		}
		writeErr(w, http.StatusConflict, fmt.Sprintf(
			"%d environnement(s) encore déployé(s) : %s. Supprimez-les d'abord, ou rappelez avec ?cascade=true",
			len(live), strings.Join(envs, ", ")))
		return
	}

	for _, d := range live {
		if _, err := a.db.CreateCommand(r.Context(), d.ID, models.CommandDelete,
			map[string]bool{"delete_namespace": true}); err != nil {
			a.fail(w, "CreateCommand", err)
			return
		}
	}

	a.log.Info("suppression des environnements demandée",
		"app", app.Name, "id", appID, "environnements", len(live))

	// 202 : la demande est prise en compte, l'agent l'exécute. L'appelant
	// rappellera pour finaliser une fois les environnements retirés.
	writeJSON(w, http.StatusAccepted, map[string]any{
		"pending_environments": len(live),
		"message": "suppression des environnements en cours ; l'application sera retirée une fois le cluster nettoyé",
	})
}

// ---------------------------------------------------------------------------
// Intégration Git : état, vérification, création
// ---------------------------------------------------------------------------

// gitStatus décrit ce que l'instance sait faire avec son jeton.
//
// Le dashboard s'en sert pour n'offrir la création de dépôt que si elle est
// possible, plutôt que de laisser l'utilisateur découvrir le refus à la
// soumission.
func (a *API) gitStatus(w http.ResponseWriter, r *http.Request) {
	if !a.git.Configured(r.Context()) {
		writeJSON(w, http.StatusOK, map[string]any{"configured": false})
		return
	}

	id, err := a.git.Whoami(r.Context())
	if err != nil {
		// Un jeton présent mais refusé doit se distinguer d'un jeton absent :
		// le message oriente vers la bonne correction.
		writeJSON(w, http.StatusOK, map[string]any{
			"configured": true,
			"valid":      false,
			"error":      err.Error(),
		})
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"configured": true,
		"valid":      true,
		"login":      id.Login,
		"can_create": id.CanCreate,
		"owners":     id.Owners,
		"scopes":     id.Scopes,
	})
}

// gitLookup vérifie qu'un dépôt existe, sans le rattacher.
func (a *API) gitLookup(w http.ResponseWriter, r *http.Request) {
	full, err := gitapi.ParseRepo(r.URL.Query().Get("repo"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}

	repo, err := a.git.GetRepo(r.Context(), full)
	if err != nil {
		writeErr(w, http.StatusNotFound, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, repo)
}

// gitCreateRepo crée un dépôt sur l'hébergeur.
//
// C'est la seule écriture que Kybers effectue sur un dépôt : elle est
// explicite, à la demande, et n'a pas lieu si le jeton ne l'autorise pas.
func (a *API) gitCreateRepo(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Owner       string `json:"owner"`
		Name        string `json:"name"`
		Description string `json:"description"`
		Private     bool   `json:"private"`
	}
	if err := decode(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "JSON invalide")
		return
	}
	if strings.TrimSpace(req.Name) == "" {
		writeErr(w, http.StatusBadRequest, "le nom du dépôt est requis")
		return
	}

	repo, err := a.git.CreateRepo(r.Context(), req.Owner, req.Name, req.Description, req.Private)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}

	a.log.Info("dépôt créé", "repo", repo.FullName)
	writeJSON(w, http.StatusCreated, repo)
}

// setGitSettings enregistre le jeton Git depuis l'interface.
//
// Le réglage est réservé aux administrateurs : il vaut pour toute l'instance.
// Une variable d'environnement, si elle existe, continue de primer — une
// instance pilotée par sa configuration ne doit pas voir son comportement
// changé depuis le dashboard.
func (a *API) setGitSettings(w http.ResponseWriter, r *http.Request) {
	actor, _ := currentUser(r)

	var req struct {
		Token  string `json:"token"`
		APIURL string `json:"api_url"`
	}
	if err := decode(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "JSON invalide")
		return
	}

	token := strings.TrimSpace(req.Token)
	if token != "" {
		// Un jeton refusé est rejeté tout de suite : l'enregistrer laisserait
		// croire l'intégration active alors que rien ne fonctionnerait.
		probe := gitapi.New(token, strings.TrimSpace(req.APIURL))
		if _, err := probe.Whoami(r.Context()); err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
	}

	if err := a.db.SetSetting(r.Context(), db.SettingGitToken, token, true, actor.ID); err != nil {
		a.fail(w, "SetSetting(git.token)", err)
		return
	}
	if err := a.db.SetSetting(r.Context(), db.SettingGitAPIURL,
		strings.TrimSpace(req.APIURL), false, actor.ID); err != nil {
		a.fail(w, "SetSetting(git.api_url)", err)
		return
	}

	a.log.Info("intégration Git configurée", "par", actor.Email, "actif", token != "")
	a.gitStatus(w, r)
}

// gitInstallWorkflow dépose un workflow dans le dépôt et y pose le jeton.
//
// C'est la seule écriture de Kybers hors création de dépôt. Le contenu vient
// de l'appelant : le dashboard propose un modèle, l'utilisateur peut le
// modifier ou fournir le sien, et Kybers ne fait que l'écrire.
func (a *API) gitInstallWorkflow(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Repo string `json:"repo"`
		Path string `json:"path"`
		/** Contenu du workflow, tel qu'il sera écrit. */
		Content string `json:"content"`
		/** Nom du jeton d'API à déposer en secret ; vide = aucun secret. */
		TokenName string `json:"token_name"`
	}
	if err := decode(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "JSON invalide")
		return
	}

	full, err := gitapi.ParseRepo(req.Repo)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if strings.TrimSpace(req.Content) == "" {
		writeErr(w, http.StatusBadRequest, "le contenu du workflow est requis")
		return
	}

	path := strings.TrimSpace(req.Path)
	if path == "" {
		path = ".github/workflows/kybers-deploy.yml"
	}

	// Le jeton est créé avant l'écriture : un workflow déposé sans secret
	// échouerait au premier déclenchement.
	var secretPosted bool
	if req.TokenName != "" {
		user, _ := currentUser(r)
		orgID, _ := currentOrg(r)

		token, prefix, err := auth.GenerateAPIToken()
		if err != nil {
			a.fail(w, "GenerateAPIToken", err)
			return
		}
		// Un an : le workflow doit survivre au-delà d'un cycle de release.
		expires := time.Now().AddDate(1, 0, 0)
		if _, err := a.db.CreateAPIToken(r.Context(), user.ID, orgID, req.TokenName,
			auth.HashToken(token), prefix, &expires); err != nil {
			a.fail(w, "CreateAPIToken", err)
			return
		}
		if err := a.git.PutSecret(r.Context(), full, "KYBERS_TOKEN", token); err != nil {
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}
		secretPosted = true
	}

	if err := a.git.PutFile(r.Context(), full, path, req.Content,
		"ci: déploiement Kybers"); err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}

	a.log.Info("workflow installé", "repo", full, "chemin", path, "secret", secretPosted)
	writeJSON(w, http.StatusOK, map[string]any{
		"repo":   full,
		"path":   path,
		"secret": secretPosted,
	})
}

// gitReadFile lit un fichier du dépôt, en texte brut.
//
// Sert à éditer un fichier existant sans quitter Kybers : sans son contenu
// actuel, on ne pourrait que l'écraser.
func (a *API) gitReadFile(w http.ResponseWriter, r *http.Request) {
	full, err := gitapi.ParseRepo(r.URL.Query().Get("repo"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}

	path := strings.TrimSpace(r.URL.Query().Get("path"))
	if path == "" {
		writeErr(w, http.StatusBadRequest, "le chemin est requis")
		return
	}

	content, err := a.git.ReadFile(r.Context(), full, path)
	if err != nil {
		// Un fichier absent n'est pas une panne : l'appelant en créera un.
		writeJSON(w, http.StatusOK, map[string]any{
			"path": path, "content": "", "exists": false,
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"path": path, "content": content, "exists": true,
	})
}

// gitWriteFile écrit un fichier ordinaire du dépôt.
//
// Distincte de l'installation de workflow : celle-ci crée aussi un jeton et
// vise un chemin réservé, que GitHub protège par une portée dédiée.
func (a *API) gitWriteFile(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Repo    string `json:"repo"`
		Path    string `json:"path"`
		Content string `json:"content"`
		Message string `json:"message"`
	}
	if err := decode(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "JSON invalide")
		return
	}

	full, err := gitapi.ParseRepo(req.Repo)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}

	path := strings.TrimSpace(req.Path)
	if path == "" {
		writeErr(w, http.StatusBadRequest, "le chemin est requis")
		return
	}
	// Les workflows passent par leur route dédiée : elle gère le jeton et
	// annonce la portée particulière qu'ils exigent.
	if strings.HasPrefix(path, ".github/workflows/") {
		writeErr(w, http.StatusBadRequest,
			"utilisez la route d'installation de pipeline pour les workflows")
		return
	}

	message := strings.TrimSpace(req.Message)
	if message == "" {
		message = "docs: mise à jour depuis Kybers"
	}

	if err := a.git.PutFile(r.Context(), full, path, req.Content, message); err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}

	a.log.Info("fichier écrit", "repo", full, "chemin", path)
	writeJSON(w, http.StatusOK, map[string]any{"repo": full, "path": path})
}

// ---------------------------------------------------------------------------
// Modèles de fichiers
// ---------------------------------------------------------------------------

func (a *API) listTemplates(w http.ResponseWriter, r *http.Request) {
	orgID, _ := currentOrg(r)

	// Les modèles fournis sont insérés à la première consultation : l'équipe
	// les retrouve dans sa bibliothèque, modifiables comme les siens.
	if err := a.db.SeedTemplates(r.Context(), orgID); err != nil {
		a.log.Error("SeedTemplates", "err", err)
	}

	list, err := a.db.ListTemplates(r.Context(), orgID, r.URL.Query().Get("kind"))
	if err != nil {
		a.fail(w, "ListTemplates", err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

// saveTemplate crée ou met à jour un modèle, selon la présence d'un id dans
// le chemin : les deux gestes partagent la même validation.
func (a *API) saveTemplate(w http.ResponseWriter, r *http.Request) {
	orgID, _ := currentOrg(r)
	user, _ := currentUser(r)

	var t models.FileTemplate
	if err := decode(r, &t); err != nil {
		writeErr(w, http.StatusBadRequest, "JSON invalide")
		return
	}
	// L'identifiant vient du chemin, jamais du corps : sans cela, une requête
	// pourrait viser un modèle d'une autre organisation.
	t.ID = r.PathValue("id")

	saved, err := a.db.SaveTemplate(r.Context(), orgID, user.ID, t)
	if err != nil {
		if isNotFound(err) {
			writeErr(w, http.StatusNotFound, "modèle introuvable")
			return
		}
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}

	status := http.StatusOK
	if t.ID == "" {
		status = http.StatusCreated
	}
	writeJSON(w, status, saved)
}

func (a *API) deleteTemplate(w http.ResponseWriter, r *http.Request) {
	orgID, _ := currentOrg(r)
	if err := a.db.DeleteTemplate(r.Context(), orgID, r.PathValue("id")); err != nil {
		if isNotFound(err) {
			writeErr(w, http.StatusNotFound, "modèle introuvable")
			return
		}
		a.fail(w, "DeleteTemplate", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// gitWriteFiles écrit plusieurs fichiers en un appel.
//
// C'est ce que fait la création d'application : la liste des modèles cochés
// part en une fois, plutôt qu'un aller-retour par fichier. Un jeton d'API est
// créé si l'un des fichiers en a besoin — un workflow sans secret échouerait
// à son premier déclenchement.
func (a *API) gitWriteFiles(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Repo  string `json:"repo"`
		Files []struct {
			Path    string `json:"path"`
			Content string `json:"content"`
		} `json:"files"`
		TokenName string `json:"token_name"`
	}
	if err := decode(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "JSON invalide")
		return
	}

	full, err := gitapi.ParseRepo(req.Repo)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(req.Files) == 0 {
		writeErr(w, http.StatusBadRequest, "aucun fichier à écrire")
		return
	}

	// Le secret précède les fichiers : un workflow déposé sans lui serait
	// immédiatement en échec.
	needsToken := req.TokenName != ""
	if needsToken {
		user, _ := currentUser(r)
		orgID, _ := currentOrg(r)

		token, prefix, err := auth.GenerateAPIToken()
		if err != nil {
			a.fail(w, "GenerateAPIToken", err)
			return
		}
		expires := time.Now().AddDate(1, 0, 0)
		if _, err := a.db.CreateAPIToken(r.Context(), user.ID, orgID, req.TokenName,
			auth.HashToken(token), prefix, &expires); err != nil {
			a.fail(w, "CreateAPIToken", err)
			return
		}
		if err := a.git.PutSecret(r.Context(), full, "KYBERS_TOKEN", token); err != nil {
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}
	}

	// Chaque fichier est tenté ; un échec n'annule pas les précédents, mais il
	// est remonté pour que l'appelant sache quoi reprendre.
	written := []string{}
	failures := map[string]string{}
	for _, f := range req.Files {
		path := strings.TrimSpace(f.Path)
		if path == "" {
			continue
		}
		if err := a.git.PutFile(r.Context(), full, path, f.Content,
			"chore: initialisation depuis Kybers"); err != nil {
			failures[path] = err.Error()
			continue
		}
		written = append(written, path)
	}

	a.log.Info("fichiers écrits", "repo", full,
		"écrits", len(written), "échecs", len(failures))
	writeJSON(w, http.StatusOK, map[string]any{
		"repo":     full,
		"written":  written,
		"failures": failures,
		"secret":   needsToken,
	})
}

// ---------------------------------------------------------------------------
// Dossiers de modèles
// ---------------------------------------------------------------------------

func (a *API) listFolders(w http.ResponseWriter, r *http.Request) {
	orgID, _ := currentOrg(r)
	list, err := a.db.ListFolders(r.Context(), orgID)
	if err != nil {
		a.fail(w, "ListFolders", err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func (a *API) saveFolder(w http.ResponseWriter, r *http.Request) {
	orgID, _ := currentOrg(r)

	var f models.TemplateFolder
	if err := decode(r, &f); err != nil {
		writeErr(w, http.StatusBadRequest, "JSON invalide")
		return
	}
	// L'identifiant vient du chemin : le corps ne doit pas pouvoir viser le
	// dossier d'une autre organisation.
	f.ID = r.PathValue("id")

	saved, err := a.db.SaveFolder(r.Context(), orgID, f)
	if err != nil {
		if isNotFound(err) {
			writeErr(w, http.StatusNotFound, "dossier introuvable")
			return
		}
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}

	status := http.StatusOK
	if f.ID == "" {
		status = http.StatusCreated
	}
	writeJSON(w, status, saved)
}

func (a *API) deleteFolder(w http.ResponseWriter, r *http.Request) {
	orgID, _ := currentOrg(r)
	if err := a.db.DeleteFolder(r.Context(), orgID, r.PathValue("id")); err != nil {
		if isNotFound(err) {
			writeErr(w, http.StatusNotFound, "dossier introuvable")
			return
		}
		a.fail(w, "DeleteFolder", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
