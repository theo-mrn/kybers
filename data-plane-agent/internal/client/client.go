// Package client gère la connexion sortante de l'agent vers le Control Plane
// et l'exécution des ordres reçus.
package client

import (
	"context"
	"crypto/tls"
	"errors"
	"io"
	"log/slog"
	"sync"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"

	kybersv1 "github.com/kybers/kybers/proto/gen/kybers/v1"

	"github.com/kybers/kybers/data-plane-agent/internal/k8s"
)

const (
	agentVersion = "0.3.0"
	// Les caractéristiques du cluster bougent peu : un rafraîchissement par
	// minute suffit à refléter l'ajout d'un nœud ou d'un composant.
	clusterInfoInterval = time.Minute
	// Échantillonnage de la consommation. 30s donne une courbe lisible sur 24h
	// sans saturer la base (~2900 points par nœud et par jour).
	usageInterval  = 30 * time.Second
	readyTimeout   = 3 * time.Minute
	reconnectDelay = 5 * time.Second
	maxBackoff     = 60 * time.Second
)

type Config struct {
	ServerAddr  string // ex: control-plane.kybers.io:9090
	ClusterID   string
	Token       string
	Insecure    bool // true = h2c sans TLS (dev local uniquement)
	LogTailLine int64
}

type Agent struct {
	cfg Config
	rec *k8s.Reconciler
	log *slog.Logger
	// health alimente les sondes Kubernetes ; nil si elles ne sont pas servies.
	health *Health

	sendMu sync.Mutex // sérialise les Send sur le stream
	stream kybersv1.AgentService_ConnectClient

	// Suivis de logs actifs, par deployment_id.
	streamsMu  sync.Mutex
	logStreams map[string]context.CancelFunc
}

func New(cfg Config, rec *k8s.Reconciler, log *slog.Logger) *Agent {
	if cfg.LogTailLine == 0 {
		cfg.LogTailLine = 20
	}
	return &Agent{
		cfg:        cfg,
		rec:        rec,
		log:        log,
		logStreams: make(map[string]context.CancelFunc),
	}
}

// SetHealth relie l'agent aux sondes de santé.
func (a *Agent) SetHealth(h *Health) { a.health = h }

func (a *Agent) markConnected(connected bool) {
	if a.health != nil {
		a.health.SetConnected(connected)
	}
}

func (a *Agent) markActivity() {
	if a.health != nil {
		a.health.Touch()
	}
}

// Run maintient la connexion au Control Plane indéfiniment, avec backoff
// exponentiel entre les tentatives. Une coupure réseau ou un redémarrage du
// Control Plane ne doit jamais tuer l'agent.
func (a *Agent) Run(ctx context.Context) error {
	backoff := reconnectDelay

	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}

		err := a.connectOnce(ctx)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err != nil {
			a.log.Warn("connexion perdue, nouvelle tentative",
				"err", err, "dans", backoff.String())
			if a.health != nil {
				a.health.SetError(err)
			}
		}
		a.markConnected(false)

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(backoff):
		}

		backoff *= 2
		if backoff > maxBackoff {
			backoff = maxBackoff
		}
		// Après une session réussie, on repart d'un délai court.
		if err == nil {
			backoff = reconnectDelay
		}
	}
}

func (a *Agent) connectOnce(ctx context.Context) error {
	var creds grpc.DialOption
	if a.cfg.Insecure {
		creds = grpc.WithTransportCredentials(insecure.NewCredentials())
	} else {
		creds = grpc.WithTransportCredentials(
			credentials.NewTLS(&tls.Config{MinVersion: tls.VersionTLS12}))
	}

	conn, err := grpc.NewClient(a.cfg.ServerAddr, creds)
	if err != nil {
		return err
	}
	defer conn.Close()

	streamCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	stream, err := kybersv1.NewAgentServiceClient(conn).Connect(streamCtx)
	if err != nil {
		return err
	}

	a.sendMu.Lock()
	a.stream = stream
	a.sendMu.Unlock()

	// Les suivis de logs sont liés au stream : ils s'arrêtent avec lui.
	defer a.stopAllLogStreams()

	// 1. S'authentifier.
	if err := a.send(&kybersv1.AgentMessage{
		Payload: &kybersv1.AgentMessage_Register{
			Register: &kybersv1.Register{
				ClusterId:    a.cfg.ClusterID,
				Token:        a.cfg.Token,
				AgentVersion: agentVersion,
				K8SVersion:   a.rec.ServerVersion(),
			},
		},
	}); err != nil {
		return err
	}

	// 2. Attendre l'accusé de réception avant toute autre activité.
	first, err := stream.Recv()
	if err != nil {
		return err
	}
	ack := first.GetRegisterAck()
	if ack == nil {
		return errors.New("RegisterAck attendu")
	}
	if !ack.GetAccepted() {
		// Erreur de configuration : réessayer ne servira à rien tant que le
		// token n'est pas corrigé, mais on laisse Run retenter avec backoff.
		return errors.New("enregistrement refusé: " + ack.GetReason())
	}
	a.log.Info("connecté au control plane", "addr", a.cfg.ServerAddr, "cluster", a.cfg.ClusterID)
	a.markConnected(true)

	// 3. Heartbeats en tâche de fond.
	interval := time.Duration(ack.GetHeartbeatIntervalSeconds()) * time.Second
	if interval <= 0 {
		interval = 15 * time.Second
	}
	go a.heartbeatLoop(streamCtx, interval)

	// 3bis. État de l'infrastructure : envoyé aussitôt pour que le dashboard
	// soit renseigné dès la connexion, puis rafraîchi périodiquement.
	go a.clusterInfoLoop(streamCtx)

	// 3ter. Consommation réelle (CPU/mémoire/GPU), pour les courbes du dashboard.
	go a.usageLoop(streamCtx)

	// 4. Boucle de réception des ordres.
	for {
		msg, err := stream.Recv()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		a.markActivity()

		// Chaque ordre est traité dans sa propre goroutine : un déploiement
		// long ne doit pas bloquer la réception des suivants.
		switch p := msg.Payload.(type) {
		case *kybersv1.ServerMessage_Deploy:
			go a.handleDeploy(ctx, p.Deploy)
		case *kybersv1.ServerMessage_Delete:
			go a.handleDelete(ctx, p.Delete)
		case *kybersv1.ServerMessage_Scale:
			go a.handleScale(ctx, p.Scale)
		case *kybersv1.ServerMessage_Restart:
			go a.handleRestart(ctx, p.Restart)
		case *kybersv1.ServerMessage_LogStream:
			go a.handleLogStream(ctx, p.LogStream)
		case *kybersv1.ServerMessage_SetMetricsSource:
			go a.handleSetMetricsSource(ctx, p.SetMetricsSource)
		}
	}
}

func (a *Agent) heartbeatLoop(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := a.send(&kybersv1.AgentMessage{
				Payload: &kybersv1.AgentMessage_Heartbeat{
					Heartbeat: &kybersv1.Heartbeat{SentAtUnix: time.Now().Unix()},
				},
			}); err != nil {
				return // le stream est mort ; Run va reconnecter
			}
			a.markActivity()
		}
	}
}

// clusterInfoLoop remonte l'état du cluster au Control Plane.
func (a *Agent) clusterInfoLoop(ctx context.Context) {
	a.sendClusterInfo(ctx)

	ticker := time.NewTicker(clusterInfoInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			a.sendClusterInfo(ctx)
		}
	}
}

func (a *Agent) sendClusterInfo(ctx context.Context) {
	info := a.rec.CollectClusterInfo(ctx)

	nodes := make([]*kybersv1.NodeInfo, 0, len(info.Nodes))
	for _, n := range info.Nodes {
		nodes = append(nodes, &kybersv1.NodeInfo{
			Name:           n.Name,
			Ready:          n.Ready,
			Role:           n.Role,
			Architecture:   n.Architecture,
			OsImage:        n.OSImage,
			KubeletVersion: n.KubeletVersion,
			InternalIp:     n.InternalIP,
			CpuCapacity:    n.CPUCapacity,
			MemoryCapacity: n.MemoryCapacity,
			Pressures:      n.Pressures,
		})
	}

	if err := a.send(&kybersv1.AgentMessage{
		Payload: &kybersv1.AgentMessage_ClusterInfo{
			ClusterInfo: &kybersv1.ClusterInfo{
				K8SVersion:              info.K8sVersion,
				Platform:                info.Platform,
				NodeCount:               info.NodeCount,
				NodesReady:              info.NodesReady,
				Nodes:                   nodes,
				TotalCpu:                info.TotalCPU,
				TotalMemory:             info.TotalMemory,
				HasMetricsServer:        info.HasMetricsServer,
				HasCertManager:          info.HasCertManager,
				IngressClasses:          info.IngressClasses,
				IngressIps:              info.IngressIPs,
				StorageClass:            info.StorageClass,
				PrometheusUrl:           info.PrometheusURL,
				MetricsSource:           info.MetricsSource,
				AvailableMetricsSources: info.AvailableMetricsSources,
				ManagedNamespaces:       info.ManagedNamespaces,
				ManagedPods:             info.ManagedPods,
			},
		},
	}); err != nil {
		a.log.Debug("remontée de l'état du cluster impossible", "err", err)
	}
}

// handleSetMetricsSource applique le choix de source fait dans le dashboard.
func (a *Agent) handleSetMetricsSource(ctx context.Context, cmd *kybersv1.SetMetricsSourceCommand) {
	if u := cmd.GetPrometheusUrl(); u != "" {
		a.rec.SetPrometheusURL(u)
	}
	a.rec.SetPreferredSource(cmd.GetSource())

	source := cmd.GetSource()
	if source == "" {
		source = "automatique"
	}
	a.log.Info("source de métriques modifiée", "source", source)

	// Relevé immédiat : l'utilisateur voit l'effet de son choix sans attendre
	// le prochain cycle.
	a.sendUsage(ctx)
	a.sendClusterInfo(ctx)
}

// usageLoop remonte périodiquement la consommation du cluster.
func (a *Agent) usageLoop(ctx context.Context) {
	a.sendUsage(ctx)

	ticker := time.NewTicker(usageInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			a.sendUsage(ctx)
		}
	}
}

func (a *Agent) sendUsage(ctx context.Context) {
	u := a.rec.CollectUsage(ctx)
	if u == nil {
		// metrics-server absent : ne rien envoyer plutôt que des zéros, que le
		// dashboard interpréterait comme un cluster inactif.
		return
	}

	nodes := make([]*kybersv1.NodeUsage, 0, len(u.Nodes))
	for _, n := range u.Nodes {
		nodes = append(nodes, &kybersv1.NodeUsage{
			Name:           n.Name,
			CpuMillis:      n.CPUMillis,
			CpuCapacity:    n.CPUCapacity,
			MemoryBytes:    n.MemoryBytes,
			MemoryCapacity: n.MemoryCapacity,
			GpuCount:       n.GPUCount,
			GpuAllocated:   n.GPUAllocated,
		})
	}

	apps := make([]*kybersv1.AppUsage, 0, len(u.Apps))
	for _, ap := range u.Apps {
		apps = append(apps, &kybersv1.AppUsage{
			Namespace:    ap.Namespace,
			AppName:      ap.AppName,
			DeploymentId: ap.DeploymentID,
			CpuMillis:    ap.CPUMillis,
			MemoryBytes:  ap.MemoryBytes,
			PodCount:     ap.PodCount,
		})
	}

	if err := a.send(&kybersv1.AgentMessage{
		Payload: &kybersv1.AgentMessage_Usage{
			Usage: &kybersv1.UsageReport{
				TsUnix:              time.Now().Unix(),
				Nodes:               nodes,
				Apps:                apps,
				TotalCpuMillis:      u.TotalCPUMillis,
				TotalCpuCapacity:    u.TotalCPUCapacity,
				TotalMemoryBytes:    u.TotalMemoryBytes,
				TotalMemoryCapacity: u.TotalMemoryCapacity,
			},
		},
	}); err != nil {
		a.log.Debug("remontée de la consommation impossible", "err", err)
	}
}

func (a *Agent) send(msg *kybersv1.AgentMessage) error {
	a.sendMu.Lock()
	defer a.sendMu.Unlock()
	if a.stream == nil {
		return errors.New("stream non initialisé")
	}
	return a.stream.Send(msg)
}

// ---------------------------------------------------------------------------
// Conversion protobuf -> spec interne
// ---------------------------------------------------------------------------

func probeFromProto(p *kybersv1.Probe) *k8s.Probe {
	if p == nil || p.GetType() == kybersv1.Probe_TYPE_UNSPECIFIED {
		return nil
	}
	var typ string
	switch p.GetType() {
	case kybersv1.Probe_TYPE_HTTP_GET:
		typ = k8s.ProbeHTTP
	case kybersv1.Probe_TYPE_TCP_SOCKET:
		typ = k8s.ProbeTCP
	case kybersv1.Probe_TYPE_EXEC:
		typ = k8s.ProbeExec
	default:
		return nil
	}
	return &k8s.Probe{
		Type:             typ,
		Path:             p.GetPath(),
		Port:             p.GetPort(),
		InitialDelaySecs: p.GetInitialDelaySeconds(),
		PeriodSecs:       p.GetPeriodSeconds(),
		TimeoutSecs:      p.GetTimeoutSeconds(),
		FailureThreshold: p.GetFailureThreshold(),
		Command:          p.GetCommand(),
	}
}

func specFromDeploy(cmd *kybersv1.DeployCommand) k8s.Spec {
	s := k8s.Spec{
		DeploymentID:  cmd.GetDeploymentId(),
		AppName:       cmd.GetAppName(),
		Environment:   cmd.GetEnvironment(),
		Image:         cmd.GetImage(),
		Replicas:      cmd.GetReplicas(),
		ContainerPort: cmd.GetContainerPort(),
		Ports:         portsFromProto(cmd.GetPorts()),
		Env:           cmd.GetEnv(),
		SecretEnv:     cmd.GetSecretEnv(),
		Host:          cmd.GetHost(),
		TLS:           cmd.GetTls(),

		LivenessProbe:  probeFromProto(cmd.GetLivenessProbe()),
		ReadinessProbe: probeFromProto(cmd.GetReadinessProbe()),
		StartupProbe:   probeFromProto(cmd.GetStartupProbe()),

		NetworkPolicy: cmd.GetNetworkPolicy(),
		QuotaCPU:      cmd.GetQuotaCpu(),
		QuotaMemory:   cmd.GetQuotaMemory(),
		QuotaPods:     cmd.GetQuotaPods(),

		RunAsNonRoot:           cmd.GetRunAsNonRoot(),
		RunAsUser:              cmd.GetRunAsUser(),
		ReadOnlyRootFilesystem: cmd.GetReadOnlyRootFilesystem(),
	}

	if res := cmd.GetResources(); res != nil {
		s.Resources = k8s.Resources{
			CPURequest:    res.GetCpuRequest(),
			MemoryRequest: res.GetMemoryRequest(),
			CPULimit:      res.GetCpuLimit(),
			MemoryLimit:   res.GetMemoryLimit(),
		}
	}
	if as := cmd.GetAutoscaling(); as != nil {
		s.Autoscaling = k8s.Autoscaling{
			Enabled:          as.GetEnabled(),
			MinReplicas:      as.GetMinReplicas(),
			MaxReplicas:      as.GetMaxReplicas(),
			TargetCPUPercent: as.GetTargetCpuPercent(),
		}
	}
	if reg := cmd.GetRegistry(); reg != nil && reg.GetServer() != "" {
		s.Registry = &k8s.RegistryCredentials{
			Server:   reg.GetServer(),
			Username: reg.GetUsername(),
			Password: reg.GetPassword(),
			Email:    reg.GetEmail(),
		}
	}

	if s.Replicas < 0 {
		s.Replicas = 1
	}
	if s.ContainerPort <= 0 {
		s.ContainerPort = 8080
	}
	return s
}

// ---------------------------------------------------------------------------
// Traitement des ordres
// ---------------------------------------------------------------------------

// handleDeploy exécute un ordre de déploiement de bout en bout et remonte
// l'état à chaque étape.
func (a *Agent) handleDeploy(ctx context.Context, cmd *kybersv1.DeployCommand) {
	spec := specFromDeploy(cmd)
	startedAt := time.Now()

	a.log.Info("ordre de déploiement reçu",
		"deployment", spec.DeploymentID, "app", spec.AppName,
		"env", spec.Environment, "image", spec.Image, "namespace", spec.Namespace())

	a.reportStatus(spec, kybersv1.DeploymentStatus_PHASE_PROVISIONING,
		"application des ressources kubernetes", 0, spec.Replicas, "", "")

	if err := a.rec.Apply(ctx, spec); err != nil {
		a.log.Error("apply échoué", "deployment", spec.DeploymentID, "err", err)
		a.reportStatus(spec, kybersv1.DeploymentStatus_PHASE_FAILED,
			err.Error(), 0, spec.Replicas, "", "ApplyFailed")
		return
	}

	// Un déploiement à zéro replica est immédiatement "arrêté".
	if spec.Replicas == 0 {
		a.reportStatus(spec, kybersv1.DeploymentStatus_PHASE_STOPPED,
			"application arrêtée (0 replica)", 0, 0, "", "")
		return
	}

	waitCtx, cancel := context.WithTimeout(ctx, readyTimeout)
	defer cancel()

	err := a.rec.WaitReady(waitCtx, spec, readyTimeout, func(ready, desired int32) {
		msg := "démarrage des pods"
		if ready >= desired && desired > 0 {
			// L'agent observe encore les pods quelques secondes : sans ce
			// message, l'interface semblerait figée alors qu'elle vérifie que
			// le conteneur ne se termine pas aussitôt.
			msg = "pods prêts, vérification de la stabilité"
		}
		a.reportStatus(spec, kybersv1.DeploymentStatus_PHASE_PROVISIONING,
			msg, ready, desired, "", "")
	})

	// Les events expliquent l'échec là où les logs sont muets (image absente,
	// pod non planifiable...).
	a.shipEvents(ctx, spec, startedAt)

	if err != nil {
		reason := a.rec.FinalFailureReason(ctx, spec)
		if reason == "" {
			reason = "Timeout"
		}
		a.log.Error("pods non prêts", "deployment", spec.DeploymentID, "err", err)
		a.reportStatus(spec, kybersv1.DeploymentStatus_PHASE_FAILED,
			err.Error(), 0, spec.Replicas, "", reason)
		a.shipLogs(ctx, spec)
		return
	}

	url := ""
	if spec.Host != "" {
		scheme := "http://"
		if spec.TLS {
			scheme = "https://"
		}
		url = scheme + spec.Host
	}
	ready, desired, _ := a.rec.Status(ctx, spec)
	a.reportStatus(spec, kybersv1.DeploymentStatus_PHASE_RUNNING,
		"déploiement réussi", ready, desired, url, "")
	a.log.Info("déploiement réussi", "deployment", spec.DeploymentID, "url", url)

	a.shipLogs(ctx, spec)
}

func (a *Agent) handleDelete(ctx context.Context, cmd *kybersv1.DeleteCommand) {
	spec := k8s.Spec{
		DeploymentID: cmd.GetDeploymentId(),
		AppName:      cmd.GetAppName(),
		Environment:  cmd.GetEnvironment(),
	}
	a.stopLogStream(spec.DeploymentID)

	a.log.Info("suppression demandée",
		"namespace", spec.Namespace(), "namespace_entier", cmd.GetDeleteNamespace())

	if err := a.rec.Delete(ctx, spec, cmd.GetDeleteNamespace()); err != nil {
		a.log.Error("suppression échouée", "err", err)
		a.reportStatus(spec, kybersv1.DeploymentStatus_PHASE_FAILED,
			err.Error(), 0, 0, "", "DeleteFailed")
		return
	}
	a.reportStatus(spec, kybersv1.DeploymentStatus_PHASE_DELETED, "ressources supprimées", 0, 0, "", "")
}

func (a *Agent) handleScale(ctx context.Context, cmd *kybersv1.ScaleCommand) {
	spec := k8s.Spec{
		DeploymentID: cmd.GetDeploymentId(),
		AppName:      cmd.GetAppName(),
		Environment:  cmd.GetEnvironment(),
		Replicas:     cmd.GetReplicas(),
	}
	replicas := cmd.GetReplicas()
	a.log.Info("scale demandé", "namespace", spec.Namespace(), "replicas", replicas)

	if err := a.rec.Scale(ctx, spec, replicas); err != nil {
		a.log.Error("scale échoué", "err", err)
		a.reportCommandResult(cmd.GetCommandId(), spec.DeploymentID, false, err.Error())
		return
	}
	a.reportCommandResult(cmd.GetCommandId(), spec.DeploymentID, true, "scale appliqué")

	phase := kybersv1.DeploymentStatus_PHASE_RUNNING
	msg := "mise à l'échelle appliquée"
	if replicas == 0 {
		phase = kybersv1.DeploymentStatus_PHASE_STOPPED
		msg = "application arrêtée"
	}

	// Laisse le temps aux pods de converger avant de remonter le compte réel.
	waitCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	_ = a.rec.WaitReady(waitCtx, spec, 2*time.Minute, nil)

	ready, desired, _ := a.rec.Status(ctx, spec)
	a.reportStatus(spec, phase, msg, ready, desired, "", "")
}

func (a *Agent) handleRestart(ctx context.Context, cmd *kybersv1.RestartCommand) {
	spec := k8s.Spec{
		DeploymentID: cmd.GetDeploymentId(),
		AppName:      cmd.GetAppName(),
		Environment:  cmd.GetEnvironment(),
	}
	a.log.Info("redémarrage demandé", "namespace", spec.Namespace())

	if err := a.rec.Restart(ctx, spec); err != nil {
		a.log.Error("redémarrage échoué", "err", err)
		a.reportCommandResult(cmd.GetCommandId(), spec.DeploymentID, false, err.Error())
		return
	}
	a.reportCommandResult(cmd.GetCommandId(), spec.DeploymentID, true, "redémarrage déclenché")

	ready, desired, _ := a.rec.Status(ctx, spec)
	a.reportStatus(spec, kybersv1.DeploymentStatus_PHASE_PROVISIONING,
		"redémarrage des pods", ready, desired, "", "")
}

// ---------------------------------------------------------------------------
// Streaming des logs
// ---------------------------------------------------------------------------

// handleLogStream démarre ou arrête le suivi des logs d'un déploiement.
func (a *Agent) handleLogStream(ctx context.Context, cmd *kybersv1.LogStreamCommand) {
	spec := k8s.Spec{
		DeploymentID: cmd.GetDeploymentId(),
		AppName:      cmd.GetAppName(),
		Environment:  cmd.GetEnvironment(),
	}

	if !cmd.GetFollow() {
		a.stopLogStream(spec.DeploymentID)
		return
	}

	a.streamsMu.Lock()
	if _, exists := a.logStreams[spec.DeploymentID]; exists {
		a.streamsMu.Unlock()
		return // déjà suivi
	}
	streamCtx, cancel := context.WithCancel(ctx)
	a.logStreams[spec.DeploymentID] = cancel
	a.streamsMu.Unlock()

	a.log.Info("suivi des logs démarré", "deployment", spec.DeploymentID)
	go a.followPods(streamCtx, spec)
}

// followPods suit les logs de chaque pod de l'application, et prend en compte
// les pods créés après le démarrage du suivi (redémarrage, scale up).
func (a *Agent) followPods(ctx context.Context, spec k8s.Spec) {
	defer a.stopLogStream(spec.DeploymentID)

	followed := map[string]bool{}
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()

	for {
		pods, err := a.rec.PodNames(ctx, spec)
		if err == nil {
			for _, pod := range pods {
				if followed[pod] {
					continue
				}
				followed[pod] = true
				go func(podName string) {
					err := a.rec.StreamLogs(ctx, spec.Namespace(), podName, func(line string) {
						_ = a.send(&kybersv1.AgentMessage{
							Payload: &kybersv1.AgentMessage_LogChunk{
								LogChunk: &kybersv1.LogChunk{
									DeploymentId: spec.DeploymentID,
									PodName:      podName,
									Line:         line,
									TsUnix:       time.Now().Unix(),
								},
							},
						})
					})
					if err != nil && ctx.Err() == nil && !errors.Is(err, io.EOF) {
						a.log.Debug("suivi des logs interrompu", "pod", podName, "err", err)
					}
				}(pod)
			}
		}

		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (a *Agent) stopLogStream(deploymentID string) {
	a.streamsMu.Lock()
	defer a.streamsMu.Unlock()
	if cancel, ok := a.logStreams[deploymentID]; ok {
		cancel()
		delete(a.logStreams, deploymentID)
		a.log.Info("suivi des logs arrêté", "deployment", deploymentID)
	}
}

func (a *Agent) stopAllLogStreams() {
	a.streamsMu.Lock()
	defer a.streamsMu.Unlock()
	for id, cancel := range a.logStreams {
		cancel()
		delete(a.logStreams, id)
	}
}

// ---------------------------------------------------------------------------
// Remontée d'informations
// ---------------------------------------------------------------------------

// shipLogs remonte les dernières lignes de chaque pod au Control Plane.
func (a *Agent) shipLogs(ctx context.Context, spec k8s.Spec) {
	pods, err := a.rec.PodNames(ctx, spec)
	if err != nil {
		a.log.Warn("liste des pods impossible", "err", err)
		return
	}
	for _, pod := range pods {
		lines, err := a.rec.TailLogs(ctx, spec.Namespace(), pod, a.cfg.LogTailLine)
		if err != nil {
			// Fréquent quand le conteneur n'a pas encore démarré.
			a.log.Debug("logs indisponibles", "pod", pod, "err", err)
			continue
		}
		for _, line := range lines {
			_ = a.send(&kybersv1.AgentMessage{
				Payload: &kybersv1.AgentMessage_LogChunk{
					LogChunk: &kybersv1.LogChunk{
						DeploymentId: spec.DeploymentID,
						PodName:      pod,
						Line:         line,
						TsUnix:       time.Now().Unix(),
					},
				},
			})
		}
	}
}

// shipEvents remonte les events Kubernetes survenus depuis le début du
// déploiement : ce sont eux qui expliquent un ImagePullBackOff.
func (a *Agent) shipEvents(ctx context.Context, spec k8s.Spec, since time.Time) {
	events, err := a.rec.RecentEvents(ctx, spec, since)
	if err != nil {
		a.log.Debug("events indisponibles", "err", err)
		return
	}
	for _, e := range events {
		_ = a.send(&kybersv1.AgentMessage{
			Payload: &kybersv1.AgentMessage_PodEvent{
				PodEvent: &kybersv1.PodEvent{
					DeploymentId: spec.DeploymentID,
					PodName:      e.PodName,
					Type:         e.Type,
					Reason:       e.Reason,
					Message:      e.Message,
					TsUnix:       e.TS.Unix(),
				},
			},
		})
	}
}

func (a *Agent) reportStatus(spec k8s.Spec, phase kybersv1.DeploymentStatus_Phase,
	msg string, ready, desired int32, url, reason string) {
	if err := a.send(&kybersv1.AgentMessage{
		Payload: &kybersv1.AgentMessage_DeploymentStatus{
			DeploymentStatus: &kybersv1.DeploymentStatus{
				DeploymentId:    spec.DeploymentID,
				Phase:           phase,
				Message:         msg,
				ReadyReplicas:   ready,
				DesiredReplicas: desired,
				Url:             url,
				Reason:          reason,
			},
		},
	}); err != nil {
		a.log.Warn("remontée de statut impossible", "err", err)
	}
}

func (a *Agent) reportCommandResult(commandID, deploymentID string, success bool, message string) {
	if commandID == "" {
		return
	}
	if err := a.send(&kybersv1.AgentMessage{
		Payload: &kybersv1.AgentMessage_CommandResult{
			CommandResult: &kybersv1.CommandResult{
				CommandId:    commandID,
				DeploymentId: deploymentID,
				Success:      success,
				Message:      message,
			},
		},
	}); err != nil {
		a.log.Warn("remontée du résultat de commande impossible", "err", err)
	}
}

// portsFromProto convertit les ports reçus du Control Plane.
//
// Une commande sans ports vient d'un Control Plane antérieur au multi-port :
// la Spec retombe alors sur `container_port`.
func portsFromProto(in []*kybersv1.ContainerPortSpec) []k8s.Port {
	if len(in) == 0 {
		return nil
	}
	out := make([]k8s.Port, 0, len(in))
	for _, p := range in {
		out = append(out, k8s.Port{
			Port:     p.GetPort(),
			Name:     p.GetName(),
			Exposed:  p.GetExposed(),
			Protocol: p.GetProtocol(),
		})
	}
	return out
}
