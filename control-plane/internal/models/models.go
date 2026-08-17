// Package models contient les entités métier persistées par le Control Plane.
package models

import (
	"encoding/json"
	"time"
)

// Statuts possibles d'un déploiement, du plus précoce au terminal.
const (
	StatusPending      = "pending"      // enregistré, pas encore envoyé à un agent
	StatusDispatched   = "dispatched"   // transmis à l'agent via le stream gRPC
	StatusProvisioning = "provisioning" // l'agent applique les ressources K8s
	StatusRunning      = "running"      // pods prêts
	StatusFailed       = "failed"
	StatusStopped      = "stopped" // scalé à zéro volontairement
	StatusDeleted      = "deleted"
)

// Types de commandes de cycle de vie.
const (
	CommandScale   = "scale"
	CommandRestart = "restart"
	CommandDelete  = "delete"
)

// Statuts d'une commande.
const (
	CmdPending = "pending"
	CmdSent    = "sent"
	CmdDone    = "done"
	CmdFailed  = "failed"
)

type Cluster struct {
	ID        string     `json:"id"`
	Name      string     `json:"name"`
	Connected bool       `json:"connected"`
	LastSeen  *time.Time `json:"last_seen,omitempty"`
}

type App struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	GitRepo   string  `json:"git_repo"`
	ClusterID *string `json:"cluster_id,omitempty"`
	// ContainerPort reste le port principal : c'est celui qu'expose l'Ingress.
	// Conservé pour les clients de l'API qui ne connaissent pas encore Ports.
	ContainerPort int       `json:"container_port"`
	Ports         []AppPort `json:"ports,omitempty"`
	CreatedAt     time.Time `json:"created_at"`
}

// AppPort est un port ouvert par l'image.
//
// Une image peut en ouvrir plusieurs — un port applicatif et un port de
// métriques, par exemple. Tous sont joignables dans le cluster ; un seul est
// routé par l'Ingress, l'hôte public ne pouvant désigner qu'une destination.
type AppPort struct {
	Port int `json:"port"`
	/** Nom Kubernetes (http, metrics, grpc…) ; sert de cible aux probes. */
	Name string `json:"name"`
	/** Port routé par l'Ingress. Au plus un par application. */
	Exposed  bool   `json:"exposed"`
	Protocol string `json:"protocol"`
}

/** ExposedPort retourne le port public, ou le premier à défaut. */
func (a App) ExposedPort() int {
	for _, p := range a.Ports {
		if p.Exposed {
			return p.Port
		}
	}
	if len(a.Ports) > 0 {
		return a.Ports[0].Port
	}
	return a.ContainerPort
}

type Deployment struct {
	ID          string          `json:"id"`
	AppID       string          `json:"app_id"`
	AppName     string          `json:"app_name,omitempty"`
	Environment string          `json:"environment"`
	Image       string          `json:"image"`
	Replicas    int             `json:"replicas"`
	Host        string          `json:"host"`
	Status      string          `json:"status"`
	Message     string          `json:"message"`
	Reason      string          `json:"reason,omitempty"`
	URL         string          `json:"url"`
	Revision    int             `json:"revision"`
	RolledBack  *string         `json:"rolled_back_from,omitempty"`
	Snapshot    json.RawMessage `json:"-"`

	// Provenance, renseignée par l'appelant (CI, CLI, dashboard). Kybers ne
	// construit pas les images : ces champs servent uniquement à savoir quel
	// code tourne, et ne déclenchent rien.
	Provenance

	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// Provenance décrit l'origine d'une révision : d'où vient l'image déployée.
type Provenance struct {
	/** Commit SHA à partir duquel l'image a été construite. */
	GitCommit string `json:"git_commit,omitempty"`
	/** Branche ou tag Git, tel que fourni par le CI. */
	GitRef string `json:"git_ref,omitempty"`
	/** Message du commit, pour situer la révision sans quitter Kybers. */
	GitMessage string `json:"git_message,omitempty"`
	/** Origine du déclenchement : « ci », « cli », « dashboard ». */
	Source string `json:"source,omitempty"`
}

// FileTemplate est un modèle de fichier écrit dans un dépôt.
//
// Les placeholders {{app}}, {{repo}}, {{env}} et {{endpoint}} sont substitués
// à l'écriture : un même modèle sert ainsi toutes les applications.
type TemplateFolder struct {
	ID          string `json:"id"`
	OrgID       string `json:"org_id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	/** Nombre de modèles qu'il contient, pour l'affichage. */
	FileCount int `json:"file_count"`

	// Golden path : le dossier devient un type d'application proposé à la
	// création. Ses réglages sont recopiés dans l'application, qui les possède
	// ensuite — les modifier ici ne retouche rien d'existant.
	IsGoldenPath bool   `json:"is_golden_path"`
	Icon         string `json:"icon"`
	/** Image dont les tags font les versions : "node", "python", "golang". */
	RuntimeImage string `json:"runtime_image"`
	/** Versions de repli, si l'image est absente ou le registre injoignable. */
	Versions string `json:"versions"`
	/** Version retenue par défaut, parmi celles proposées. */
	DefaultVersion string `json:"default_version"`
	/** Port écouté par l'exécution ; 0 = défaut de l'instance. */
	DefaultPort   int    `json:"default_port"`
	CPURequest    string `json:"cpu_request"`
	MemoryRequest string `json:"memory_request"`
	CPULimit      string `json:"cpu_limit"`
	MemoryLimit   string `json:"memory_limit"`
	/** Chemin de la sonde HTTP ; vide = pas de sonde préconfigurée. */
	ProbePath string `json:"probe_path"`
	/** Délai avant la première sonde, en secondes. */
	ProbeInitialDelay int `json:"probe_initial_delay"`
	/** UID non-root imposé par l'image de base ; 0 = non contraint. */
	RunAsUser int `json:"run_as_user"`

	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type FileTemplate struct {
	ID    string `json:"id"`
	OrgID string `json:"org_id"`
	/** Dossier d'appartenance ; vide = racine. */
	FolderID    string `json:"folder_id,omitempty"`
	Name        string `json:"name"`
	Description string `json:"description"`
	/** « pipeline », « readme » ou « fichier ». */
	Kind string `json:"kind"`
	/** Chemin de destination dans le dépôt. */
	Path    string `json:"path"`
	Content string `json:"content"`
	/** Proposé en premier pour sa catégorie ; un seul par organisation. */
	IsDefault bool      `json:"is_default"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type EnvVar struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

type LogLine struct {
	PodName string    `json:"pod_name"`
	Line    string    `json:"line"`
	TS      time.Time `json:"ts"`
}

type Event struct {
	PodName string    `json:"pod_name"`
	Type    string    `json:"type"`
	Reason  string    `json:"reason"`
	Message string    `json:"message"`
	TS      time.Time `json:"ts"`
}

// Registry : identifiants d'un registre d'images privé. Password n'est jamais
// sérialisé vers le client — seul l'agent le reçoit, via gRPC.
type Registry struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Server    string    `json:"server"`
	Username  string    `json:"username"`
	Password  string    `json:"-"`
	Email     string    `json:"email"`
	CreatedAt time.Time `json:"created_at"`
}

// Probe décrit une sonde de santé Kubernetes.
// Type vide ou "none" = sonde désactivée.
type Probe struct {
	Type             string   `json:"type"` // http | tcp | exec
	Path             string   `json:"path,omitempty"`
	Port             int      `json:"port,omitempty"`
	InitialDelaySecs int      `json:"initial_delay_seconds,omitempty"`
	PeriodSecs       int      `json:"period_seconds,omitempty"`
	TimeoutSecs      int      `json:"timeout_seconds,omitempty"`
	FailureThreshold int      `json:"failure_threshold,omitempty"`
	Command          []string `json:"command,omitempty"`
}

func (p *Probe) Enabled() bool {
	return p != nil && p.Type != "" && p.Type != "none"
}

// AppConfig : configuration d'exécution d'une application dans un environnement.
type AppConfig struct {
	AppID       string `json:"app_id"`
	Environment string `json:"environment"`

	RegistryID   *string `json:"registry_id,omitempty"`
	RegistryName string  `json:"registry_name,omitempty"`

	CPURequest    string `json:"cpu_request"`
	MemoryRequest string `json:"memory_request"`
	CPULimit      string `json:"cpu_limit"`
	MemoryLimit   string `json:"memory_limit"`

	AutoscalingEnabled bool `json:"autoscaling_enabled"`
	AutoscalingMin     int  `json:"autoscaling_min"`
	AutoscalingMax     int  `json:"autoscaling_max"`
	AutoscalingCPU     int  `json:"autoscaling_cpu_percent"`

	LivenessProbe  *Probe `json:"liveness_probe,omitempty"`
	ReadinessProbe *Probe `json:"readiness_probe,omitempty"`
	StartupProbe   *Probe `json:"startup_probe,omitempty"`

	NetworkPolicy bool   `json:"network_policy"`
	QuotaCPU      string `json:"quota_cpu"`
	QuotaMemory   string `json:"quota_memory"`
	QuotaPods     int    `json:"quota_pods"`

	// Durcissement du conteneur. Opt-in : la plupart des images publiques
	// (nginx, postgres, redis) tournent en root et seraient refusées si ces
	// options étaient actives par défaut.
	RunAsNonRoot   bool  `json:"run_as_non_root"`
	RunAsUser      int64 `json:"run_as_user"`
	ReadOnlyRootFS bool  `json:"read_only_root_fs"`

	UpdatedAt time.Time `json:"updated_at"`
}

// DefaultAppConfig fournit les valeurs appliquées tant qu'aucune configuration
// n'a été enregistrée pour un couple (application, environnement).
func DefaultAppConfig(appID, env string) AppConfig {
	return AppConfig{
		AppID:              appID,
		Environment:        env,
		CPURequest:         "50m",
		MemoryRequest:      "64Mi",
		CPULimit:           "500m",
		MemoryLimit:        "512Mi",
		AutoscalingEnabled: false,
		AutoscalingMin:     1,
		AutoscalingMax:     5,
		AutoscalingCPU:     80,
		// Sans sonde, un conteneur dont le processus reste vivant sans écouter
		// (échec de démarrage applicatif) est déclaré prêt à tort, et l'URL
		// publique renvoie 502. La sonde TCP vérifie qu'un service écoute
		// réellement, sans supposer de route HTTP particulière.
		ReadinessProbe: &Probe{
			Type:             "tcp",
			InitialDelaySecs: 5,
			PeriodSecs:       10,
			FailureThreshold: 6,
		},
	}
}

// Command : ordre de cycle de vie envoyé à l'agent (scale, restart, delete).
type Command struct {
	ID           string          `json:"id"`
	DeploymentID string          `json:"deployment_id"`
	Kind         string          `json:"kind"`
	Payload      json.RawMessage `json:"payload"`
	Status       string          `json:"status"`
	Message      string          `json:"message"`
	CreatedAt    time.Time       `json:"created_at"`
}

// ---------------------------------------------------------------------------
// Identité et organisations
// ---------------------------------------------------------------------------

// User : le hash du mot de passe n'y figure pas — il ne quitte jamais la
// couche d'authentification.
type User struct {
	ID          string     `json:"id"`
	Email       string     `json:"email"`
	Name        string     `json:"name"`
	CreatedAt   time.Time  `json:"created_at"`
	LastLoginAt *time.Time `json:"last_login_at,omitempty"`
	// IsAdmin : administrateur de la plateforme, distinct du rôle dans une
	// organisation. Nommé par le super-admin, en nombre libre.
	IsAdmin bool `json:"is_admin"`
	// IsSuperAdmin : compte unique créé à l'installation. Il seul peut nommer
	// des administrateurs, et personne ne peut le modifier — pas même un autre
	// administrateur. Ce statut ne s'attribue jamais après coup.
	IsSuperAdmin bool `json:"is_superadmin"`
	// MustChangePassword : mot de passe temporaire fixé par un admin ; tant
	// qu'il est vrai, seul le changement de mot de passe est autorisé.
	MustChangePassword bool `json:"must_change_password"`
	Disabled           bool `json:"disabled"`
}

type Organization struct {
	ID        string    `json:"id"`
	Slug      string    `json:"slug"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"created_at"`
	// Role : rôle de l'utilisateur courant dans cette organisation, renseigné
	// lors d'une liste personnelle.
	Role string `json:"role,omitempty"`
	// MemberCount et AppCount : renseignés dans la vue d'administration.
	// Sans omitempty, car un zéro est une information : une organisation sans
	// application est justement celle qu'on peut supprimer.
	MemberCount int `json:"member_count"`
	AppCount    int `json:"app_count"`
}

type Member struct {
	UserID string `json:"user_id"`
	Email  string `json:"email"`
	Name   string `json:"name"`
	Role   string `json:"role"`
	// IsAdmin / IsSuperAdmin : statut PLATEFORME du membre. Il prime sur son
	// rôle dans l'organisation, et l'interface doit le connaître pour ne pas
	// proposer une action que l'API refusera.
	IsAdmin      bool      `json:"is_admin"`
	IsSuperAdmin bool      `json:"is_superadmin"`
	JoinedAt     time.Time `json:"joined_at"`
}

// APIToken ne contient jamais le jeton en clair : seul son préfixe permet de
// l'identifier dans une liste.
type APIToken struct {
	ID         string     `json:"id"`
	Name       string     `json:"name"`
	Prefix     string     `json:"prefix"`
	ExpiresAt  *time.Time `json:"expires_at,omitempty"`
	LastUsedAt *time.Time `json:"last_used_at,omitempty"`
	CreatedAt  time.Time  `json:"created_at"`
}
