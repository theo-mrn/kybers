package k8s

import (
	"context"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// ResourceGPU est la ressource étendue exposée par le device plugin NVIDIA.
const ResourceGPU = "nvidia.com/gpu"

type NodeUsage struct {
	Name           string
	CPUMillis      int64
	CPUCapacity    int64
	MemoryBytes    int64
	MemoryCapacity int64
	GPUCount       int64
	GPUAllocated   int64
}

// AppUsage agrège la consommation des pods d'une application.
type AppUsage struct {
	Namespace    string
	AppName      string
	DeploymentID string
	CPUMillis    int64
	MemoryBytes  int64
	PodCount     int32
}

type UsageReport struct {
	Nodes []NodeUsage
	Apps  []AppUsage

	TotalCPUMillis      int64
	TotalCPUCapacity    int64
	TotalMemoryBytes    int64
	TotalMemoryCapacity int64
}

// CollectUsage relève la consommation réelle via metrics-server.
//
// Retourne nil si l'API metrics est absente : mieux vaut ne rien afficher que
// des zéros, qui laisseraient croire à un cluster inactif.
func (r *Reconciler) CollectUsage(ctx context.Context) *UsageReport {
	// Le choix de l'utilisateur prime, tant qu'il reste exploitable.
	if r.MetricsSource(ctx) == MetricsSourcePrometheus {
		return r.collectFromPrometheus(ctx)
	}
	if r.metrics == nil {
		return r.collectFromPrometheus(ctx)
	}

	nodeMetrics, err := r.metrics.MetricsV1beta1().NodeMetricses().List(ctx, metav1.ListOptions{})
	if err != nil {
		// metrics-server absent ou en erreur : Prometheus prend le relais s'il
		// est configuré.
		r.log.Debug("metrics-server injoignable", "err", err)
		return r.collectFromPrometheus(ctx)
	}

	// La capacité vient des nœuds eux-mêmes : metrics-server ne l'expose pas.
	nodes, err := r.Client.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil
	}
	capacity := map[string]corev1.ResourceList{}
	allocatedGPU := map[string]int64{}
	for _, n := range nodes.Items {
		capacity[n.Name] = n.Status.Capacity
		if gpu, ok := n.Status.Allocatable[ResourceGPU]; ok {
			allocatedGPU[n.Name] = gpu.Value()
		}
	}

	report := &UsageReport{}
	for _, m := range nodeMetrics.Items {
		u := NodeUsage{
			Name:        m.Name,
			CPUMillis:   m.Usage.Cpu().MilliValue(),
			MemoryBytes: m.Usage.Memory().Value(),
		}
		if cap, ok := capacity[m.Name]; ok {
			u.CPUCapacity = cap.Cpu().MilliValue()
			u.MemoryCapacity = cap.Memory().Value()
			if gpu, ok := cap[ResourceGPU]; ok {
				u.GPUCount = gpu.Value()
			}
		}
		u.GPUAllocated = allocatedGPU[m.Name]

		report.TotalCPUMillis += u.CPUMillis
		report.TotalCPUCapacity += u.CPUCapacity
		report.TotalMemoryBytes += u.MemoryBytes
		report.TotalMemoryCapacity += u.MemoryCapacity
		report.Nodes = append(report.Nodes, u)
	}

	report.Apps = r.collectAppUsage(ctx)
	return report
}

// collectFromPrometheus est le repli quand metrics-server est indisponible.
func (r *Reconciler) collectFromPrometheus(ctx context.Context) *UsageReport {
	if r.prom == nil {
		return nil
	}
	return r.prom.CollectUsage(ctx)
}

// AvailableMetricsSources liste les sources réellement exploitables sur ce
// cluster. Le dashboard s'en sert pour proposer un choix.
func (r *Reconciler) AvailableMetricsSources(ctx context.Context) []string {
	var out []string
	if r.metricsServerOK(ctx) {
		out = append(out, MetricsSourceServer)
	}
	if r.prom != nil && r.prom.Healthy(ctx) {
		out = append(out, MetricsSourcePrometheus)
	}
	return out
}

func (r *Reconciler) metricsServerOK(ctx context.Context) bool {
	if r.metrics == nil {
		return false
	}
	_, err := r.metrics.MetricsV1beta1().NodeMetricses().List(ctx, metav1.ListOptions{Limit: 1})
	return err == nil
}

// SetPreferredSource impose la source choisie par l'utilisateur. Une chaîne
// vide rétablit la sélection automatique.
func (r *Reconciler) SetPreferredSource(source string) {
	r.preferredSource = source
}

// MetricsSource retourne la source effectivement utilisée : le choix de
// l'utilisateur s'il est exploitable, sinon la priorité par défaut
// (metrics-server, plus léger et temps réel, puis Prometheus).
func (r *Reconciler) MetricsSource(ctx context.Context) string {
	switch r.preferredSource {
	case MetricsSourceServer:
		if r.metricsServerOK(ctx) {
			return MetricsSourceServer
		}
		// Le choix n'est plus valide (metrics-server désinstallé) : on retombe
		// sur l'autre source plutôt que de ne rien remonter.
	case MetricsSourcePrometheus:
		if r.prom != nil && r.prom.Healthy(ctx) {
			return MetricsSourcePrometheus
		}
	}

	if r.metricsServerOK(ctx) {
		return MetricsSourceServer
	}
	if r.prom != nil && r.prom.Healthy(ctx) {
		return MetricsSourcePrometheus
	}
	return MetricsSourceNone
}

// collectAppUsage agrège la consommation par application déployée par Kybers.
func (r *Reconciler) collectAppUsage(ctx context.Context) []AppUsage {
	sel := LabelManagedBy + "=" + ManagedByValue

	pods, err := r.Client.CoreV1().Pods("").List(ctx, metav1.ListOptions{LabelSelector: sel})
	if err != nil {
		return nil
	}
	// Les métriques de pods ne portent pas les labels : on relie par nom.
	podLabels := map[string]corev1.Pod{}
	for _, p := range pods.Items {
		podLabels[p.Namespace+"/"+p.Name] = p
	}

	podMetrics, err := r.metrics.MetricsV1beta1().PodMetricses("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil
	}

	agg := map[string]*AppUsage{}
	for _, pm := range podMetrics.Items {
		pod, ok := podLabels[pm.Namespace+"/"+pm.Name]
		if !ok {
			continue // pod hors périmètre Kybers
		}

		key := pod.Namespace
		entry := agg[key]
		if entry == nil {
			entry = &AppUsage{
				Namespace:    pod.Namespace,
				AppName:      pod.Labels[LabelAppName],
				DeploymentID: pod.Annotations["kybers.io/deployment-id"],
			}
			agg[key] = entry
		}

		// Un pod peut avoir plusieurs conteneurs : on somme.
		for _, c := range pm.Containers {
			entry.CPUMillis += c.Usage.Cpu().MilliValue()
			entry.MemoryBytes += c.Usage.Memory().Value()
		}
		entry.PodCount++
	}

	out := make([]AppUsage, 0, len(agg))
	for _, v := range agg {
		out = append(out, *v)
	}
	return out
}

// hasMetricsAPI indique si metrics-server répond, pour l'afficher côté
// dashboard sans attendre un premier relevé.
func (r *Reconciler) hasMetricsAPI(ctx context.Context) bool {
	if r.metrics == nil {
		return false
	}
	_, err := r.metrics.MetricsV1beta1().NodeMetricses().List(ctx, metav1.ListOptions{Limit: 1})
	return err == nil
}
