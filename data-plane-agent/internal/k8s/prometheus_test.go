package k8s

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// promServer simule l'API de Prometheus.
func promServer(value string) (*httptest.Server, *promClient) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if value == "" {
			// Métrique absente : Prometheus répond succès avec un résultat vide.
			_, _ = w.Write([]byte(`{"status":"success","data":{"result":[]}}`))
			return
		}
		_, _ = w.Write([]byte(
			`{"status":"success","data":{"result":[{"value":[1700000000,"` + value + `"]}]}}`))
	}))
	c := newPromClient(srv.URL)
	c.http = srv.Client()
	return srv, c
}

func TestPromQuery(t *testing.T) {
	srv, c := promServer("1234.5")
	defer srv.Close()

	v, ok, err := c.query(context.Background(), "up")
	if err != nil {
		t.Fatal(err)
	}
	if !ok || v != 1234.5 {
		t.Errorf("query = %v, ok=%v ; attendu 1234.5", v, ok)
	}
}

// Un Prometheus qui ne collecte pas les métriques de ressources doit être
// écarté : sinon Kybers remonterait des zéros au lieu de signaler l'absence.
func TestPromHealthySansMetriquesRessources(t *testing.T) {
	srv, c := promServer("")
	defer srv.Close()

	if c.Healthy(context.Background()) {
		t.Error("un Prometheus sans métriques de ressources ne doit pas être retenu")
	}
	if c.CollectUsage(context.Background()) != nil {
		t.Error("aucun relevé ne doit être produit sans données")
	}
}

func TestPromCollectUsage(t *testing.T) {
	srv, c := promServer("8")
	defer srv.Close()

	u := c.CollectUsage(context.Background())
	if u == nil {
		t.Fatal("un relevé était attendu")
	}
	// 8 cœurs consommés -> 8000 millicores.
	if u.TotalCPUMillis != 8000 {
		t.Errorf("CPU = %d millicores, attendu 8000", u.TotalCPUMillis)
	}
}

// Sans metrics-server ni Prometheus, aucun relevé ne doit être inventé.
func TestCollectUsageSansSource(t *testing.T) {
	r := testReconciler()
	if r.CollectUsage(context.Background()) != nil {
		t.Error("aucun relevé ne doit être produit sans source de métriques")
	}
	if got := r.MetricsSource(context.Background()); got != MetricsSourceNone {
		t.Errorf("MetricsSource = %q, attendu %q", got, MetricsSourceNone)
	}
}

// Prometheus prend le relais quand metrics-server est absent.
func TestPrometheusEnRepli(t *testing.T) {
	srv, c := promServer("4")
	defer srv.Close()

	r := testReconciler()
	r.prom = c // metrics-server absent (testReconciler ne le fournit pas)

	if got := r.MetricsSource(context.Background()); got != MetricsSourcePrometheus {
		t.Errorf("MetricsSource = %q, attendu %q", got, MetricsSourcePrometheus)
	}
	u := r.CollectUsage(context.Background())
	if u == nil || u.TotalCPUMillis != 4000 {
		t.Error("le relevé devait provenir de Prometheus")
	}
}
