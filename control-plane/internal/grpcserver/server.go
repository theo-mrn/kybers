// Package grpcserver implémente le service gRPC auquel les agents se connectent.
//
// Modèle de communication : l'agent ouvre un stream bidirectionnel SORTANT et
// le garde ouvert. Le Control Plane pousse les ordres de déploiement dessus.
// Aucun port entrant n'est nécessaire côté cluster client.
package grpcserver

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"time"

	kybersv1 "github.com/kybers/kybers/proto/gen/kybers/v1"

	"github.com/kybers/kybers/control-plane/internal/db"
	"github.com/kybers/kybers/control-plane/internal/models"
)

const heartbeatIntervalSeconds = 15

// agentConn représente un agent connecté. sendMu sérialise les écritures :
// grpc.ServerStream.Send n'est pas sûr depuis plusieurs goroutines.
type agentConn struct {
	clusterID   string
	clusterName string
	stream      kybersv1.AgentService_ConnectServer
	sendMu      sync.Mutex
}

func (a *agentConn) send(msg *kybersv1.ServerMessage) error {
	a.sendMu.Lock()
	defer a.sendMu.Unlock()
	return a.stream.Send(msg)
}

// Server maintient le registre des agents connectés.
type Server struct {
	kybersv1.UnimplementedAgentServiceServer

	db  *db.DB
	log *slog.Logger

	mu     sync.RWMutex
	agents map[string]*agentConn // clé : clusterID
}

func New(database *db.DB, log *slog.Logger) *Server {
	return &Server{
		db:     database,
		log:    log,
		agents: make(map[string]*agentConn),
	}
}

// Connect gère le cycle de vie complet d'un agent : authentification, puis
// boucle de réception des messages jusqu'à déconnexion.
func (s *Server) Connect(stream kybersv1.AgentService_ConnectServer) error {
	ctx := stream.Context()

	// Le tout premier message DOIT être un Register.
	first, err := stream.Recv()
	if err != nil {
		return err
	}
	reg := first.GetRegister()
	if reg == nil {
		return errors.New("premier message: Register attendu")
	}

	cluster, err := s.db.AuthenticateCluster(ctx, reg.GetClusterId(), reg.GetToken())
	if err != nil {
		s.log.Warn("authentification agent refusée", "cluster", reg.GetClusterId())
		// On notifie l'agent avant de fermer, pour qu'il logue une cause claire
		// plutôt qu'un EOF opaque.
		_ = stream.Send(&kybersv1.ServerMessage{
			Payload: &kybersv1.ServerMessage_RegisterAck{
				RegisterAck: &kybersv1.RegisterAck{
					Accepted: false,
					Reason:   "cluster inconnu ou token invalide",
				},
			},
		})
		return errors.New("authentification refusée")
	}

	conn := &agentConn{
		clusterID:   cluster.ID,
		clusterName: cluster.Name,
		stream:      stream,
	}

	s.mu.Lock()
	// Une reconnexion remplace l'ancienne entrée (l'ancien stream est mort ou
	// va l'être ; sa goroutine se terminera sur erreur de Recv).
	s.agents[cluster.ID] = conn
	s.mu.Unlock()

	if err := s.db.MarkClusterConnected(ctx, cluster.ID, true); err != nil {
		s.log.Error("MarkClusterConnected", "err", err)
	}
	s.log.Info("agent connecté", "cluster", cluster.Name, "version", reg.GetAgentVersion())
	if err := s.db.SetClusterAgentVersion(ctx, cluster.ID, reg.GetAgentVersion()); err != nil {
		s.log.Error("SetClusterAgentVersion", "err", err)
	}

	defer func() {
		s.mu.Lock()
		// Ne supprimer que si l'entrée est toujours la nôtre : une reconnexion
		// concurrente a pu déjà installer un stream plus récent.
		if s.agents[cluster.ID] == conn {
			delete(s.agents, cluster.ID)
		}
		s.mu.Unlock()

		// ctx est annulé ici : on utilise un contexte frais pour la mise à jour.
		bgCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := s.db.MarkClusterConnected(bgCtx, cluster.ID, false); err != nil {
			s.log.Error("MarkClusterConnected(false)", "err", err)
		}
		s.log.Info("agent déconnecté", "cluster", cluster.Name)
	}()

	if err := conn.send(&kybersv1.ServerMessage{
		Payload: &kybersv1.ServerMessage_RegisterAck{
			RegisterAck: &kybersv1.RegisterAck{
				Accepted:                 true,
				HeartbeatIntervalSeconds: heartbeatIntervalSeconds,
			},
		},
	}); err != nil {
		return err
	}

	// Le choix de source survit aux reconnexions : sans cela, l'agent
	// reviendrait à la sélection automatique à chaque redémarrage.
	if source, err := s.db.GetClusterMetricsSource(ctx, cluster.ID); err == nil && source != "" {
		if err := conn.send(&kybersv1.ServerMessage{
			Payload: &kybersv1.ServerMessage_SetMetricsSource{
				SetMetricsSource: &kybersv1.SetMetricsSourceCommand{Source: source},
			},
		}); err != nil {
			s.log.Warn("source de métriques non réappliquée", "err", err)
		}
	}

	// Boucle de réception.
	for {
		msg, err := stream.Recv()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		s.handleAgentMessage(ctx, cluster, msg)
	}
}

func (s *Server) handleAgentMessage(ctx context.Context, cluster *models.Cluster, msg *kybersv1.AgentMessage) {
	switch p := msg.Payload.(type) {

	case *kybersv1.AgentMessage_Heartbeat:
		if err := s.db.MarkClusterConnected(ctx, cluster.ID, true); err != nil {
			s.log.Error("heartbeat", "err", err)
		}

	case *kybersv1.AgentMessage_DeploymentStatus:
		st := p.DeploymentStatus
		status := phaseToStatus(st.GetPhase())
		s.log.Info("statut déploiement",
			"deployment", st.GetDeploymentId(),
			"phase", status,
			"ready", st.GetReadyReplicas(),
			"desired", st.GetDesiredReplicas())
		if err := s.db.UpdateDeploymentStatus(ctx, st.GetDeploymentId(), status,
			st.GetMessage(), st.GetUrl()); err != nil {
			s.log.Error("UpdateDeploymentStatus", "err", err)
		}
		// La cause technique (ImagePullBackOff...) est stockée à part pour que
		// le dashboard affiche un diagnostic plutôt qu'un simple "failed".
		if reason := st.GetReason(); reason != "" {
			if err := s.db.UpdateDeploymentReason(ctx, st.GetDeploymentId(), reason); err != nil {
				s.log.Error("UpdateDeploymentReason", "err", err)
			}
		}

	case *kybersv1.AgentMessage_LogChunk:
		lc := p.LogChunk
		ts := time.Unix(lc.GetTsUnix(), 0)
		if lc.GetTsUnix() == 0 {
			ts = time.Now()
		}
		if err := s.db.AppendLog(ctx, lc.GetDeploymentId(), lc.GetPodName(), lc.GetLine(), ts); err != nil {
			s.log.Error("AppendLog", "err", err)
		}

	case *kybersv1.AgentMessage_PodEvent:
		ev := p.PodEvent
		ts := time.Unix(ev.GetTsUnix(), 0)
		if ev.GetTsUnix() == 0 {
			ts = time.Now()
		}
		if err := s.db.AppendEvent(ctx, ev.GetDeploymentId(), ev.GetPodName(),
			ev.GetType(), ev.GetReason(), ev.GetMessage(), ts); err != nil {
			s.log.Error("AppendEvent", "err", err)
		}

	case *kybersv1.AgentMessage_CommandResult:
		cr := p.CommandResult
		status := models.CmdDone
		if !cr.GetSuccess() {
			status = models.CmdFailed
		}
		s.log.Info("résultat de commande",
			"command", cr.GetCommandId(), "succès", cr.GetSuccess(), "message", cr.GetMessage())
		if err := s.db.UpdateCommandStatus(ctx, cr.GetCommandId(), status, cr.GetMessage()); err != nil {
			s.log.Error("UpdateCommandStatus", "err", err)
		}

	case *kybersv1.AgentMessage_ClusterInfo:
		ci := p.ClusterInfo
		// Stocké tel quel : la forme suit celle du protobuf, sans schéma SQL
		// à faire évoluer à chaque nouveau champ.
		if err := s.db.SaveClusterInfo(ctx, cluster.ID, clusterInfoToMap(ci)); err != nil {
			s.log.Error("SaveClusterInfo", "err", err)
		}

	case *kybersv1.AgentMessage_Usage:
		u := p.Usage
		ts := time.Unix(u.GetTsUnix(), 0)
		if u.GetTsUnix() == 0 {
			ts = time.Now()
		}
		if err := s.db.InsertUsageSample(ctx, cluster.ID, ts,
			u.GetTotalCpuMillis(), u.GetTotalCpuCapacity(),
			u.GetTotalMemoryBytes(), u.GetTotalMemoryCapacity(),
			nodeUsageToSlice(u.GetNodes()), appUsageToSlice(u.GetApps())); err != nil {
			s.log.Error("InsertUsageSample", "err", err)
		}

	case *kybersv1.AgentMessage_Register:
		s.log.Warn("Register en double ignoré", "cluster", cluster.Name)
	}
}

func phaseToStatus(p kybersv1.DeploymentStatus_Phase) string {
	switch p {
	case kybersv1.DeploymentStatus_PHASE_PROVISIONING:
		return models.StatusProvisioning
	case kybersv1.DeploymentStatus_PHASE_RUNNING:
		return models.StatusRunning
	case kybersv1.DeploymentStatus_PHASE_FAILED:
		return models.StatusFailed
	case kybersv1.DeploymentStatus_PHASE_STOPPED:
		return models.StatusStopped
	case kybersv1.DeploymentStatus_PHASE_DELETED:
		return models.StatusDeleted
	default:
		return models.StatusPending
	}
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

// ErrNoAgent est renvoyé quand aucun agent n'est connecté pour recevoir l'ordre.
var ErrNoAgent = errors.New("aucun agent connecté")

// ErrClusterRequired signale qu'un déploiement ne précise pas son cluster alors
// que plusieurs sont connectés : impossible de choisir sans risque.
var ErrClusterRequired = errors.New(
	"plusieurs clusters connectés : précisez le cluster de l'application")

// Send transmet un message à un agent. clusterID vide = premier agent
// disponible (suffisant pour le prototype mono-cluster).
// Send transmet un message à l'agent d'un cluster.
//
// clusterID vide n'est accepté que s'il n'y a qu'un seul agent : avec
// plusieurs clusters, choisir « au hasard » enverrait un déploiement sur
// n'importe lequel, potentiellement en production.
func (s *Server) Send(clusterID string, msg *kybersv1.ServerMessage) error {
	s.mu.RLock()
	var conn *agentConn
	if clusterID != "" {
		conn = s.agents[clusterID]
	} else if len(s.agents) == 1 {
		for _, c := range s.agents {
			conn = c
		}
	}
	ambiguous := clusterID == "" && len(s.agents) > 1
	s.mu.RUnlock()

	if ambiguous {
		return ErrClusterRequired
	}
	if conn == nil {
		return ErrNoAgent
	}
	return conn.send(msg)
}

// Dispatch envoie un ordre de déploiement.
func (s *Server) Dispatch(clusterID string, cmd *kybersv1.DeployCommand) error {
	return s.Send(clusterID, &kybersv1.ServerMessage{
		Payload: &kybersv1.ServerMessage_Deploy{Deploy: cmd},
	})
}

// SendMetricsSource impose la source de métriques à l'agent d'un cluster.
func (s *Server) SendMetricsSource(clusterName, clusterID, source, promURL string) error {
	return s.Send(clusterID, &kybersv1.ServerMessage{
		Payload: &kybersv1.ServerMessage_SetMetricsSource{
			SetMetricsSource: &kybersv1.SetMetricsSourceCommand{
				Source:        source,
				PrometheusUrl: promURL,
			},
		},
	})
}

// SendLogStream démarre (follow=true) ou arrête le suivi des logs en continu.
// Contrairement aux commandes de cycle de vie, cet ordre n'est pas persisté :
// il n'a de sens que pour un agent actuellement connecté.
func (s *Server) SendLogStream(deploymentID, appName, environment string, follow bool) error {
	return s.Send("", &kybersv1.ServerMessage{
		Payload: &kybersv1.ServerMessage_LogStream{
			LogStream: &kybersv1.LogStreamCommand{
				DeploymentId: deploymentID,
				AppName:      appName,
				Environment:  environment,
				Follow:       follow,
			},
		},
	})
}

// ConnectedAgents retourne les noms des clusters actuellement connectés.
func (s *Server) ConnectedAgents() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	names := make([]string, 0, len(s.agents))
	for _, c := range s.agents {
		names = append(names, c.clusterName)
	}
	return names
}

// clusterInfoToMap convertit le message protobuf en structure sérialisable.
// Les noms de champs suivent la convention JSON du dashboard.
func clusterInfoToMap(ci *kybersv1.ClusterInfo) map[string]any {
	nodes := make([]map[string]any, 0, len(ci.GetNodes()))
	for _, n := range ci.GetNodes() {
		nodes = append(nodes, map[string]any{
			"name":            n.GetName(),
			"ready":           n.GetReady(),
			"role":            n.GetRole(),
			"architecture":    n.GetArchitecture(),
			"os_image":        n.GetOsImage(),
			"kubelet_version": n.GetKubeletVersion(),
			"internal_ip":     n.GetInternalIp(),
			"cpu_capacity":    n.GetCpuCapacity(),
			"memory_capacity": n.GetMemoryCapacity(),
			"pressures":       n.GetPressures(),
		})
	}
	return map[string]any{
		"k8s_version":               ci.GetK8SVersion(),
		"platform":                  ci.GetPlatform(),
		"node_count":                ci.GetNodeCount(),
		"nodes_ready":               ci.GetNodesReady(),
		"nodes":                     nodes,
		"total_cpu":                 ci.GetTotalCpu(),
		"total_memory":              ci.GetTotalMemory(),
		"has_metrics_server":        ci.GetHasMetricsServer(),
		"has_cert_manager":          ci.GetHasCertManager(),
		"ingress_classes":           ci.GetIngressClasses(),
		"ingress_ips":               ci.GetIngressIps(),
		"storage_class":             ci.GetStorageClass(),
		"prometheus_url":            ci.GetPrometheusUrl(),
		"metrics_source":            ci.GetMetricsSource(),
		"available_metrics_sources": ci.GetAvailableMetricsSources(),
		"managed_namespaces":        ci.GetManagedNamespaces(),
		"managed_pods":              ci.GetManagedPods(),
	}
}

func nodeUsageToSlice(nodes []*kybersv1.NodeUsage) []map[string]any {
	out := make([]map[string]any, 0, len(nodes))
	for _, n := range nodes {
		out = append(out, map[string]any{
			"name":            n.GetName(),
			"cpu_millis":      n.GetCpuMillis(),
			"cpu_capacity":    n.GetCpuCapacity(),
			"memory_bytes":    n.GetMemoryBytes(),
			"memory_capacity": n.GetMemoryCapacity(),
			"gpu_count":       n.GetGpuCount(),
			"gpu_allocated":   n.GetGpuAllocated(),
		})
	}
	return out
}

func appUsageToSlice(apps []*kybersv1.AppUsage) []map[string]any {
	out := make([]map[string]any, 0, len(apps))
	for _, a := range apps {
		out = append(out, map[string]any{
			"namespace":     a.GetNamespace(),
			"app_name":      a.GetAppName(),
			"deployment_id": a.GetDeploymentId(),
			"cpu_millis":    a.GetCpuMillis(),
			"memory_bytes":  a.GetMemoryBytes(),
			"pod_count":     a.GetPodCount(),
		})
	}
	return out
}
