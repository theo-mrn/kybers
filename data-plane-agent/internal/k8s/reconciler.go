// Package k8s traduit un ordre de déploiement en ressources Kubernetes.
package k8s

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	autoscalingv2 "k8s.io/api/autoscaling/v2"
	corev1 "k8s.io/api/core/v1"
	netv1 "k8s.io/api/networking/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
	metricsv "k8s.io/metrics/pkg/client/clientset/versioned"
)

type Reconciler struct {
	Client kubernetes.Interface
	// metrics interroge metrics-server ; nil si l'API n'est pas disponible,
	// auquel cas aucune métrique n'est remontée.
	metrics metricsv.Interface
	// prom est utilisé quand metrics-server est absent ou incomplet. Vide si
	// aucun Prometheus exploitable n'a été trouvé.
	prom *promClient
	// preferredSource : source imposée par l'utilisateur ; vide = automatique.
	preferredSource string
	log             *slog.Logger
}

// PrometheusURL retourne l'URL du Prometheus utilisé, vide si aucun.
func (r *Reconciler) PrometheusURL() string {
	if r.prom == nil {
		return ""
	}
	return r.prom.baseURL
}

// SetPrometheusURL force une URL Prometheus (configuration explicite), ce qui
// court-circuite la détection automatique.
func (r *Reconciler) SetPrometheusURL(u string) {
	if u == "" {
		r.prom = nil
		return
	}
	r.prom = newPromClient(u)
}

// NewReconciler construit un client K8s. En cluster il utilise le ServiceAccount
// monté ; hors cluster il retombe sur le kubeconfig (dev local).
func NewReconciler(kubeconfig string, log *slog.Logger) (*Reconciler, error) {
	cfg, err := rest.InClusterConfig()
	if err != nil {
		loading := clientcmd.NewDefaultClientConfigLoadingRules()
		if kubeconfig != "" {
			loading.ExplicitPath = kubeconfig
		}
		cfg, err = clientcmd.NewNonInteractiveDeferredLoadingClientConfig(
			loading, &clientcmd.ConfigOverrides{}).ClientConfig()
		if err != nil {
			return nil, fmt.Errorf("configuration kubernetes introuvable: %w", err)
		}
		log.Info("client kubernetes: mode kubeconfig (hors cluster)")
	} else {
		log.Info("client kubernetes: mode in-cluster")
	}

	cs, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return nil, err
	}

	// L'absence de metrics-server n'empêche pas l'agent de fonctionner : seule
	// la remontée d'usage est perdue.
	var mc metricsv.Interface
	if m, err := metricsv.NewForConfig(cfg); err == nil {
		mc = m
	} else {
		log.Warn("client metrics indisponible", "err", err)
	}

	return &Reconciler{Client: cs, metrics: mc, log: log}, nil
}

// ServerVersion sert au diagnostic et est remonté lors du Register.
func (r *Reconciler) ServerVersion() string {
	v, err := r.Client.Discovery().ServerVersion()
	if err != nil {
		return "inconnue"
	}
	return v.GitVersion
}

// Apply crée ou met à jour l'ensemble des ressources d'une application.
// L'ordre importe : le namespace d'abord, puis les objets dont le Deployment
// dépend (ConfigMap, Secret, pull secret), le Deployment, et enfin ce qui
// l'expose ou l'encadre.
func (r *Reconciler) Apply(ctx context.Context, s Spec) error {
	ns := s.Namespace()

	if err := r.ensureNamespace(ctx, ns, s); err != nil {
		return fmt.Errorf("namespace: %w", err)
	}
	if err := r.applyQuota(ctx, ns, s); err != nil {
		return fmt.Errorf("resourcequota: %w", err)
	}
	if err := r.applyConfigMap(ctx, ns, s); err != nil {
		return fmt.Errorf("configmap: %w", err)
	}
	if err := r.applySecret(ctx, ns, s); err != nil {
		return fmt.Errorf("secret: %w", err)
	}
	if err := r.applyPullSecret(ctx, ns, s); err != nil {
		return fmt.Errorf("imagepullsecret: %w", err)
	}
	if err := r.applyDeployment(ctx, ns, s); err != nil {
		return fmt.Errorf("deployment: %w", err)
	}
	if err := r.applyService(ctx, ns, s); err != nil {
		return fmt.Errorf("service: %w", err)
	}
	if s.Host != "" {
		if err := r.applyIngress(ctx, ns, s); err != nil {
			return fmt.Errorf("ingress: %w", err)
		}
	}
	if err := r.applyHPA(ctx, ns, s); err != nil {
		return fmt.Errorf("hpa: %w", err)
	}
	if err := r.applyNetworkPolicy(ctx, ns, s); err != nil {
		return fmt.Errorf("networkpolicy: %w", err)
	}
	return nil
}

func (r *Reconciler) labels(s Spec) map[string]string {
	return map[string]string{
		LabelManagedBy:  ManagedByValue,
		LabelAppName:    s.ResourceName(),
		LabelInstance:   s.Namespace(),
		LabelDeployment: s.DeploymentID,
	}
}

// selectorLabels ne contient que des labels STABLES. Le selector d'un
// Deployment est immuable après création : y inclure le deployment-id, qui
// change à chaque déploiement, rendrait toute mise à jour impossible.
func (r *Reconciler) selectorLabels(s Spec) map[string]string {
	return map[string]string{
		LabelManagedBy: ManagedByValue,
		LabelAppName:   s.ResourceName(),
		LabelInstance:  s.Namespace(),
	}
}

// ---------------------------------------------------------------------------
// Namespace & quotas
// ---------------------------------------------------------------------------

func (r *Reconciler) ensureNamespace(ctx context.Context, ns string, s Spec) error {
	desired := &corev1.Namespace{
		ObjectMeta: metav1.ObjectMeta{
			Name: ns,
			Labels: map[string]string{
				LabelManagedBy:          ManagedByValue,
				"kybers.io/app":         s.ResourceName(),
				"kybers.io/environment": sanitize(s.Environment),
				// Repris par les NetworkPolicy pour cibler ce namespace.
				"kubernetes.io/metadata.name": ns,
			},
		},
	}
	_, err := r.Client.CoreV1().Namespaces().Create(ctx, desired, metav1.CreateOptions{})
	if apierrors.IsAlreadyExists(err) {
		return nil
	}
	if err != nil {
		return err
	}
	r.log.Info("namespace créé", "namespace", ns)
	return nil
}

// applyQuota borne la consommation totale de l'environnement. Sans quota
// configuré, l'éventuel quota existant est supprimé.
func (r *Reconciler) applyQuota(ctx context.Context, ns string, s Spec) error {
	name := s.ResourceName() + "-quota"
	client := r.Client.CoreV1().ResourceQuotas(ns)

	if s.QuotaCPU == "" && s.QuotaMemory == "" && s.QuotaPods == 0 {
		err := client.Delete(ctx, name, metav1.DeleteOptions{})
		if err != nil && !apierrors.IsNotFound(err) {
			return err
		}
		return nil
	}

	hard := corev1.ResourceList{}
	if s.QuotaCPU != "" {
		q, err := resource.ParseQuantity(s.QuotaCPU)
		if err != nil {
			return fmt.Errorf("quota cpu %q: %w", s.QuotaCPU, err)
		}
		hard[corev1.ResourceLimitsCPU] = q
	}
	if s.QuotaMemory != "" {
		q, err := resource.ParseQuantity(s.QuotaMemory)
		if err != nil {
			return fmt.Errorf("quota mémoire %q: %w", s.QuotaMemory, err)
		}
		hard[corev1.ResourceLimitsMemory] = q
	}
	if s.QuotaPods > 0 {
		hard[corev1.ResourcePods] = *resource.NewQuantity(int64(s.QuotaPods), resource.DecimalSI)
	}

	quota := &corev1.ResourceQuota{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns, Labels: r.labels(s)},
		Spec:       corev1.ResourceQuotaSpec{Hard: hard},
	}

	_, err := client.Create(ctx, quota, metav1.CreateOptions{})
	if apierrors.IsAlreadyExists(err) {
		existing, getErr := client.Get(ctx, name, metav1.GetOptions{})
		if getErr != nil {
			return getErr
		}
		quota.ObjectMeta.ResourceVersion = existing.ObjectMeta.ResourceVersion
		_, err = client.Update(ctx, quota, metav1.UpdateOptions{})
	}
	return err
}

// ---------------------------------------------------------------------------
// Configuration : ConfigMap, Secret, imagePullSecret
// ---------------------------------------------------------------------------

func (r *Reconciler) applyConfigMap(ctx context.Context, ns string, s Spec) error {
	cm := &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{
			Name:      s.ConfigMapName(),
			Namespace: ns,
			Labels:    r.labels(s),
		},
		Data: s.Env,
	}
	if cm.Data == nil {
		cm.Data = map[string]string{}
	}

	client := r.Client.CoreV1().ConfigMaps(ns)
	_, err := client.Create(ctx, cm, metav1.CreateOptions{})
	if apierrors.IsAlreadyExists(err) {
		existing, getErr := client.Get(ctx, cm.Name, metav1.GetOptions{})
		if getErr != nil {
			return getErr
		}
		cm.ObjectMeta.ResourceVersion = existing.ObjectMeta.ResourceVersion
		_, err = client.Update(ctx, cm, metav1.UpdateOptions{})
	}
	return err
}

func (r *Reconciler) applySecret(ctx context.Context, ns string, s Spec) error {
	sec := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{
			Name:      s.SecretName(),
			Namespace: ns,
			Labels:    r.labels(s),
		},
		Type:       corev1.SecretTypeOpaque,
		StringData: s.SecretEnv,
	}
	if sec.StringData == nil {
		sec.StringData = map[string]string{}
	}

	client := r.Client.CoreV1().Secrets(ns)
	_, err := client.Create(ctx, sec, metav1.CreateOptions{})
	if apierrors.IsAlreadyExists(err) {
		existing, getErr := client.Get(ctx, sec.Name, metav1.GetOptions{})
		if getErr != nil {
			return getErr
		}
		sec.ObjectMeta.ResourceVersion = existing.ObjectMeta.ResourceVersion
		// Data est remplacé par StringData : une clé retirée côté Control Plane
		// doit disparaître du Secret.
		sec.Data = nil
		_, err = client.Update(ctx, sec, metav1.UpdateOptions{})
	}
	return err
}

// dockerConfigJSON construit le contenu d'un Secret de type dockerconfigjson.
func dockerConfigJSON(c *RegistryCredentials) ([]byte, error) {
	auth := base64.StdEncoding.EncodeToString([]byte(c.Username + ":" + c.Password))
	cfg := map[string]any{
		"auths": map[string]any{
			c.Server: map[string]string{
				"username": c.Username,
				"password": c.Password,
				"email":    c.Email,
				"auth":     auth,
			},
		},
	}
	return json.Marshal(cfg)
}

func (r *Reconciler) applyPullSecret(ctx context.Context, ns string, s Spec) error {
	client := r.Client.CoreV1().Secrets(ns)

	if !s.Registry.Enabled() {
		// L'application est repassée sur une image publique : on retire le secret.
		err := client.Delete(ctx, s.PullSecretName(), metav1.DeleteOptions{})
		if err != nil && !apierrors.IsNotFound(err) {
			return err
		}
		return nil
	}

	payload, err := dockerConfigJSON(s.Registry)
	if err != nil {
		return err
	}

	sec := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{
			Name:      s.PullSecretName(),
			Namespace: ns,
			Labels:    r.labels(s),
		},
		Type: corev1.SecretTypeDockerConfigJson,
		Data: map[string][]byte{corev1.DockerConfigJsonKey: payload},
	}

	_, err = client.Create(ctx, sec, metav1.CreateOptions{})
	if apierrors.IsAlreadyExists(err) {
		existing, getErr := client.Get(ctx, sec.Name, metav1.GetOptions{})
		if getErr != nil {
			return getErr
		}
		sec.ObjectMeta.ResourceVersion = existing.ObjectMeta.ResourceVersion
		_, err = client.Update(ctx, sec, metav1.UpdateOptions{})
	}
	return err
}

// ---------------------------------------------------------------------------
// Deployment
// ---------------------------------------------------------------------------

// buildProbe traduit une Probe interne en sonde Kubernetes.
// containerPorts déclare tous les ports ouverts par l'image.
func containerPorts(s Spec) []corev1.ContainerPort {
	ports := s.EffectivePorts()
	out := make([]corev1.ContainerPort, 0, len(ports))
	for _, p := range ports {
		out = append(out, corev1.ContainerPort{
			Name:          p.Name,
			ContainerPort: p.Port,
			Protocol:      protocolOf(p.Protocol),
		})
	}
	return out
}

// servicePorts expose chaque port du conteneur sur le Service.
//
// Le port public garde le port 80 côté Service : c'est ce que cible l'Ingress,
// et le conserver évite de toucher aux Ingress déjà créés. Les autres sont
// publiés sur leur propre numéro, joignables dans le cluster.
func servicePorts(s Spec) []corev1.ServicePort {
	ports := s.EffectivePorts()
	out := make([]corev1.ServicePort, 0, len(ports))
	for _, p := range ports {
		port := p.Port
		name := p.Name
		if p.Exposed {
			port = 80
			name = "http"
		}
		out = append(out, corev1.ServicePort{
			Name:       name,
			Port:       port,
			TargetPort: intstr.FromInt32(p.Port),
			Protocol:   protocolOf(p.Protocol),
		})
	}
	return out
}

func protocolOf(p string) corev1.Protocol {
	if p == "UDP" {
		return corev1.ProtocolUDP
	}
	return corev1.ProtocolTCP
}

func buildProbe(p *Probe, containerPort int32) *corev1.Probe {
	if !p.Enabled() {
		return nil
	}

	port := p.Port
	if port == 0 {
		port = containerPort
	}

	probe := &corev1.Probe{
		InitialDelaySeconds: p.InitialDelaySecs,
		PeriodSeconds:       p.PeriodSecs,
		TimeoutSeconds:      p.TimeoutSecs,
		FailureThreshold:    p.FailureThreshold,
	}

	switch p.Type {
	case ProbeHTTP:
		path := p.Path
		if path == "" {
			path = "/"
		}
		probe.HTTPGet = &corev1.HTTPGetAction{Path: path, Port: intstr.FromInt32(port)}
	case ProbeTCP:
		probe.TCPSocket = &corev1.TCPSocketAction{Port: intstr.FromInt32(port)}
	case ProbeExec:
		if len(p.Command) == 0 {
			return nil // sonde exec sans commande : inapplicable
		}
		probe.Exec = &corev1.ExecAction{Command: p.Command}
	default:
		return nil
	}
	return probe
}

func buildResources(res Resources) (corev1.ResourceRequirements, error) {
	out := corev1.ResourceRequirements{
		Requests: corev1.ResourceList{},
		Limits:   corev1.ResourceList{},
	}

	add := func(list corev1.ResourceList, name corev1.ResourceName, val, label string) error {
		if val == "" {
			return nil
		}
		q, err := resource.ParseQuantity(val)
		if err != nil {
			return fmt.Errorf("%s %q: %w", label, val, err)
		}
		list[name] = q
		return nil
	}

	if err := add(out.Requests, corev1.ResourceCPU, res.CPURequest, "cpu request"); err != nil {
		return out, err
	}
	if err := add(out.Requests, corev1.ResourceMemory, res.MemoryRequest, "memory request"); err != nil {
		return out, err
	}
	if err := add(out.Limits, corev1.ResourceCPU, res.CPULimit, "cpu limit"); err != nil {
		return out, err
	}
	if err := add(out.Limits, corev1.ResourceMemory, res.MemoryLimit, "memory limit"); err != nil {
		return out, err
	}
	return out, nil
}

func (r *Reconciler) applyDeployment(ctx context.Context, ns string, s Spec) error {
	name := s.ResourceName()

	res, err := buildResources(s.Resources)
	if err != nil {
		return err
	}

	// envFrom plutôt que des valeurs littérales : les secrets ne sont jamais
	// inscrits dans le PodSpec, seulement référencés.
	envFrom := []corev1.EnvFromSource{
		{ConfigMapRef: &corev1.ConfigMapEnvSource{
			LocalObjectReference: corev1.LocalObjectReference{Name: s.ConfigMapName()},
		}},
		{SecretRef: &corev1.SecretEnvSource{
			LocalObjectReference: corev1.LocalObjectReference{Name: s.SecretName()},
		}},
	}

	var pullSecrets []corev1.LocalObjectReference
	if s.Registry.Enabled() {
		pullSecrets = []corev1.LocalObjectReference{{Name: s.PullSecretName()}}
	}

	replicas := s.Replicas
	allowPrivilegeEscalation := false

	// Le durcissement est opt-in. Imposer runAsNonRoot ferait échouer toute
	// image tournant en root, et drop:ALL casse les images qui ont besoin de
	// CHOWN/SETUID au démarrage (nginx, postgres...). Seul
	// allowPrivilegeEscalation=false est appliqué systématiquement : il bloque
	// l'escalade sans empêcher aucune image légitime de démarrer.
	podSecurity := &corev1.PodSecurityContext{}
	containerSecurity := &corev1.SecurityContext{
		AllowPrivilegeEscalation: &allowPrivilegeEscalation,
	}
	if s.RunAsNonRoot {
		runAsNonRoot := true
		podSecurity.RunAsNonRoot = &runAsNonRoot
		containerSecurity.RunAsNonRoot = &runAsNonRoot
		// Le retrait des capabilities accompagne le mode non-root : une image
		// conçue pour tourner sans privilèges n'en a pas besoin.
		containerSecurity.Capabilities = &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}}
	}
	if s.RunAsUser > 0 {
		uid := s.RunAsUser
		podSecurity.RunAsUser = &uid
		containerSecurity.RunAsUser = &uid
	}
	if s.ReadOnlyRootFilesystem {
		readOnly := true
		containerSecurity.ReadOnlyRootFilesystem = &readOnly
	}

	dep := &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: ns,
			Labels:    r.labels(s),
		},
		Spec: appsv1.DeploymentSpec{
			Replicas: &replicas,
			Selector: &metav1.LabelSelector{MatchLabels: r.selectorLabels(s)},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{
					Labels: r.labels(s),
					// Force le remplacement des pods quand seule la config change.
					Annotations: map[string]string{
						"kybers.io/deployment-id": s.DeploymentID,
					},
				},
				Spec: corev1.PodSpec{
					ImagePullSecrets: pullSecrets,
					SecurityContext:  podSecurity,
					Containers: []corev1.Container{{
						Name:  name,
						Image: s.Image,
						Ports:     containerPorts(s),
						EnvFrom:   envFrom,
						Resources: res,
						// Les probes visent le port public : c'est celui qui
						// porte le service applicatif.
						LivenessProbe:   buildProbe(s.LivenessProbe, s.ExposedPort()),
						ReadinessProbe:  buildProbe(s.ReadinessProbe, s.ExposedPort()),
						StartupProbe:    buildProbe(s.StartupProbe, s.ExposedPort()),
						SecurityContext: containerSecurity,
					}},
				},
			},
		},
	}

	client := r.Client.AppsV1().Deployments(ns)
	_, err = client.Create(ctx, dep, metav1.CreateOptions{})
	if apierrors.IsAlreadyExists(err) {
		existing, getErr := client.Get(ctx, name, metav1.GetOptions{})
		if getErr != nil {
			return getErr
		}
		// Le selector est immuable : on conserve celui déjà en place.
		dep.Spec.Selector = existing.Spec.Selector
		dep.ObjectMeta.ResourceVersion = existing.ObjectMeta.ResourceVersion
		// Si un HPA pilote les replicas, ne pas les écraser avec la valeur
		// enregistrée : le HPA reprendrait la main dans la foulée.
		if s.Autoscaling.Enabled && existing.Spec.Replicas != nil {
			dep.Spec.Replicas = existing.Spec.Replicas
		}
		if _, err = client.Update(ctx, dep, metav1.UpdateOptions{}); err != nil {
			return err
		}
		r.log.Info("deployment mis à jour", "namespace", ns, "name", name, "image", s.Image)
		return nil
	}
	if err != nil {
		return err
	}
	r.log.Info("deployment créé", "namespace", ns, "name", name, "image", s.Image)
	return nil
}

// ---------------------------------------------------------------------------
// Exposition : Service, Ingress
// ---------------------------------------------------------------------------

func (r *Reconciler) applyService(ctx context.Context, ns string, s Spec) error {
	name := s.ResourceName()
	svc := &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: ns,
			Labels:    r.labels(s),
		},
		Spec: corev1.ServiceSpec{
			Selector: r.selectorLabels(s),
			Ports: servicePorts(s),
			Type: corev1.ServiceTypeClusterIP,
		},
	}

	client := r.Client.CoreV1().Services(ns)
	_, err := client.Create(ctx, svc, metav1.CreateOptions{})
	if apierrors.IsAlreadyExists(err) {
		existing, getErr := client.Get(ctx, name, metav1.GetOptions{})
		if getErr != nil {
			return getErr
		}
		// ClusterIP est immuable une fois attribuée.
		svc.Spec.ClusterIP = existing.Spec.ClusterIP
		svc.ObjectMeta.ResourceVersion = existing.ObjectMeta.ResourceVersion
		_, err = client.Update(ctx, svc, metav1.UpdateOptions{})
	}
	return err
}

func (r *Reconciler) applyIngress(ctx context.Context, ns string, s Spec) error {
	name := s.ResourceName()
	pathType := netv1.PathTypePrefix

	// TLS n'est demandé que sur un domaine maîtrisé : sur un hostname nip.io,
	// cert-manager échouerait à valider le challenge et l'Ingress resterait
	// bloqué sans certificat.
	annotations := map[string]string{}
	var tlsBlock []netv1.IngressTLS
	if s.TLS {
		annotations["cert-manager.io/cluster-issuer"] = "letsencrypt-prod"
		tlsBlock = []netv1.IngressTLS{{
			Hosts:      []string{s.Host},
			SecretName: name + "-tls",
		}}
	}

	ing := &netv1.Ingress{
		ObjectMeta: metav1.ObjectMeta{
			Name:        name,
			Namespace:   ns,
			Labels:      r.labels(s),
			Annotations: annotations,
		},
		Spec: netv1.IngressSpec{
			TLS: tlsBlock,
			Rules: []netv1.IngressRule{{
				Host: s.Host,
				IngressRuleValue: netv1.IngressRuleValue{
					HTTP: &netv1.HTTPIngressRuleValue{
						Paths: []netv1.HTTPIngressPath{{
							Path:     "/",
							PathType: &pathType,
							Backend: netv1.IngressBackend{
								Service: &netv1.IngressServiceBackend{
									Name: name,
									Port: netv1.ServiceBackendPort{Number: 80},
								},
							},
						}},
					},
				},
			}},
		},
	}

	client := r.Client.NetworkingV1().Ingresses(ns)
	_, err := client.Create(ctx, ing, metav1.CreateOptions{})
	if apierrors.IsAlreadyExists(err) {
		existing, getErr := client.Get(ctx, name, metav1.GetOptions{})
		if getErr != nil {
			return getErr
		}
		ing.ObjectMeta.ResourceVersion = existing.ObjectMeta.ResourceVersion
		_, err = client.Update(ctx, ing, metav1.UpdateOptions{})
	}
	return err
}

// ---------------------------------------------------------------------------
// Autoscaling & réseau
// ---------------------------------------------------------------------------

func (r *Reconciler) applyHPA(ctx context.Context, ns string, s Spec) error {
	name := s.ResourceName()
	client := r.Client.AutoscalingV2().HorizontalPodAutoscalers(ns)

	if !s.Autoscaling.Enabled {
		// Autoscaling désactivé : retirer un éventuel HPA existant, sinon il
		// continuerait à piloter les replicas.
		err := client.Delete(ctx, name, metav1.DeleteOptions{})
		if err != nil && !apierrors.IsNotFound(err) {
			return err
		}
		return nil
	}

	minReplicas := s.Autoscaling.MinReplicas
	if minReplicas < 1 {
		minReplicas = 1
	}
	maxReplicas := s.Autoscaling.MaxReplicas
	if maxReplicas < minReplicas {
		maxReplicas = minReplicas
	}
	target := s.Autoscaling.TargetCPUPercent
	if target <= 0 {
		target = 80
	}

	hpa := &autoscalingv2.HorizontalPodAutoscaler{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns, Labels: r.labels(s)},
		Spec: autoscalingv2.HorizontalPodAutoscalerSpec{
			ScaleTargetRef: autoscalingv2.CrossVersionObjectReference{
				APIVersion: "apps/v1",
				Kind:       "Deployment",
				Name:       name,
			},
			MinReplicas: &minReplicas,
			MaxReplicas: maxReplicas,
			Metrics: []autoscalingv2.MetricSpec{{
				Type: autoscalingv2.ResourceMetricSourceType,
				Resource: &autoscalingv2.ResourceMetricSource{
					Name: corev1.ResourceCPU,
					Target: autoscalingv2.MetricTarget{
						Type:               autoscalingv2.UtilizationMetricType,
						AverageUtilization: &target,
					},
				},
			}},
		},
	}

	_, err := client.Create(ctx, hpa, metav1.CreateOptions{})
	if apierrors.IsAlreadyExists(err) {
		existing, getErr := client.Get(ctx, name, metav1.GetOptions{})
		if getErr != nil {
			return getErr
		}
		hpa.ObjectMeta.ResourceVersion = existing.ObjectMeta.ResourceVersion
		_, err = client.Update(ctx, hpa, metav1.UpdateOptions{})
	}
	return err
}

// applyNetworkPolicy isole le namespace : seuls l'ingress-controller et les
// pods du même namespace peuvent joindre l'application. Les sorties restent
// ouvertes (accès aux bases, DNS, API externes).
func (r *Reconciler) applyNetworkPolicy(ctx context.Context, ns string, s Spec) error {
	name := s.ResourceName() + "-isolation"
	client := r.Client.NetworkingV1().NetworkPolicies(ns)

	if !s.NetworkPolicy {
		err := client.Delete(ctx, name, metav1.DeleteOptions{})
		if err != nil && !apierrors.IsNotFound(err) {
			return err
		}
		return nil
	}

	// Les namespaces autorisés sont DÉTECTÉS, pas supposés : selon la
	// distribution, l'ingress-controller vit dans kube-system (K3s),
	// ingress-nginx, traefik, istio-system ou openshift-ingress. Une liste en
	// dur bloquerait le trafic sur les clusters non prévus.
	from := []netv1.NetworkPolicyPeer{
		// Pods du même namespace.
		{PodSelector: &metav1.LabelSelector{}},
	}
	for _, nsName := range r.ingressNamespaces(ctx) {
		from = append(from, netv1.NetworkPolicyPeer{
			NamespaceSelector: &metav1.LabelSelector{
				MatchLabels: map[string]string{"kubernetes.io/metadata.name": nsName},
			},
		})
	}

	np := &netv1.NetworkPolicy{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns, Labels: r.labels(s)},
		Spec: netv1.NetworkPolicySpec{
			PodSelector: metav1.LabelSelector{MatchLabels: r.selectorLabels(s)},
			PolicyTypes: []netv1.PolicyType{netv1.PolicyTypeIngress},
			Ingress: []netv1.NetworkPolicyIngressRule{{
				From: from,
			}},
		},
	}

	_, err := client.Create(ctx, np, metav1.CreateOptions{})
	if apierrors.IsAlreadyExists(err) {
		existing, getErr := client.Get(ctx, name, metav1.GetOptions{})
		if getErr != nil {
			return getErr
		}
		np.ObjectMeta.ResourceVersion = existing.ObjectMeta.ResourceVersion
		_, err = client.Update(ctx, np, metav1.UpdateOptions{})
	}
	return err
}

// ---------------------------------------------------------------------------
// Cycle de vie
// ---------------------------------------------------------------------------

// Scale change le nombre de replicas. 0 arrête l'application sans supprimer
// ses ressources : la configuration et l'URL sont conservées.
func (r *Reconciler) Scale(ctx context.Context, s Spec, replicas int32) error {
	client := r.Client.AppsV1().Deployments(s.Namespace())
	dep, err := client.Get(ctx, s.ResourceName(), metav1.GetOptions{})
	if err != nil {
		return err
	}
	dep.Spec.Replicas = &replicas
	_, err = client.Update(ctx, dep, metav1.UpdateOptions{})
	if err != nil {
		return err
	}
	r.log.Info("scale appliqué", "namespace", s.Namespace(), "replicas", replicas)
	return nil
}

// Restart déclenche un rolling restart, comme `kubectl rollout restart`, en
// modifiant une annotation du template de pod.
func (r *Reconciler) Restart(ctx context.Context, s Spec) error {
	client := r.Client.AppsV1().Deployments(s.Namespace())
	dep, err := client.Get(ctx, s.ResourceName(), metav1.GetOptions{})
	if err != nil {
		return err
	}
	if dep.Spec.Template.Annotations == nil {
		dep.Spec.Template.Annotations = map[string]string{}
	}
	dep.Spec.Template.Annotations["kybers.io/restarted-at"] = time.Now().UTC().Format(time.RFC3339)
	_, err = client.Update(ctx, dep, metav1.UpdateOptions{})
	if err != nil {
		return err
	}
	r.log.Info("redémarrage déclenché", "namespace", s.Namespace())
	return nil
}

// Delete supprime l'application. deleteNamespace=true emporte tout
// l'environnement ; sinon seules les ressources de l'application partent, ce
// qui préserve les autres applications du même namespace.
func (r *Reconciler) Delete(ctx context.Context, s Spec, deleteNamespace bool) error {
	ns := s.Namespace()
	name := s.ResourceName()

	if deleteNamespace {
		err := r.Client.CoreV1().Namespaces().Delete(ctx, ns, metav1.DeleteOptions{})
		if apierrors.IsNotFound(err) {
			return nil
		}
		return err
	}

	opts := metav1.DeleteOptions{}
	ignoreNotFound := func(err error) error {
		if err != nil && !apierrors.IsNotFound(err) {
			return err
		}
		return nil
	}

	if err := ignoreNotFound(r.Client.AppsV1().Deployments(ns).Delete(ctx, name, opts)); err != nil {
		return err
	}
	if err := ignoreNotFound(r.Client.CoreV1().Services(ns).Delete(ctx, name, opts)); err != nil {
		return err
	}
	if err := ignoreNotFound(r.Client.NetworkingV1().Ingresses(ns).Delete(ctx, name, opts)); err != nil {
		return err
	}
	if err := ignoreNotFound(r.Client.AutoscalingV2().HorizontalPodAutoscalers(ns).Delete(ctx, name, opts)); err != nil {
		return err
	}
	if err := ignoreNotFound(r.Client.CoreV1().ConfigMaps(ns).Delete(ctx, s.ConfigMapName(), opts)); err != nil {
		return err
	}
	if err := ignoreNotFound(r.Client.CoreV1().Secrets(ns).Delete(ctx, s.SecretName(), opts)); err != nil {
		return err
	}
	if err := ignoreNotFound(r.Client.CoreV1().Secrets(ns).Delete(ctx, s.PullSecretName(), opts)); err != nil {
		return err
	}
	if err := ignoreNotFound(r.Client.NetworkingV1().NetworkPolicies(ns).Delete(ctx, name+"-isolation", opts)); err != nil {
		return err
	}
	r.log.Info("ressources supprimées", "namespace", ns, "name", name)
	return nil
}

// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------

// Status retourne l'état courant des replicas d'un déploiement.
//
// ready compte les replicas de la RÉVISION COURANTE uniquement. Pendant une
// mise à jour progressive, les anciens pods restent prêts : les compter ferait
// conclure au succès alors que la nouvelle image ne démarre pas.
func (r *Reconciler) Status(ctx context.Context, s Spec) (ready, desired int32, err error) {
	dep, err := r.Client.AppsV1().Deployments(s.Namespace()).Get(ctx, s.ResourceName(), metav1.GetOptions{})
	if err != nil {
		return 0, 0, err
	}

	desired = s.Replicas
	if dep.Spec.Replicas != nil {
		desired = *dep.Spec.Replicas
	}

	// Le contrôleur n'a pas encore vu la dernière modification de la spec :
	// les compteurs de statut décrivent l'état précédent.
	if dep.Generation != dep.Status.ObservedGeneration {
		return 0, desired, nil
	}

	// Les compteurs agrégés du Deployment mélangent anciens et nouveaux pods
	// pendant un rolling update. On compte donc directement les pods de la
	// révision courante, identifiés par l'annotation posée sur le template.
	if s.DeploymentID != "" {
		pods, err := r.listPods(ctx, s)
		if err != nil {
			return 0, desired, nil
		}
		var current int32
		for _, pod := range pods {
			if pod.Annotations["kybers.io/deployment-id"] != s.DeploymentID {
				continue
			}
			if podReady(pod) {
				current++
			}
		}
		return current, desired, nil
	}

	return dep.Status.ReadyReplicas, desired, nil
}

// podReady indique si un pod a passé ses readiness checks.
func podReady(pod corev1.Pod) bool {
	if pod.Status.Phase != corev1.PodRunning {
		return false
	}
	for _, c := range pod.Status.Conditions {
		if c.Type == corev1.PodReady {
			return c.Status == corev1.ConditionTrue
		}
	}
	return false
}

// PodNames liste les pods de l'application, pour la collecte de logs.
func (r *Reconciler) PodNames(ctx context.Context, s Spec) ([]string, error) {
	pods, err := r.listPods(ctx, s)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(pods))
	for _, p := range pods {
		names = append(names, p.Name)
	}
	return names, nil
}

func (r *Reconciler) listPods(ctx context.Context, s Spec) ([]corev1.Pod, error) {
	sel := fmt.Sprintf("%s=%s,%s=%s", LabelManagedBy, ManagedByValue, LabelAppName, s.ResourceName())
	pods, err := r.Client.CoreV1().Pods(s.Namespace()).List(ctx, metav1.ListOptions{LabelSelector: sel})
	if err != nil {
		return nil, err
	}
	return pods.Items, nil
}

// FailureReason inspecte les pods pour expliquer un déploiement qui ne démarre
// pas : ImagePullBackOff, CrashLoopBackOff, OOMKilled... Chaîne vide si rien
// d'anormal n'est détecté.
//
// Seuls les pods de la révision courante sont examinés : pendant une mise à
// jour, les anciens pods sains masqueraient l'échec du nouveau.
func (r *Reconciler) FailureReason(ctx context.Context, s Spec) string {
	return r.failureReason(ctx, s, false)
}

// FinalFailureReason ajoute les causes qui ne sont concluantes qu'une fois le
// délai d'attente écoulé, comme une readiness probe qui n'est jamais passée.
func (r *Reconciler) FinalFailureReason(ctx context.Context, s Spec) string {
	return r.failureReason(ctx, s, true)
}

func (r *Reconciler) failureReason(ctx context.Context, s Spec, final bool) string {
	pods, err := r.listPods(ctx, s)
	if err != nil {
		return ""
	}

	for _, pod := range pods {
		// L'annotation porte l'identifiant du déploiement ayant créé le pod.
		if id, ok := pod.Annotations["kybers.io/deployment-id"]; ok &&
			s.DeploymentID != "" && id != s.DeploymentID {
			continue
		}
		statuses := append([]corev1.ContainerStatus{}, pod.Status.ContainerStatuses...)
		statuses = append(statuses, pod.Status.InitContainerStatuses...)

		for _, cs := range statuses {
			if w := cs.State.Waiting; w != nil {
				switch w.Reason {
				case "ImagePullBackOff", "ErrImagePull", "InvalidImageName":
					return fmt.Sprintf("%s: image %q introuvable ou registry inaccessible", w.Reason, s.Image)
				case "CrashLoopBackOff":
					return "CrashLoopBackOff: le conteneur redémarre en boucle"
				case "CreateContainerConfigError":
					return "CreateContainerConfigError: " + w.Message
				}
				if w.Reason != "" && w.Reason != "ContainerCreating" && w.Reason != "PodInitializing" {
					return w.Reason + ": " + w.Message
				}
			}
			if t := cs.LastTerminationState.Terminated; t != nil {
				if t.Reason == "OOMKilled" {
					return "OOMKilled: la limite mémoire est trop basse"
				}
				// Un conteneur qui se termine et redémarre en boucle n'est pas
				// un service : typiquement une image sans processus long
				// (busybox, alpine) ou une commande qui rend la main.
				if cs.RestartCount > 0 {
					if t.ExitCode == 0 {
						return "le conteneur se termine immédiatement (exit 0) : " +
							"cette image n'expose pas de service durable"
					}
					return fmt.Sprintf("le conteneur s'arrête en erreur (exit %d): %s",
						t.ExitCode, t.Reason)
				}
			}
		}

		// Aucun nœud ne peut accueillir le pod (ressources, quota, affinités).
		for _, cond := range pod.Status.Conditions {
			if cond.Type == corev1.PodScheduled && cond.Status == corev1.ConditionFalse &&
				cond.Reason == corev1.PodReasonUnschedulable {
				return "Unschedulable: " + cond.Message
			}
		}

		// Le conteneur tourne mais ne passe pas sa readiness probe : le
		// processus est vivant sans écouter sur son port. Cause la plus
		// fréquente d'un 502 sur l'URL publique.
		// Uniquement en diagnostic final : pendant le démarrage, un conteneur
		// pas encore prêt est normal.
		if final && pod.Status.Phase == corev1.PodRunning {
			for _, cs := range pod.Status.ContainerStatuses {
				if cs.State.Running != nil && !cs.Ready {
					return "le conteneur démarre mais ne répond pas sur son port " +
						"(readiness probe en échec) : vérifiez le port configuré " +
						"et les logs de l'application"
				}
			}
		}
	}
	return ""
}

// Event est un event Kubernetes normalisé, remonté au Control Plane.
type Event struct {
	PodName string
	Type    string
	Reason  string
	Message string
	TS      time.Time
}

// RecentEvents retourne les events du namespace liés à l'application. Ce sont
// eux qui expliquent un pod bloqué, là où les logs sont muets.
func (r *Reconciler) RecentEvents(ctx context.Context, s Spec, since time.Time) ([]Event, error) {
	list, err := r.Client.CoreV1().Events(s.Namespace()).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}

	prefix := s.ResourceName()
	out := []Event{}
	for _, e := range list.Items {
		// Ne garder que les objets de l'application : pods et Deployment
		// portent tous le nom de la ressource en préfixe.
		if !strings.HasPrefix(e.InvolvedObject.Name, prefix) {
			continue
		}
		ts := e.LastTimestamp.Time
		if ts.IsZero() {
			ts = e.EventTime.Time
		}
		if ts.IsZero() {
			ts = e.CreationTimestamp.Time
		}
		if !since.IsZero() && ts.Before(since) {
			continue
		}
		out = append(out, Event{
			PodName: e.InvolvedObject.Name,
			Type:    e.Type,
			Reason:  e.Reason,
			Message: e.Message,
			TS:      ts,
		})
	}
	return out, nil
}

// TailLogs récupère les dernières lignes de log d'un pod.
func (r *Reconciler) TailLogs(ctx context.Context, ns, pod string, lines int64) ([]string, error) {
	req := r.Client.CoreV1().Pods(ns).GetLogs(pod, &corev1.PodLogOptions{TailLines: &lines})
	data, err := req.DoRaw(ctx)
	if err != nil {
		return nil, err
	}
	raw := strings.Split(strings.TrimRight(string(data), "\n"), "\n")
	out := make([]string, 0, len(raw))
	for _, l := range raw {
		if strings.TrimSpace(l) != "" {
			out = append(out, l)
		}
	}
	return out, nil
}

// StreamLogs suit les logs d'un pod en continu et appelle onLine à chaque
// ligne, jusqu'à annulation du contexte ou fin du pod.
func (r *Reconciler) StreamLogs(ctx context.Context, ns, pod string, onLine func(string)) error {
	follow := true
	tail := int64(20)
	req := r.Client.CoreV1().Pods(ns).GetLogs(pod, &corev1.PodLogOptions{
		Follow:    follow,
		TailLines: &tail,
	})

	stream, err := req.Stream(ctx)
	if err != nil {
		return err
	}
	defer stream.Close()

	buf := make([]byte, 4096)
	var partial strings.Builder
	for {
		n, err := stream.Read(buf)
		if n > 0 {
			partial.Write(buf[:n])
			text := partial.String()
			// Ne traiter que les lignes complètes ; garder le reste en tampon.
			idx := strings.LastIndex(text, "\n")
			if idx >= 0 {
				for _, line := range strings.Split(text[:idx], "\n") {
					if strings.TrimSpace(line) != "" {
						onLine(line)
					}
				}
				partial.Reset()
				partial.WriteString(text[idx+1:])
			}
		}
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return err // io.EOF quand le pod se termine
		}
	}
}

// stabilityWindow est la durée pendant laquelle les pods doivent rester prêts
// avant qu'un déploiement soit déclaré réussi. Elle couvre le cas d'une image
// qui démarre puis se termine aussitôt : le conteneur passe par Ready, sort, et
// Kubernetes le redémarre quelques secondes plus tard.
const stabilityWindow = 20 * time.Second

// confirmStable vérifie que les pods restent prêts pendant toute la fenêtre.
// Retourne une erreur dès qu'un problème apparaît (terminaison, crash).
func (r *Reconciler) confirmStable(ctx context.Context, s Spec, window time.Duration, onProgress func(ready, desired int32)) error {
	deadline := time.Now().Add(window)
	ticker := time.NewTicker(3 * time.Second)
	defer ticker.Stop()

	for {
		if reason := r.FailureReason(ctx, s); reason != "" {
			return fmt.Errorf("%s", reason)
		}

		ready, desired, err := r.Status(ctx, s)
		if err == nil && onProgress != nil {
			onProgress(ready, desired)
		}
		// Les pods étaient prêts : s'ils ne le sont plus, quelque chose les a
		// fait redémarrer.
		if err == nil && desired > 0 && ready < desired {
			if reason := r.FailureReason(ctx, s); reason != "" {
				return fmt.Errorf("%s", reason)
			}
			return fmt.Errorf("les pods ne sont pas restés prêts (%d/%d)", ready, desired)
		}

		if time.Now().After(deadline) {
			return nil // stable pendant toute la fenêtre
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

// WaitReady sonde le Deployment jusqu'à ce que tous les replicas soient prêts.
// onProgress permet de remonter l'avancement au Control Plane pendant l'attente.
//
// Un échec définitif (image introuvable, crash en boucle) est détecté sans
// attendre l'expiration du délai.
func (r *Reconciler) WaitReady(ctx context.Context, s Spec, timeout time.Duration, onProgress func(ready, desired int32)) error {
	deadline := time.Now().Add(timeout)
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()

	var ready, desired int32
	for {
		var err error
		ready, desired, err = r.Status(ctx, s)
		if err == nil {
			if onProgress != nil {
				onProgress(ready, desired)
			}
			// desired == 0 correspond à un arrêt volontaire : rien à attendre.
			if desired == 0 {
				return nil
			}
			if ready >= desired {
				// Les pods sont prêts — mais une image sans processus durable
				// (busybox, une commande qui rend la main) passe par Ready puis
				// se termine quelques secondes plus tard. Un contrôle ponctuel
				// ne peut pas les distinguer : on observe donc une courte
				// fenêtre de stabilité avant de déclarer le succès.
				if err := r.confirmStable(ctx, s, stabilityWindow, onProgress); err != nil {
					return err
				}
				return nil
			}
		}

		// Inutile d'attendre le timeout si le pod ne démarrera jamais.
		if reason := r.FailureReason(ctx, s); reason != "" {
			return fmt.Errorf("%s", reason)
		}

		if time.Now().After(deadline) {
			return fmt.Errorf("timeout: %d/%d replicas prêts", ready, desired)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}
