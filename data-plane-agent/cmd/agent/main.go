// Commande agent : Data Plane Kybers, installé dans le cluster client.
//
// L'agent n'écoute sur aucun port. Il ouvre une connexion sortante vers le
// Control Plane et exécute les ordres reçus contre l'API Kubernetes locale.
package main

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/kybers/kybers/data-plane-agent/internal/client"
	"github.com/kybers/kybers/data-plane-agent/internal/k8s"
)

func main() {
	log := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))

	cfg := client.Config{
		ServerAddr: env("CONTROL_PLANE_ADDR", "localhost:9090"),
		ClusterID:  env("CLUSTER_ID", "local"),
		Token:      env("CLUSTER_TOKEN", "dev-cluster-token"),
		Insecure:   envBool("INSECURE", true), // TLS obligatoire en production
	}
	kubeconfig := os.Getenv("KUBECONFIG")

	if cfg.Insecure {
		log.Warn("connexion NON chiffrée (INSECURE=true) — développement local uniquement")
	}

	rec, err := k8s.NewReconciler(kubeconfig, log)
	if err != nil {
		log.Error("initialisation du client kubernetes impossible", "err", err)
		os.Exit(1)
	}
	// Source de métriques explicite : utile quand la détection automatique ne
	// convient pas (Prometheus hors cluster, instance dédiée, Thanos...).
	if promURL := os.Getenv("PROMETHEUS_URL"); promURL != "" {
		rec.SetPrometheusURL(promURL)
		log.Info("prometheus configuré explicitement", "url", promURL)
	}

	log.Info("cluster kubernetes détecté", "version", rec.ServerVersion())

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	agent := client.New(cfg, rec, log)

	// Sondes de santé : dans un cluster, elles permettent à Kubernetes de
	// détecter un agent bloqué, qu'un simple restartPolicy ne verrait pas.
	health := client.NewHealth(cfg.ClusterID)
	agent.SetHealth(health)
	healthAddr := env("HEALTH_ADDR", ":8081")
	// Un agent sans activité depuis ce délai est considéré comme figé. La
	// valeur dépasse largement l'intervalle des heartbeats (15 s) pour ne pas
	// redémarrer un agent seulement déconnecté.
	stuckAfter := time.Duration(envInt("STUCK_AFTER_SECONDS", 300)) * time.Second
	healthSrv := client.ServeHealth(healthAddr, health, stuckAfter)
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = healthSrv.Shutdown(shutdownCtx)
	}()
	log.Info("sondes de santé", "addr", healthAddr, "blocage_après", stuckAfter)
	log.Info("agent démarré", "control_plane", cfg.ServerAddr, "cluster", cfg.ClusterID)

	if err := agent.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
		log.Error("agent arrêté", "err", err)
		os.Exit(1)
	}
	log.Info("agent arrêté proprement")
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// envInt lit un entier positif, avec repli sur def.
func envInt(key string, def int) int {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		return def
	}
	return n
}

func envBool(key string, def bool) bool {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return def
	}
	return b
}
