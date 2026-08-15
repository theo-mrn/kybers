package k8s

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func baseSpec() Spec {
	return Spec{
		DeploymentID:  "dep-1",
		AppName:       "demo",
		Environment:   "staging",
		Image:         "ghcr.io/org/demo:1.0",
		Replicas:      1,
		ContainerPort: 8080,
	}
}

// Les variables sensibles doivent atterrir dans un Secret et être référencées
// via envFrom : jamais inscrites en clair dans le PodSpec.
func TestSecretsHorsDuPodSpec(t *testing.T) {
	r := testReconciler()
	ctx := context.Background()

	s := baseSpec()
	s.Env = map[string]string{"LOG_LEVEL": "info"}
	s.SecretEnv = map[string]string{"DATABASE_PASSWORD": "s3cr3t"}

	if err := r.Apply(ctx, s); err != nil {
		t.Fatal(err)
	}
	ns := s.Namespace()

	dep, err := r.Client.AppsV1().Deployments(ns).Get(ctx, "demo", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	c := dep.Spec.Template.Spec.Containers[0]

	for _, e := range c.Env {
		if e.Value == "s3cr3t" {
			t.Fatal("le secret apparaît en clair dans le PodSpec")
		}
	}
	if len(c.EnvFrom) != 2 {
		t.Fatalf("envFrom = %d sources, attendu 2 (ConfigMap + Secret)", len(c.EnvFrom))
	}

	sec, err := r.Client.CoreV1().Secrets(ns).Get(ctx, s.SecretName(), metav1.GetOptions{})
	if err != nil {
		t.Fatalf("secret absent: %v", err)
	}
	if sec.StringData["DATABASE_PASSWORD"] != "s3cr3t" {
		t.Error("le secret n'a pas été enregistré")
	}

	cm, err := r.Client.CoreV1().ConfigMaps(ns).Get(ctx, s.ConfigMapName(), metav1.GetOptions{})
	if err != nil {
		t.Fatalf("configmap absente: %v", err)
	}
	if cm.Data["LOG_LEVEL"] != "info" {
		t.Error("la variable non sensible devrait être dans la ConfigMap")
	}
}

func TestImagePullSecret(t *testing.T) {
	r := testReconciler()
	ctx := context.Background()

	s := baseSpec()
	s.Registry = &RegistryCredentials{
		Server: "ghcr.io", Username: "bot", Password: "token123", Email: "bot@exemple.fr",
	}

	if err := r.Apply(ctx, s); err != nil {
		t.Fatal(err)
	}
	ns := s.Namespace()

	sec, err := r.Client.CoreV1().Secrets(ns).Get(ctx, s.PullSecretName(), metav1.GetOptions{})
	if err != nil {
		t.Fatalf("pull secret absent: %v", err)
	}
	if sec.Type != corev1.SecretTypeDockerConfigJson {
		t.Errorf("type = %q, attendu dockerconfigjson", sec.Type)
	}

	var cfg struct {
		Auths map[string]struct {
			Username string `json:"username"`
			Auth     string `json:"auth"`
		} `json:"auths"`
	}
	if err := json.Unmarshal(sec.Data[corev1.DockerConfigJsonKey], &cfg); err != nil {
		t.Fatal(err)
	}
	if cfg.Auths["ghcr.io"].Username != "bot" {
		t.Error("identifiants du registry absents")
	}
	if cfg.Auths["ghcr.io"].Auth == "" {
		t.Error("le champ auth encodé est vide")
	}

	dep, _ := r.Client.AppsV1().Deployments(ns).Get(ctx, "demo", metav1.GetOptions{})
	if len(dep.Spec.Template.Spec.ImagePullSecrets) != 1 {
		t.Fatal("le Deployment doit référencer l'imagePullSecret")
	}

	// Repasser sur une image publique doit retirer le secret.
	s.Registry = nil
	if err := r.Apply(ctx, s); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Client.CoreV1().Secrets(ns).Get(ctx, s.PullSecretName(), metav1.GetOptions{}); err == nil {
		t.Error("le pull secret aurait dû être supprimé")
	}
}

func TestProbes(t *testing.T) {
	r := testReconciler()
	ctx := context.Background()

	s := baseSpec()
	s.ReadinessProbe = &Probe{Type: ProbeHTTP, Path: "/healthz", PeriodSecs: 10}
	s.LivenessProbe = &Probe{Type: ProbeTCP}
	s.StartupProbe = &Probe{Type: ProbeExec, Command: []string{"cat", "/tmp/ready"}}

	if err := r.Apply(ctx, s); err != nil {
		t.Fatal(err)
	}
	dep, _ := r.Client.AppsV1().Deployments(s.Namespace()).Get(ctx, "demo", metav1.GetOptions{})
	c := dep.Spec.Template.Spec.Containers[0]

	if c.ReadinessProbe == nil || c.ReadinessProbe.HTTPGet == nil {
		t.Fatal("readiness probe HTTP absente")
	}
	if c.ReadinessProbe.HTTPGet.Path != "/healthz" {
		t.Errorf("path = %q", c.ReadinessProbe.HTTPGet.Path)
	}
	// Port non précisé : celui du conteneur doit être repris.
	if got := c.ReadinessProbe.HTTPGet.Port.IntVal; got != 8080 {
		t.Errorf("port = %d, attendu 8080", got)
	}
	if c.LivenessProbe == nil || c.LivenessProbe.TCPSocket == nil {
		t.Error("liveness probe TCP absente")
	}
	if c.StartupProbe == nil || c.StartupProbe.Exec == nil {
		t.Error("startup probe exec absente")
	}
}

func TestProbeDesactivee(t *testing.T) {
	if buildProbe(nil, 8080) != nil {
		t.Error("une probe nil doit être ignorée")
	}
	if buildProbe(&Probe{Type: "none"}, 8080) != nil {
		t.Error("le type 'none' doit désactiver la probe")
	}
	// Une sonde exec sans commande est inapplicable.
	if buildProbe(&Probe{Type: ProbeExec}, 8080) != nil {
		t.Error("une probe exec sans commande doit être ignorée")
	}
}

func TestResourcesPersonnalisees(t *testing.T) {
	r := testReconciler()
	ctx := context.Background()

	s := baseSpec()
	s.Resources = Resources{
		CPURequest: "100m", MemoryRequest: "128Mi",
		CPULimit: "1", MemoryLimit: "1Gi",
	}
	if err := r.Apply(ctx, s); err != nil {
		t.Fatal(err)
	}
	dep, _ := r.Client.AppsV1().Deployments(s.Namespace()).Get(ctx, "demo", metav1.GetOptions{})
	res := dep.Spec.Template.Spec.Containers[0].Resources

	if got := res.Requests.Cpu().String(); got != "100m" {
		t.Errorf("cpu request = %q", got)
	}
	if got := res.Limits.Memory().String(); got != "1Gi" {
		t.Errorf("memory limit = %q", got)
	}
}

func TestResourcesInvalidesRejetees(t *testing.T) {
	if _, err := buildResources(Resources{CPURequest: "pas-une-quantité"}); err == nil {
		t.Error("une quantité invalide doit produire une erreur")
	}
}

func TestHPACreeEtSupprime(t *testing.T) {
	r := testReconciler()
	ctx := context.Background()

	s := baseSpec()
	s.Autoscaling = Autoscaling{Enabled: true, MinReplicas: 2, MaxReplicas: 8, TargetCPUPercent: 70}
	if err := r.Apply(ctx, s); err != nil {
		t.Fatal(err)
	}

	hpa, err := r.Client.AutoscalingV2().HorizontalPodAutoscalers(s.Namespace()).
		Get(ctx, "demo", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("HPA absent: %v", err)
	}
	if *hpa.Spec.MinReplicas != 2 || hpa.Spec.MaxReplicas != 8 {
		t.Errorf("bornes = %d/%d", *hpa.Spec.MinReplicas, hpa.Spec.MaxReplicas)
	}

	// Désactiver l'autoscaling doit retirer le HPA, sinon il continuerait à
	// piloter les replicas.
	s.Autoscaling.Enabled = false
	if err := r.Apply(ctx, s); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Client.AutoscalingV2().HorizontalPodAutoscalers(s.Namespace()).
		Get(ctx, "demo", metav1.GetOptions{}); err == nil {
		t.Error("le HPA aurait dû être supprimé")
	}
}

func TestNetworkPolicyEtQuota(t *testing.T) {
	r := testReconciler()
	ctx := context.Background()

	s := baseSpec()
	s.NetworkPolicy = true
	s.QuotaCPU = "4"
	s.QuotaMemory = "8Gi"
	s.QuotaPods = 20

	if err := r.Apply(ctx, s); err != nil {
		t.Fatal(err)
	}
	ns := s.Namespace()

	if _, err := r.Client.NetworkingV1().NetworkPolicies(ns).
		Get(ctx, "demo-isolation", metav1.GetOptions{}); err != nil {
		t.Fatalf("networkpolicy absente: %v", err)
	}

	quota, err := r.Client.CoreV1().ResourceQuotas(ns).Get(ctx, "demo-quota", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("quota absent: %v", err)
	}
	if got := quota.Spec.Hard[corev1.ResourcePods]; got.String() != "20" {
		t.Errorf("quota pods = %q", got.String())
	}

	// Désactiver doit nettoyer les deux ressources.
	s.NetworkPolicy = false
	s.QuotaCPU, s.QuotaMemory, s.QuotaPods = "", "", 0
	if err := r.Apply(ctx, s); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Client.NetworkingV1().NetworkPolicies(ns).
		Get(ctx, "demo-isolation", metav1.GetOptions{}); err == nil {
		t.Error("la networkpolicy aurait dû être supprimée")
	}
	if _, err := r.Client.CoreV1().ResourceQuotas(ns).
		Get(ctx, "demo-quota", metav1.GetOptions{}); err == nil {
		t.Error("le quota aurait dû être supprimé")
	}
}

// Par défaut, aucune contrainte ne doit empêcher une image publique standard
// (nginx, postgres, redis) de démarrer : ni runAsNonRoot, ni drop:ALL.
func TestSecurityContextPermissifParDefaut(t *testing.T) {
	r := testReconciler()
	ctx := context.Background()

	s := baseSpec()
	if err := r.Apply(ctx, s); err != nil {
		t.Fatal(err)
	}
	dep, _ := r.Client.AppsV1().Deployments(s.Namespace()).Get(ctx, "demo", metav1.GetOptions{})

	podSC := dep.Spec.Template.Spec.SecurityContext
	if podSC != nil && podSC.RunAsNonRoot != nil && *podSC.RunAsNonRoot {
		t.Error("runAsNonRoot ne doit pas être imposé par défaut")
	}

	c := dep.Spec.Template.Spec.Containers[0]
	if c.SecurityContext.Capabilities != nil {
		t.Error("les capabilities ne doivent pas être retirées par défaut")
	}
	if c.SecurityContext.ReadOnlyRootFilesystem != nil && *c.SecurityContext.ReadOnlyRootFilesystem {
		t.Error("le système de fichiers ne doit pas être en lecture seule par défaut")
	}
	// Cette protection-là est sans risque et reste toujours active.
	if c.SecurityContext.AllowPrivilegeEscalation == nil || *c.SecurityContext.AllowPrivilegeEscalation {
		t.Error("allowPrivilegeEscalation doit toujours être désactivé")
	}
}

func TestSecurityContextDurciSiDemande(t *testing.T) {
	r := testReconciler()
	ctx := context.Background()

	s := baseSpec()
	s.RunAsNonRoot = true
	s.RunAsUser = 10001
	s.ReadOnlyRootFilesystem = true

	if err := r.Apply(ctx, s); err != nil {
		t.Fatal(err)
	}
	dep, _ := r.Client.AppsV1().Deployments(s.Namespace()).Get(ctx, "demo", metav1.GetOptions{})

	podSC := dep.Spec.Template.Spec.SecurityContext
	if podSC.RunAsNonRoot == nil || !*podSC.RunAsNonRoot {
		t.Error("runAsNonRoot devait être activé")
	}
	if podSC.RunAsUser == nil || *podSC.RunAsUser != 10001 {
		t.Error("runAsUser devait valoir 10001")
	}

	c := dep.Spec.Template.Spec.Containers[0]
	if c.SecurityContext.Capabilities == nil {
		t.Error("les capabilities devaient être retirées en mode durci")
	}
	if c.SecurityContext.ReadOnlyRootFilesystem == nil || !*c.SecurityContext.ReadOnlyRootFilesystem {
		t.Error("readOnlyRootFilesystem devait être activé")
	}
}

func TestScaleEtRestart(t *testing.T) {
	r := testReconciler()
	ctx := context.Background()

	s := baseSpec()
	if err := r.Apply(ctx, s); err != nil {
		t.Fatal(err)
	}

	// Scale à 0 = arrêt sans suppression.
	if err := r.Scale(ctx, s, 0); err != nil {
		t.Fatal(err)
	}
	dep, _ := r.Client.AppsV1().Deployments(s.Namespace()).Get(ctx, "demo", metav1.GetOptions{})
	if *dep.Spec.Replicas != 0 {
		t.Errorf("replicas = %d, attendu 0", *dep.Spec.Replicas)
	}

	if err := r.Restart(ctx, s); err != nil {
		t.Fatal(err)
	}
	dep, _ = r.Client.AppsV1().Deployments(s.Namespace()).Get(ctx, "demo", metav1.GetOptions{})
	if dep.Spec.Template.Annotations["kybers.io/restarted-at"] == "" {
		t.Error("l'annotation de redémarrage est absente")
	}
}

// Supprimer une application ne doit pas emporter le namespace, qui peut
// héberger d'autres applications du même environnement.
func TestDeletePreserveLeNamespace(t *testing.T) {
	r := testReconciler()
	ctx := context.Background()

	s := baseSpec()
	s.SecretEnv = map[string]string{"K": "v"}
	if err := r.Apply(ctx, s); err != nil {
		t.Fatal(err)
	}

	if err := r.Delete(ctx, s, false); err != nil {
		t.Fatal(err)
	}
	ns := s.Namespace()

	if _, err := r.Client.CoreV1().Namespaces().Get(ctx, ns, metav1.GetOptions{}); err != nil {
		t.Error("le namespace ne devait pas être supprimé")
	}
	if _, err := r.Client.AppsV1().Deployments(ns).Get(ctx, "demo", metav1.GetOptions{}); err == nil {
		t.Error("le deployment aurait dû être supprimé")
	}
	if _, err := r.Client.CoreV1().Secrets(ns).Get(ctx, s.SecretName(), metav1.GetOptions{}); err == nil {
		t.Error("le secret aurait dû être supprimé")
	}

	// Suppression de l'environnement entier.
	if err := r.Delete(ctx, s, true); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Client.CoreV1().Namespaces().Get(ctx, ns, metav1.GetOptions{}); err == nil {
		t.Error("le namespace aurait dû être supprimé")
	}
}

// Un Delete sur une application déjà absente ne doit pas remonter d'erreur :
// l'opération est idempotente.
func TestDeleteIdempotent(t *testing.T) {
	r := testReconciler()
	ctx := context.Background()
	s := baseSpec()

	if err := r.Delete(ctx, s, false); err != nil {
		t.Errorf("delete sur ressources absentes: %v", err)
	}
	if err := r.Delete(ctx, s, true); err != nil {
		t.Errorf("delete namespace absent: %v", err)
	}
}

func TestFailureReasonDetecteImagePullBackOff(t *testing.T) {
	r := testReconciler()
	ctx := context.Background()
	s := baseSpec()

	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "demo-abc",
			Namespace: s.Namespace(),
			Labels:    r.selectorLabels(s),
		},
		Status: corev1.PodStatus{
			ContainerStatuses: []corev1.ContainerStatus{{
				State: corev1.ContainerState{
					Waiting: &corev1.ContainerStateWaiting{
						Reason:  "ImagePullBackOff",
						Message: "impossible de tirer l'image",
					},
				},
			}},
		},
	}
	if _, err := r.Client.CoreV1().Pods(s.Namespace()).Create(ctx, pod, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}

	reason := r.FailureReason(ctx, s)
	if reason == "" {
		t.Fatal("ImagePullBackOff non détecté")
	}
	if !contains(reason, "ImagePullBackOff") {
		t.Errorf("reason = %q", reason)
	}
}

func TestFailureReasonOOMKilled(t *testing.T) {
	r := testReconciler()
	ctx := context.Background()
	s := baseSpec()

	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "demo-oom",
			Namespace: s.Namespace(),
			Labels:    r.selectorLabels(s),
		},
		Status: corev1.PodStatus{
			ContainerStatuses: []corev1.ContainerStatus{{
				LastTerminationState: corev1.ContainerState{
					Terminated: &corev1.ContainerStateTerminated{Reason: "OOMKilled"},
				},
			}},
		},
	}
	if _, err := r.Client.CoreV1().Pods(s.Namespace()).Create(ctx, pod, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}

	if reason := r.FailureReason(ctx, s); !contains(reason, "OOMKilled") {
		t.Errorf("reason = %q, attendu OOMKilled", reason)
	}
}

// Une image sans processus long (busybox, alpine) se termine aussitôt et
// redémarre en boucle. Le pod passe brièvement par Ready : sans cette
// détection, le déploiement serait déclaré réussi à tort.
func TestFailureReasonConteneurQuiSeTermine(t *testing.T) {
	r := testReconciler()
	ctx := context.Background()
	s := baseSpec()

	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:        "demo-exit",
			Namespace:   s.Namespace(),
			Labels:      r.selectorLabels(s),
			Annotations: map[string]string{"kybers.io/deployment-id": s.DeploymentID},
		},
		Status: corev1.PodStatus{
			ContainerStatuses: []corev1.ContainerStatus{{
				RestartCount: 2,
				LastTerminationState: corev1.ContainerState{
					Terminated: &corev1.ContainerStateTerminated{
						Reason:   "Completed",
						ExitCode: 0,
					},
				},
			}},
		},
	}
	if _, err := r.Client.CoreV1().Pods(s.Namespace()).Create(ctx, pod, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}

	reason := r.FailureReason(ctx, s)
	if !contains(reason, "se termine immédiatement") {
		t.Errorf("reason = %q, attendu une mention de terminaison immédiate", reason)
	}
}

// Un conteneur qui sort en erreur doit remonter son code de sortie.
func TestFailureReasonSortieEnErreur(t *testing.T) {
	r := testReconciler()
	ctx := context.Background()
	s := baseSpec()

	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:        "demo-err",
			Namespace:   s.Namespace(),
			Labels:      r.selectorLabels(s),
			Annotations: map[string]string{"kybers.io/deployment-id": s.DeploymentID},
		},
		Status: corev1.PodStatus{
			ContainerStatuses: []corev1.ContainerStatus{{
				RestartCount: 3,
				LastTerminationState: corev1.ContainerState{
					Terminated: &corev1.ContainerStateTerminated{
						Reason:   "Error",
						ExitCode: 1,
					},
				},
			}},
		},
	}
	if _, err := r.Client.CoreV1().Pods(s.Namespace()).Create(ctx, pod, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}

	if reason := r.FailureReason(ctx, s); !contains(reason, "exit 1") {
		t.Errorf("reason = %q, attendu le code de sortie", reason)
	}
}

// Un redémarrage isolé sans terminaison récente ne doit pas être signalé :
// un pod peut avoir redémarré une fois puis tourner normalement.
func TestFailureReasonIgnoreRedemarrageAncien(t *testing.T) {
	r := testReconciler()
	ctx := context.Background()
	s := baseSpec()

	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:        "demo-ok-restart",
			Namespace:   s.Namespace(),
			Labels:      r.selectorLabels(s),
			Annotations: map[string]string{"kybers.io/deployment-id": s.DeploymentID},
		},
		Status: corev1.PodStatus{
			Phase: corev1.PodRunning,
			ContainerStatuses: []corev1.ContainerStatus{{
				Ready:        true,
				RestartCount: 1,
				State:        corev1.ContainerState{Running: &corev1.ContainerStateRunning{}},
				// Pas de LastTerminationState renseigné.
			}},
		},
	}
	if _, err := r.Client.CoreV1().Pods(s.Namespace()).Create(ctx, pod, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}

	if reason := r.FailureReason(ctx, s); reason != "" {
		t.Errorf("aucune cause attendue, obtenu %q", reason)
	}
}

// Un pod sain ne doit produire aucune cause d'échec.
func TestFailureReasonVideSiSain(t *testing.T) {
	r := testReconciler()
	ctx := context.Background()
	s := baseSpec()

	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "demo-ok",
			Namespace: s.Namespace(),
			Labels:    r.selectorLabels(s),
		},
		Status: corev1.PodStatus{
			Phase: corev1.PodRunning,
			ContainerStatuses: []corev1.ContainerStatus{{
				Ready: true,
				State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{}},
			}},
		},
	}
	if _, err := r.Client.CoreV1().Pods(s.Namespace()).Create(ctx, pod, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}

	if reason := r.FailureReason(ctx, s); reason != "" {
		t.Errorf("aucune cause attendue, obtenu %q", reason)
	}
}

func contains(haystack, needle string) bool {
	return strings.Contains(haystack, needle)
}

// Un conteneur qui tourne sans passer sa readiness probe est la cause la plus
// fréquente d'un 502 : le processus vit mais n'écoute pas sur son port.
func TestFailureReasonReadinessJamaisPassee(t *testing.T) {
	r := testReconciler()
	ctx := context.Background()
	s := baseSpec()

	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:        "demo-notready",
			Namespace:   s.Namespace(),
			Labels:      r.selectorLabels(s),
			Annotations: map[string]string{"kybers.io/deployment-id": s.DeploymentID},
		},
		Status: corev1.PodStatus{
			Phase: corev1.PodRunning,
			ContainerStatuses: []corev1.ContainerStatus{{
				Ready: false,
				State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{}},
			}},
		},
	}
	if _, err := r.Client.CoreV1().Pods(s.Namespace()).Create(ctx, pod, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}

	// Pendant l'attente, un pod pas encore prêt est normal : rien à signaler.
	if reason := r.FailureReason(ctx, s); reason != "" {
		t.Errorf("diagnostic prématuré: %q", reason)
	}
	// Une fois le délai écoulé, la cause doit être explicite.
	if reason := r.FinalFailureReason(ctx, s); !contains(reason, "readiness") {
		t.Errorf("FinalFailureReason = %q, attendu une mention de readiness", reason)
	}
}

// La NetworkPolicy doit autoriser le namespace réel de l'ingress-controller.
// Une liste en dur bloquerait le trafic sur toute distribution non prévue.
func TestNetworkPolicyDetecteIngress(t *testing.T) {
	r := testReconciler()
	ctx := context.Background()

	// Cluster fictif : l'ingress vit dans "traefik", pas dans ingress-nginx.
	for _, ns := range []string{"traefik", "kube-system"} {
		if _, err := r.Client.CoreV1().Namespaces().Create(ctx,
			&corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: ns}},
			metav1.CreateOptions{}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := r.Client.CoreV1().Services("traefik").Create(ctx, &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{Name: "traefik", Namespace: "traefik"},
		Spec:       corev1.ServiceSpec{Type: corev1.ServiceTypeLoadBalancer},
	}, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}

	s := baseSpec()
	s.NetworkPolicy = true
	if err := r.Apply(ctx, s); err != nil {
		t.Fatal(err)
	}

	np, err := r.Client.NetworkingV1().NetworkPolicies(s.Namespace()).
		Get(ctx, "demo-isolation", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}

	allowed := map[string]bool{}
	for _, peer := range np.Spec.Ingress[0].From {
		if peer.NamespaceSelector != nil {
			allowed[peer.NamespaceSelector.MatchLabels["kubernetes.io/metadata.name"]] = true
		}
	}
	if !allowed["traefik"] {
		t.Error("le namespace traefik devait être autorisé (détecté via son Service)")
	}
	// Un namespace inexistant ne doit pas apparaître.
	if allowed["ingress-nginx"] {
		t.Error("ingress-nginx n'existe pas sur ce cluster, il ne doit pas être listé")
	}
}
