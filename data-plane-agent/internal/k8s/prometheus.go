package k8s

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// Sources possibles pour la consommation de ressources.
const (
	MetricsSourceServer     = "metrics-server"
	MetricsSourcePrometheus = "prometheus"
	MetricsSourceNone       = "aucune"
)

// promClient interroge l'API HTTP de Prometheus.
//
// Prometheus est une source alternative à metrics-server : certains clusters
// n'ont que l'un des deux. Contrairement à metrics-server, il expose aussi
// l'historique, mais toutes les installations ne collectent pas les métriques
// de ressources (node-exporter et cAdvisor peuvent être absents).
type promClient struct {
	baseURL string
	http    *http.Client
}

func newPromClient(baseURL string) *promClient {
	return &promClient{
		baseURL: strings.TrimSuffix(baseURL, "/"),
		http:    &http.Client{Timeout: 10 * time.Second},
	}
}

// query exécute une requête PromQL instantanée et retourne la valeur scalaire.
// ok=false signale une absence de donnée, distincte d'une erreur.
func (c *promClient) query(ctx context.Context, promQL string) (value float64, ok bool, err error) {
	endpoint := fmt.Sprintf("%s/api/v1/query?query=%s", c.baseURL, url.QueryEscape(promQL))

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return 0, false, err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return 0, false, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return 0, false, fmt.Errorf("prometheus a répondu %d", resp.StatusCode)
	}

	var payload struct {
		Status string `json:"status"`
		Data   struct {
			Result []struct {
				// [timestamp, "valeur"] — la valeur est une chaîne.
				Value []any `json:"value"`
			} `json:"result"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return 0, false, err
	}
	if payload.Status != "success" || len(payload.Data.Result) == 0 {
		return 0, false, nil
	}

	raw := payload.Data.Result[0].Value
	if len(raw) < 2 {
		return 0, false, nil
	}
	str, _ := raw[1].(string)
	v, err := strconv.ParseFloat(str, 64)
	if err != nil {
		return 0, false, nil
	}
	return v, true, nil
}

// Healthy vérifie que Prometheus répond ET expose les métriques de ressources.
//
// Un Prometheus qui ne surveille que le control plane (sans node-exporter ni
// cAdvisor) ne peut pas alimenter la consommation : mieux vaut le détecter ici
// que de remonter des zéros.
func (c *promClient) Healthy(ctx context.Context) bool {
	_, ok, err := c.query(ctx, "sum(node_memory_MemTotal_bytes)")
	if err != nil || !ok {
		// Repli : certaines installations n'ont pas node-exporter mais ont
		// cAdvisor, qui suffit pour la consommation des pods.
		_, ok, err = c.query(ctx, "sum(container_memory_working_set_bytes)")
	}
	return err == nil && ok
}

// CollectUsageFromPrometheus construit un relevé à partir de PromQL.
// Retourne nil si les métriques nécessaires sont absentes.
func (c *promClient) CollectUsage(ctx context.Context) *UsageReport {
	report := &UsageReport{}

	// Agrégats du cluster. Sans eux, le relevé n'a pas d'intérêt.
	cpuUsed, okCPU, _ := c.query(ctx,
		`sum(rate(node_cpu_seconds_total{mode!="idle"}[5m]))`)
	cpuTotal, okCPUCap, _ := c.query(ctx, `sum(machine_cpu_cores) or sum(kube_node_status_capacity{resource="cpu"})`)
	memUsed, okMem, _ := c.query(ctx,
		`sum(node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes)`)
	memTotal, okMemCap, _ := c.query(ctx, `sum(node_memory_MemTotal_bytes)`)

	if !okCPU && !okMem {
		return nil
	}

	if okCPU {
		report.TotalCPUMillis = int64(cpuUsed * 1000)
	}
	if okCPUCap {
		report.TotalCPUCapacity = int64(cpuTotal * 1000)
	}
	if okMem {
		report.TotalMemoryBytes = int64(memUsed)
	}
	if okMemCap {
		report.TotalMemoryCapacity = int64(memTotal)
	}
	return report
}

// detectPrometheus cherche un Prometheus joignable dans le cluster.
//
// Retourne son URL interne, ou une chaîne vide si aucun n'est trouvé. Les
// services Alertmanager, Grafana et exporters sont écartés : seul le serveur
// Prometheus répond à l'API de requête.
func (r *Reconciler) detectPrometheus(ctx context.Context) string {
	svcs, err := r.Client.CoreV1().Services("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return ""
	}

	exclude := []string{
		"operator", "grafana", "alertmanager", "state-metrics",
		"node-exporter", "coredns", "kubelet", "pushgateway", "thanos-ruler",
	}

	for _, s := range svcs.Items {
		name := strings.ToLower(s.Name)
		if !strings.Contains(name, "prometheus") &&
			!strings.Contains(name, "mimir") &&
			!strings.Contains(name, "victoria") {
			continue
		}
		skip := false
		for _, ex := range exclude {
			if strings.Contains(name, ex) {
				skip = true
				break
			}
		}
		if skip {
			continue
		}

		// Le port nommé "http-web" / "web" / 9090 est celui de l'API.
		port := int32(0)
		for _, p := range s.Spec.Ports {
			if p.Port == 9090 || p.Name == "web" || p.Name == "http-web" ||
				p.Name == "http" {
				port = p.Port
				break
			}
		}
		if port == 0 && len(s.Spec.Ports) > 0 {
			port = s.Spec.Ports[0].Port
		}
		if port == 0 {
			continue
		}

		candidate := fmt.Sprintf("http://%s.%s.svc.cluster.local:%d", s.Name, s.Namespace, port)
		if newPromClient(candidate).Healthy(ctx) {
			return candidate
		}
	}
	return ""
}
