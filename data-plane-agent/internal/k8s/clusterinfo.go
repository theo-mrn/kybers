package k8s

import (
	"context"
	"strconv"
	"strings"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// NodeInfo décrit un nœud du cluster.
type NodeInfo struct {
	Name           string
	Ready          bool
	Role           string
	Architecture   string
	OSImage        string
	KubeletVersion string
	InternalIP     string
	CPUCapacity    string
	MemoryCapacity string
	// Pressions signalées par le kubelet (disque, mémoire, PID saturés).
	Pressures []string
}

// ClusterInfo est une photographie du cluster, destinée au diagnostic depuis
// le dashboard, sans accès kubectl.
type ClusterInfo struct {
	K8sVersion  string
	Platform    string
	NodeCount   int32
	NodesReady  int32
	Nodes       []NodeInfo
	TotalCPU    string
	TotalMemory string

	// Composants dont dépendent certaines fonctions de Kybers.
	HasMetricsServer bool
	HasCertManager   bool
	IngressClasses   []string
	IngressIPs       []string
	StorageClass     string

	// Origine des métriques de consommation, et URL du Prometheus utilisé.
	MetricsSource string
	PrometheusURL string
	// Sources exploitables, pour proposer un choix dans le dashboard.
	AvailableMetricsSources []string

	ManagedNamespaces int32
	ManagedPods       int32
}

// CollectClusterInfo interroge l'API Kubernetes. Chaque appel échoue
// indépendamment : une permission manquante ne doit pas priver le dashboard de
// toute information.
func (r *Reconciler) CollectClusterInfo(ctx context.Context) ClusterInfo {
	info := ClusterInfo{K8sVersion: r.ServerVersion()}
	info.Platform = detectPlatform(info.K8sVersion)

	r.collectNodes(ctx, &info)
	r.collectComponents(ctx, &info)
	r.collectIngress(ctx, &info)
	r.collectStorage(ctx, &info)
	r.collectManaged(ctx, &info)

	// Détection à la volée si aucun Prometheus n'a été configuré explicitement.
	if r.prom == nil {
		if u := r.detectPrometheus(ctx); u != "" {
			r.prom = newPromClient(u)
			r.log.Info("prometheus détecté", "url", u)
		}
	}
	info.PrometheusURL = r.PrometheusURL()
	info.MetricsSource = r.MetricsSource(ctx)
	info.AvailableMetricsSources = r.AvailableMetricsSources(ctx)

	return info
}

// detectPlatform déduit la distribution depuis la version : elle porte un
// suffixe caractéristique (« +k3s1 », « -eks-… »).
func detectPlatform(version string) string {
	v := strings.ToLower(version)
	switch {
	case strings.Contains(v, "k3s"):
		return "K3s"
	case strings.Contains(v, "eks"):
		return "Amazon EKS"
	case strings.Contains(v, "gke"):
		return "Google GKE"
	case strings.Contains(v, "aks"):
		return "Azure AKS"
	case strings.Contains(v, "rke"):
		return "Rancher RKE"
	case strings.Contains(v, "docker-desktop"):
		return "Docker Desktop"
	default:
		return "Kubernetes"
	}
}

func (r *Reconciler) collectNodes(ctx context.Context, info *ClusterInfo) {
	nodes, err := r.Client.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
	if err != nil {
		r.log.Debug("liste des nœuds indisponible", "err", err)
		return
	}

	var totalCPU, totalMem int64
	for _, n := range nodes.Items {
		ni := NodeInfo{
			Name:           n.Name,
			Architecture:   n.Status.NodeInfo.Architecture,
			OSImage:        n.Status.NodeInfo.OSImage,
			KubeletVersion: n.Status.NodeInfo.KubeletVersion,
			Role:           "worker",
		}

		// Le rôle est porté par un label, pas par un champ dédié.
		for label := range n.Labels {
			if strings.HasPrefix(label, "node-role.kubernetes.io/control-plane") ||
				strings.HasPrefix(label, "node-role.kubernetes.io/master") {
				ni.Role = "control-plane"
				break
			}
		}

		for _, addr := range n.Status.Addresses {
			if addr.Type == corev1.NodeInternalIP {
				ni.InternalIP = addr.Address
				break
			}
		}

		for _, cond := range n.Status.Conditions {
			switch {
			case cond.Type == corev1.NodeReady:
				ni.Ready = cond.Status == corev1.ConditionTrue
			// Les pressions expliquent un pod qui ne démarre pas alors que le
			// nœud est « Ready ».
			case cond.Status == corev1.ConditionTrue:
				switch cond.Type {
				case corev1.NodeMemoryPressure:
					ni.Pressures = append(ni.Pressures, "mémoire")
				case corev1.NodeDiskPressure:
					ni.Pressures = append(ni.Pressures, "disque")
				case corev1.NodePIDPressure:
					ni.Pressures = append(ni.Pressures, "PID")
				}
			}
		}

		if cpu := n.Status.Capacity.Cpu(); cpu != nil {
			ni.CPUCapacity = cpu.String()
			totalCPU += cpu.Value()
		}
		if mem := n.Status.Capacity.Memory(); mem != nil {
			ni.MemoryCapacity = formatMemory(mem.Value())
			totalMem += mem.Value()
		}

		if ni.Ready {
			info.NodesReady++
		}
		info.Nodes = append(info.Nodes, ni)
	}

	info.NodeCount = int32(len(nodes.Items))
	info.TotalCPU = formatCPU(totalCPU)
	info.TotalMemory = formatMemory(totalMem)
}

// collectComponents détecte les briques dont dépendent l'autoscaling et le TLS.
// Leur absence explique qu'un HPA reste inactif ou qu'un certificat n'arrive
// jamais.
func (r *Reconciler) collectComponents(ctx context.Context, info *ClusterInfo) {
	deps, err := r.Client.AppsV1().Deployments("").List(ctx, metav1.ListOptions{})
	if err != nil {
		r.log.Debug("liste des deployments indisponible", "err", err)
		return
	}
	for _, d := range deps.Items {
		name := strings.ToLower(d.Name)
		switch {
		case strings.Contains(name, "metrics-server"):
			info.HasMetricsServer = true
		case strings.Contains(name, "cert-manager") && !strings.Contains(name, "webhook") &&
			!strings.Contains(name, "cainjector"):
			info.HasCertManager = true
		}
	}
}

func (r *Reconciler) collectIngress(ctx context.Context, info *ClusterInfo) {
	classes, err := r.Client.NetworkingV1().IngressClasses().List(ctx, metav1.ListOptions{})
	if err == nil {
		for _, c := range classes.Items {
			info.IngressClasses = append(info.IngressClasses, c.Name)
		}
	}

	// Les IP publiques par lesquelles les applications sont jointes viennent du
	// Service LoadBalancer de l'ingress-controller.
	svcs, err := r.Client.CoreV1().Services("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return
	}
	seen := map[string]bool{}
	for _, s := range svcs.Items {
		if s.Spec.Type != corev1.ServiceTypeLoadBalancer {
			continue
		}
		for _, ing := range s.Status.LoadBalancer.Ingress {
			addr := ing.IP
			if addr == "" {
				addr = ing.Hostname
			}
			if addr != "" && !seen[addr] {
				seen[addr] = true
				info.IngressIPs = append(info.IngressIPs, addr)
			}
		}
	}
}

func (r *Reconciler) collectStorage(ctx context.Context, info *ClusterInfo) {
	classes, err := r.Client.StorageV1().StorageClasses().List(ctx, metav1.ListOptions{})
	if err != nil {
		return
	}
	for _, c := range classes.Items {
		if c.Annotations["storageclass.kubernetes.io/is-default-class"] == "true" {
			info.StorageClass = c.Name
			return
		}
	}
	if len(classes.Items) > 0 {
		info.StorageClass = classes.Items[0].Name
	}
}

// collectManaged mesure l'empreinte de Kybers : ce que la plateforme a créé.
func (r *Reconciler) collectManaged(ctx context.Context, info *ClusterInfo) {
	sel := LabelManagedBy + "=" + ManagedByValue

	ns, err := r.Client.CoreV1().Namespaces().List(ctx, metav1.ListOptions{LabelSelector: sel})
	if err == nil {
		info.ManagedNamespaces = int32(len(ns.Items))
	}

	pods, err := r.Client.CoreV1().Pods("").List(ctx, metav1.ListOptions{LabelSelector: sel})
	if err == nil {
		info.ManagedPods = int32(len(pods.Items))
	}
}

// formatCPU rend un nombre de cœurs lisible.
func formatCPU(cores int64) string {
	if cores == 0 {
		return ""
	}
	return strconv.FormatInt(cores, 10)
}

// formatMemory convertit des octets en Gi ou Mi.
func formatMemory(bytes int64) string {
	if bytes == 0 {
		return ""
	}
	const gi = 1024 * 1024 * 1024
	if bytes >= gi {
		return strconv.FormatInt(bytes/gi, 10) + "Gi"
	}
	return strconv.FormatInt(bytes/(1024*1024), 10) + "Mi"
}

// ingressNamespaces détecte où vivent les ingress-controllers du cluster.
//
// Leur emplacement varie selon la distribution : kube-system sur K3s,
// ingress-nginx, traefik, istio-system, openshift-ingress... Les supposer
// bloquerait le trafic entrant sur toute distribution non prévue.
func (r *Reconciler) ingressNamespaces(ctx context.Context) []string {
	seen := map[string]bool{}
	var out []string

	add := func(ns string) {
		if ns != "" && !seen[ns] {
			seen[ns] = true
			out = append(out, ns)
		}
	}

	// Source la plus fiable : le Service LoadBalancer/NodePort qui reçoit le
	// trafic externe est dans le namespace du contrôleur.
	if svcs, err := r.Client.CoreV1().Services("").List(ctx, metav1.ListOptions{}); err == nil {
		for _, s := range svcs.Items {
			if s.Spec.Type != corev1.ServiceTypeLoadBalancer &&
				s.Spec.Type != corev1.ServiceTypeNodePort {
				continue
			}
			name := strings.ToLower(s.Name)
			if strings.Contains(name, "ingress") || strings.Contains(name, "traefik") ||
				strings.Contains(name, "nginx") || strings.Contains(name, "gateway") ||
				strings.Contains(name, "istio") || strings.Contains(name, "haproxy") ||
				strings.Contains(name, "contour") || strings.Contains(name, "kong") {
				add(s.Namespace)
			}
		}
	}

	// Repli : namespaces conventionnels, s'ils existent réellement.
	for _, candidate := range []string{
		"kube-system", "ingress-nginx", "traefik", "traefik-system",
		"istio-system", "openshift-ingress", "projectcontour", "kong",
	} {
		if _, err := r.Client.CoreV1().Namespaces().Get(ctx, candidate, metav1.GetOptions{}); err == nil {
			add(candidate)
		}
	}
	return out
}
