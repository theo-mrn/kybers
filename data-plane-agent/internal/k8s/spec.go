package k8s

import (
	"fmt"
	"strings"
)

// Labels appliqués à toutes les ressources gérées par Kybers. Ils servent de
// critère de sélection pour les Services et de marqueur d'appartenance.
const (
	LabelManagedBy  = "app.kubernetes.io/managed-by"
	LabelAppName    = "app.kubernetes.io/name"
	LabelInstance   = "app.kubernetes.io/instance"
	LabelDeployment = "kybers.io/deployment-id"
	ManagedByValue  = "kybers"
)

// Types de sondes supportés.
const (
	ProbeHTTP = "http"
	ProbeTCP  = "tcp"
	ProbeExec = "exec"
)

// Probe décrit une sonde de santé. Type vide = sonde désactivée.
type Probe struct {
	Type             string
	Path             string
	Port             int32
	InitialDelaySecs int32
	PeriodSecs       int32
	TimeoutSecs      int32
	FailureThreshold int32
	Command          []string
}

func (p *Probe) Enabled() bool {
	return p != nil && p.Type != "" && p.Type != "none"
}

// Resources : requests/limits au format Kubernetes ("100m", "256Mi").
// Un champ vide signifie « ne pas positionner cette contrainte ».
type Resources struct {
	CPURequest    string
	MemoryRequest string
	CPULimit      string
	MemoryLimit   string
}

type Autoscaling struct {
	Enabled          bool
	MinReplicas      int32
	MaxReplicas      int32
	TargetCPUPercent int32
}

// RegistryCredentials génère un imagePullSecret. Server vide = image publique.
type RegistryCredentials struct {
	Server   string
	Username string
	Password string
	Email    string
}

func (r *RegistryCredentials) Enabled() bool {
	return r != nil && r.Server != "" && r.Username != ""
}

// Spec est la forme interne d'un ordre de déploiement, découplée du protobuf.
type Spec struct {
	DeploymentID  string
	AppName       string
	Environment   string
	Image         string
	Replicas      int32
	// ContainerPort reste le port principal ; Ports le détaille quand l'image
	// en ouvre plusieurs.
	ContainerPort int32
	Ports         []Port

	// Variables non sensibles : injectées via ConfigMap.
	Env map[string]string
	// Variables sensibles : injectées via Secret, jamais dans le PodSpec.
	SecretEnv map[string]string

	Host string
	// TLS active le certificat sur l'Ingress. Sans domaine maîtrisé (nip.io),
	// demander un certificat Let's Encrypt échouerait.
	TLS bool

	LivenessProbe  *Probe
	ReadinessProbe *Probe
	StartupProbe   *Probe

	Resources   Resources
	Autoscaling Autoscaling
	Registry    *RegistryCredentials

	NetworkPolicy bool
	QuotaCPU      string
	QuotaMemory   string
	QuotaPods     int32

	// RunAsNonRoot impose au conteneur de tourner sous un utilisateur non root.
	// Désactivé par défaut : beaucoup d'images courantes (nginx, postgres,
	// redis) démarrent en root et seraient refusées par le kubelet.
	RunAsNonRoot bool
	// RunAsUser force un UID précis. 0 = laisser l'image décider.
	RunAsUser int64
	// ReadOnlyRootFilesystem monte le système de fichiers racine en lecture
	// seule. Désactivé par défaut : incompatible avec les images qui écrivent
	// dans /tmp ou /var/run sans volume dédié.
	ReadOnlyRootFilesystem bool
}

// Namespace applique la règle d'isolation : un namespace par couple
// (application, environnement). Ex : "billing-api" + "prod" -> "billing-api-prod".
// Port décrit un port ouvert par le conteneur.
type Port struct {
	Port int32
	/** Nom Kubernetes : requis dès qu'un Service en porte plusieurs. */
	Name string
	/** Port routé par l'Ingress. Au plus un par déploiement. */
	Exposed  bool
	Protocol string
}

// EffectivePorts normalise la liste des ports à créer.
//
// Un agent peut recevoir un ordre sans `ports` — c'est le cas des déploiements
// antérieurs au multi-port : on retombe alors sur le port unique.
func (s Spec) EffectivePorts() []Port {
	if len(s.Ports) == 0 {
		return []Port{{Port: s.ContainerPort, Name: "http", Exposed: true, Protocol: "TCP"}}
	}

	out := make([]Port, 0, len(s.Ports))
	exposed := false
	for _, p := range s.Ports {
		if p.Port <= 0 {
			continue
		}
		if p.Name == "" {
			p.Name = fmt.Sprintf("port-%d", p.Port)
		}
		if p.Protocol != "UDP" {
			p.Protocol = "TCP"
		}
		if p.Exposed {
			// Deux ports publics rendraient la cible de l'Ingress ambiguë :
			// seul le premier est retenu.
			if exposed {
				p.Exposed = false
			}
			exposed = true
		}
		out = append(out, p)
	}
	if len(out) == 0 {
		return []Port{{Port: s.ContainerPort, Name: "http", Exposed: true, Protocol: "TCP"}}
	}
	// Sans port explicitement public, le premier tient ce rôle : l'Ingress doit
	// pointer quelque part.
	if !exposed {
		out[0].Exposed = true
	}
	return out
}

// ExposedPort retourne le port routé par l'Ingress.
func (s Spec) ExposedPort() int32 {
	for _, p := range s.EffectivePorts() {
		if p.Exposed {
			return p.Port
		}
	}
	return s.ContainerPort
}

func (s Spec) Namespace() string {
	return sanitize(fmt.Sprintf("%s-%s", s.AppName, s.Environment))
}

// ResourceName est le nom partagé par le Deployment, le Service et l'Ingress.
func (s Spec) ResourceName() string {
	return sanitize(s.AppName)
}

// ConfigMapName / SecretName / PullSecretName dérivent du nom de l'application
// pour rester stables d'un déploiement à l'autre.
func (s Spec) ConfigMapName() string  { return s.ResourceName() + "-config" }
func (s Spec) SecretName() string     { return s.ResourceName() + "-secrets" }
func (s Spec) PullSecretName() string { return s.ResourceName() + "-registry" }

// sanitize produit un nom conforme RFC 1123 (labels DNS) exigé par Kubernetes.
func sanitize(in string) string {
	out := strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '-':
			return r
		case r >= 'A' && r <= 'Z':
			return r + 32 // en minuscule
		default:
			return '-'
		}
	}, in)
	out = strings.Trim(out, "-")
	if len(out) > 63 {
		out = strings.Trim(out[:63], "-")
	}
	if out == "" {
		out = "app"
	}
	return out
}
