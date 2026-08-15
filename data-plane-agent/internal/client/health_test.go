package client

import (
	"errors"
	"testing"
	"time"
)

// Une déconnexion ne doit PAS déclencher de redémarrage : l'agent reconnecte
// seul, et un Control Plane momentanément indisponible ferait sinon redémarrer
// tous les agents de tous les clusters en boucle.
func TestDeconnexionNeTuePasLAgent(t *testing.T) {
	h := NewHealth("prod")
	h.SetConnected(true)
	h.SetError(errors.New("connexion perdue"))

	if !h.Live(5 * time.Minute) {
		t.Error("une déconnexion récente ne doit pas déclencher un redémarrage")
	}
	// En revanche l'agent n'est plus prêt : le pod doit apparaître 0/1.
	if h.Ready() {
		t.Error("un agent déconnecté ne doit pas être Ready")
	}
}

// Un agent figé — plus aucun échange — doit être redémarré : c'est le seul cas
// que le restartPolicy de Kubernetes ne détecte pas seul.
func TestAgentFigeEstRedemarre(t *testing.T) {
	h := NewHealth("prod")
	h.SetConnected(true)

	// Simule une dernière activité ancienne.
	h.mu.Lock()
	h.lastActivity = time.Now().Add(-10 * time.Minute)
	h.mu.Unlock()

	if h.Live(5 * time.Minute) {
		t.Error("un agent sans activité depuis 10 min doit être redémarré")
	}
	// Une activité récente le remet en vie sans redémarrage.
	h.Touch()
	if !h.Live(5 * time.Minute) {
		t.Error("après une activité, l'agent doit être considéré vivant")
	}
}

// Au démarrage, aucune activité n'a encore eu lieu : c'est la startupProbe qui
// couvre cette phase, pas la liveness.
func TestDemarrageNeDeclenchePasDeRedemarrage(t *testing.T) {
	h := NewHealth("prod")
	if !h.Live(5 * time.Minute) {
		t.Error("un agent qui vient de démarrer ne doit pas être tué")
	}
	if h.Ready() {
		t.Error("un agent non connecté ne doit pas être Ready")
	}
}

// Une API Kubernetes injoignable rend l'agent inutile, mais le redémarrer n'y
// changerait rien : on le signale sans boucler.
func TestK8sInjoignableSignaleSansTuer(t *testing.T) {
	h := NewHealth("prod")
	h.SetConnected(true)
	h.SetK8sReachable(false)

	if !h.Live(5 * time.Minute) {
		t.Error("un redémarrage ne réglerait pas une API Kubernetes injoignable")
	}
	if h.Ready() {
		t.Error("sans accès à Kubernetes, l'agent ne peut rien faire")
	}
}

func TestSnapshotExposeLeDiagnostic(t *testing.T) {
	h := NewHealth("mon-cluster")
	h.SetError(errors.New("token invalide"))

	snap := h.snapshot()
	if snap["cluster"] != "mon-cluster" {
		t.Errorf("cluster = %v", snap["cluster"])
	}
	if snap["connected"] != false {
		t.Error("l'état déconnecté doit apparaître")
	}
	// La cause doit être lisible sans consulter les logs du pod.
	if snap["last_error"] != "token invalide" {
		t.Errorf("last_error = %v", snap["last_error"])
	}
}
