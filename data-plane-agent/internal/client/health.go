package client

import (
	"encoding/json"
	"net/http"
	"sync"
	"time"
)

// Health expose l'état de l'agent aux sondes Kubernetes.
//
// Sans lui, un agent bloqué — stream gRPC mort, boucle figée — resterait
// « Running » indéfiniment : le Deployment ne redémarre un pod que s'il quitte.
type Health struct {
	mu sync.RWMutex

	connected     bool
	lastConnected time.Time
	// lastActivity : dernier échange réussi avec le Control Plane, quel qu'il
	// soit (register, heartbeat, statut). Sert à détecter un blocage.
	lastActivity time.Time
	lastError    string
	clusterID    string
	k8sReachable bool
}

func NewHealth(clusterID string) *Health {
	return &Health{clusterID: clusterID, k8sReachable: true}
}

func (h *Health) SetConnected(connected bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.connected = connected
	if connected {
		h.lastConnected = time.Now()
		h.lastActivity = time.Now()
		h.lastError = ""
	}
}

// Touch enregistre une activité : c'est ce qui distingue un agent vivant d'un
// agent figé.
func (h *Health) Touch() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.lastActivity = time.Now()
}

func (h *Health) SetError(err error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.connected = false
	if err != nil {
		h.lastError = err.Error()
	}
}

func (h *Health) SetK8sReachable(ok bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.k8sReachable = ok
}

// Live indique si le processus doit être redémarré par Kubernetes.
//
// Une simple déconnexion n'est PAS un motif de redémarrage : l'agent reconnecte
// seul avec backoff, et un Control Plane momentanément indisponible ferait
// sinon redémarrer tous les agents en boucle. Seul un silence prolongé —
// signe d'un blocage dont l'agent ne se remet pas — justifie un redémarrage.
func (h *Health) Live(stuckAfter time.Duration) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()

	if !h.k8sReachable {
		// L'API Kubernetes est injoignable : l'agent ne sert plus à rien, mais
		// le redémarrer ne réglera rien non plus. On le signale sans tuer.
		return true
	}
	if h.lastActivity.IsZero() {
		// Rien ne s'est encore produit : le démarrage est couvert par la
		// startupProbe, pas par la liveness.
		return true
	}
	return time.Since(h.lastActivity) < stuckAfter
}

// Ready indique si l'agent peut recevoir des ordres, c'est-à-dire s'il est
// effectivement connecté au Control Plane.
func (h *Health) Ready() bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.connected && h.k8sReachable
}

func (h *Health) snapshot() map[string]any {
	h.mu.RLock()
	defer h.mu.RUnlock()

	out := map[string]any{
		"cluster":       h.clusterID,
		"connected":     h.connected,
		"k8s_reachable": h.k8sReachable,
		"agent_version": agentVersion,
	}
	if !h.lastConnected.IsZero() {
		out["last_connected"] = h.lastConnected.UTC().Format(time.RFC3339)
	}
	if !h.lastActivity.IsZero() {
		out["seconds_since_activity"] = int(time.Since(h.lastActivity).Seconds())
	}
	if h.lastError != "" {
		out["last_error"] = h.lastError
	}
	return out
}

// ServeHealth démarre le serveur des sondes. Il n'écoute que sur les endpoints
// de santé : l'agent n'accepte aucune commande entrante.
func ServeHealth(addr string, h *Health, stuckAfter time.Duration) *http.Server {
	mux := http.NewServeMux()

	// Redémarrage du pod si la sonde échoue : réservé aux blocages réels.
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		if !h.Live(stuckAfter) {
			writeHealth(w, http.StatusServiceUnavailable, h)
			return
		}
		writeHealth(w, http.StatusOK, h)
	})

	// Retrait du trafic si la sonde échoue — sans effet ici puisque l'agent
	// n'a pas de Service, mais l'état reste visible dans `kubectl get pods`.
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		if !h.Ready() {
			writeHealth(w, http.StatusServiceUnavailable, h)
			return
		}
		writeHealth(w, http.StatusOK, h)
	})

	srv := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() {
		_ = srv.ListenAndServe()
	}()
	return srv
}

func writeHealth(w http.ResponseWriter, code int, h *Health) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(h.snapshot())
}
