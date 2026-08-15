// Commande server : point d'entrée du Control Plane Kybers.
//
// Il expose deux écouteurs :
//   - HTTP  (:8080) : API REST pour le dashboard et la CLI
//   - gRPC  (:9090) : stream bidirectionnel pour les agents Data Plane
package main

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"google.golang.org/grpc"

	kybersv1 "github.com/kybers/kybers/proto/gen/kybers/v1"

	"github.com/kybers/kybers/control-plane/internal/api"
	"github.com/kybers/kybers/control-plane/internal/crypto"
	"github.com/kybers/kybers/control-plane/internal/db"
	"github.com/kybers/kybers/control-plane/internal/grpcserver"
	"github.com/kybers/kybers/control-plane/internal/hostname"
)

func main() {
	log := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))

	dsn := env("DATABASE_URL", "postgres://kybers:kybers@localhost:5432/kybers?sslmode=disable")
	httpAddr := env("HTTP_ADDR", ":8080")
	grpcAddr := env("GRPC_ADDR", ":9090")

	// Chiffre les secrets applicatifs en base. La valeur par défaut ne convient
	// qu'au développement : changer la clé rend illisibles les secrets déjà
	// enregistrés, il faut donc la fixer dès la première mise en production.
	encKey := env("ENCRYPTION_KEY", "kybers-dev-encryption-key-change-me")
	if encKey == "kybers-dev-encryption-key-change-me" {
		log.Warn("ENCRYPTION_KEY par défaut — à changer hors développement local")
	}
	cipher, err := crypto.New(encKey)
	if err != nil {
		log.Error("clé de chiffrement invalide", "err", err)
		os.Exit(1)
	}

	// URL publique attribuée automatiquement aux déploiements.
	// BASE_DOMAIN doit pointer en wildcard (*.domaine) vers l'ingress ; sans
	// lui, INGRESS_IP fait office de repli via nip.io.
	hosts := hostname.New(os.Getenv("BASE_DOMAIN"), os.Getenv("INGRESS_IP"))
	switch {
	case os.Getenv("BASE_DOMAIN") != "":
		log.Info("URL générées", "domaine", os.Getenv("BASE_DOMAIN"), "tls", true)
	case os.Getenv("INGRESS_IP") != "":
		log.Info("URL générées via nip.io", "ingress_ip", os.Getenv("INGRESS_IP"), "tls", false)
	default:
		log.Warn("ni BASE_DOMAIN ni INGRESS_IP : les applications déployées " +
			"ne seront pas exposées automatiquement")
	}

	// Contexte annulé par SIGINT/SIGTERM : pilote l'arrêt de tous les composants.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	database, err := db.Connect(ctx, dsn, cipher)
	if err != nil {
		log.Error("connexion à PostgreSQL impossible", "err", err)
		os.Exit(1)
	}
	defer database.Close()

	if err := database.Migrate(ctx); err != nil {
		log.Error("migration échouée", "err", err)
		os.Exit(1)
	}
	log.Info("migrations appliquées")

	// Aucun agent n'est connecté à un processus qui vient de démarrer : le
	// drapeau hérité du run précédent décrirait des streams disparus.
	if n, err := database.DisconnectAllClusters(ctx); err != nil {
		log.Error("réinitialisation des connexions clusters", "err", err)
	} else if n > 0 {
		log.Info("clusters marqués déconnectés au démarrage", "clusters", n)
	}

	// --- gRPC (agents) ---
	agentSrv := grpcserver.New(database, log)
	gs := grpc.NewServer()
	kybersv1.RegisterAgentServiceServer(gs, agentSrv)

	lis, err := net.Listen("tcp", grpcAddr)
	if err != nil {
		log.Error("écoute gRPC impossible", "addr", grpcAddr, "err", err)
		os.Exit(1)
	}
	go func() {
		log.Info("serveur gRPC démarré", "addr", grpcAddr)
		if err := gs.Serve(lis); err != nil {
			log.Error("serveur gRPC arrêté", "err", err)
		}
	}()

	// --- Dispatcher : file d'attente -> agents ---
	// Rétention des données qui croissent avec l'usage. Sans purge, logs et
	// events s'accumulent indéfiniment.
	retention := grpcserver.DefaultRetention()
	retention.LogsHours = envInt("RETENTION_LOGS_HOURS", retention.LogsHours)
	retention.UsageHours = envInt("RETENTION_USAGE_HOURS", retention.UsageHours)
	retention.CommandDays = envInt("RETENTION_COMMAND_DAYS", retention.CommandDays)
	retention.KeepRevisions = envInt("RETENTION_REVISIONS", retention.KeepRevisions)
	log.Info("rétention",
		"logs_h", retention.LogsHours, "usage_h", retention.UsageHours,
		"commandes_j", retention.CommandDays, "révisions", retention.KeepRevisions)

	dispatcher := grpcserver.NewDispatcher(database, agentSrv, log, hosts, retention)
	go dispatcher.Run(ctx)

	// --- HTTP (dashboard / CLI) ---
	httpSrv := &http.Server{
		Addr: httpAddr,
		Handler: api.New(database, agentSrv, log, hosts, api.InstallConfig{
			// Adresse joignable DEPUIS LES CLUSTERS CLIENTS, pas depuis le
			// dashboard : elle diffère dès que le Control Plane est derrière un
			// NAT ou un reverse proxy.
			AgentAddr:  env("AGENT_ADDR", "localhost:9090"),
			AgentImage: env("AGENT_IMAGE", "maxwellfaraday/kybers-agent:dev"),
			ChartURL:   env("AGENT_CHART", "oci://registry-1.docker.io/maxwellfaraday/kybers-agent"),
			Insecure:   envBool("AGENT_INSECURE", true),
			// Inscription libre : réservée au développement. En production,
			// seul le premier compte peut être créé sans invitation.
			OpenRegistration: envBool("OPEN_REGISTRATION", false),

			// Intégration Git : facultative. Sans jeton, les onglets
			// documentation et pipeline restent masqués.
			GitToken:  os.Getenv("GITHUB_TOKEN"),
			GitAPIURL: os.Getenv("GITHUB_API_URL"),
		}).Routes(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		log.Info("serveur HTTP démarré", "addr", httpAddr)
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("serveur HTTP arrêté", "err", err)
		}
	}()

	<-ctx.Done()
	log.Info("arrêt en cours...")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := httpSrv.Shutdown(shutdownCtx); err != nil {
		log.Error("arrêt HTTP", "err", err)
	}
	gs.GracefulStop()
	log.Info("arrêté")
}

// envBool lit un booléen depuis l'environnement, avec repli sur def.
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

// envInt lit un entier positif depuis l'environnement, avec repli sur def.
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

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
