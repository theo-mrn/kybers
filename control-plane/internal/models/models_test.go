package models

import "testing"

// Sans readiness probe, un conteneur dont le processus survit sans écouter est
// déclaré prêt à tort et l'URL publique renvoie 502.
func TestReadinessProbeParDefaut(t *testing.T) {
	cfg := DefaultAppConfig("app-1", "staging")

	if !cfg.ReadinessProbe.Enabled() {
		t.Fatal("une readiness probe doit être active par défaut")
	}
	// TCP plutôt que HTTP : aucune route particulière n'est supposée.
	if cfg.ReadinessProbe.Type != "tcp" {
		t.Errorf("type = %q, attendu tcp", cfg.ReadinessProbe.Type)
	}
	// Les autres sondes restent optionnelles : une liveness mal réglée
	// redémarrerait en boucle une application lente au démarrage.
	if cfg.LivenessProbe.Enabled() {
		t.Error("la liveness probe ne doit pas être active par défaut")
	}
	if cfg.StartupProbe.Enabled() {
		t.Error("la startup probe ne doit pas être active par défaut")
	}
}
