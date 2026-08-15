package grpcserver

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	kybersv1 "github.com/kybers/kybers/proto/gen/kybers/v1"

	"github.com/kybers/kybers/control-plane/internal/db"
	"github.com/kybers/kybers/control-plane/internal/hostname"
	"github.com/kybers/kybers/control-plane/internal/models"
)

// Dispatcher vide périodiquement les files d'attente (déploiements et
// commandes de cycle de vie) vers les agents connectés.
//
// Le polling, plutôt qu'un push direct depuis l'API, garde l'API découplée du
// transport et rend le système résilient : un ordre créé alors qu'aucun agent
// n'est connecté partira dès la reconnexion.
type Dispatcher struct {
	db       *db.DB
	srv      *Server
	log      *slog.Logger
	interval time.Duration
	// Détermine si l'Ingress doit demander un certificat TLS.
	hosts *hostname.Generator
	// Durées de conservation appliquées par la purge périodique.
	retention Retention
}

func NewDispatcher(database *db.DB, srv *Server, log *slog.Logger,
	hosts *hostname.Generator, retention Retention) *Dispatcher {
	return &Dispatcher{
		db:        database,
		srv:       srv,
		log:       log,
		interval:  2 * time.Second,
		hosts:     hosts,
		retention: retention,
	}
}

// Retention regroupe les durées de conservation des données qui croissent
// avec l'usage.
type Retention struct {
	// Logs et events applicatifs, en heures.
	LogsHours int
	// Relevés de consommation, en heures.
	UsageHours int
	// Commandes terminées, en jours.
	CommandDays int
	// Révisions conservées par environnement ; les plus récentes sont gardées,
	// et jamais la révision active.
	KeepRevisions int
}

// DefaultRetention : valeurs applicables sans configuration.
func DefaultRetention() Retention {
	return Retention{
		LogsHours:     72,
		UsageHours:    24,
		CommandDays:   7,
		KeepRevisions: 20,
	}
}

func (d *Dispatcher) Run(ctx context.Context) {
	ticker := time.NewTicker(d.interval)
	defer ticker.Stop()

	// La purge est peu fréquente : une fois par heure suffit à contenir la
	// croissance de la table.
	go d.purgeLoop(ctx)

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			d.tick(ctx)
		}
	}
}

// purgeLoop applique la rétention aux données qui croissent avec l'usage.
func (d *Dispatcher) purgeLoop(ctx context.Context) {
	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()

	// Une première passe au démarrage évite d'attendre une heure après un
	// redémarrage pour nettoyer ce qui s'est accumulé.
	if c, err := d.db.PurgeOldData(ctx, d.retention.LogsHours, d.retention.UsageHours,
		d.retention.CommandDays, d.retention.KeepRevisions); err == nil {
		if total := c.Logs + c.Events + c.Usage + c.Commands + c.Deployments; total > 0 {
			d.log.Info("purge au démarrage", "lignes supprimées", total)
		}
	}

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			c, err := d.db.PurgeOldData(ctx,
				d.retention.LogsHours, d.retention.UsageHours,
				d.retention.CommandDays, d.retention.KeepRevisions)
			if err != nil {
				d.log.Error("purge", "err", err)
				continue
			}
			total := c.Logs + c.Events + c.Usage + c.Commands + c.Deployments
			if total > 0 {
				d.log.Info("purge effectuée",
					"logs", c.Logs, "events", c.Events, "relevés", c.Usage,
					"commandes", c.Commands, "révisions", c.Deployments)
			}
		}
	}
}

func (d *Dispatcher) tick(ctx context.Context) {
	// Inutile de réclamer des ordres si personne ne peut les exécuter :
	// on les laisserait en "dispatched" sans agent pour les traiter.
	if len(d.srv.ConnectedAgents()) == 0 {
		return
	}
	d.dispatchDeployments(ctx)
	d.dispatchCommands(ctx)
}

// ---------------------------------------------------------------------------
// Déploiements
// ---------------------------------------------------------------------------

func (d *Dispatcher) dispatchDeployments(ctx context.Context) {
	pending, err := d.db.ClaimPendingDeployments(ctx, 10)
	if err != nil {
		d.log.Error("ClaimPendingDeployments", "err", err)
		return
	}

	for _, dep := range pending {
		cmd, clusterID, err := d.buildDeployCommand(ctx, dep)
		if err != nil {
			d.log.Error("construction de l'ordre de déploiement",
				"err", err, "deployment", dep.ID)
			_ = d.db.ResetToPending(ctx, dep.ID, err.Error())
			continue
		}

		if err := d.srv.Dispatch(clusterID, cmd); err != nil {
			// L'agent s'est déconnecté entre le check et l'envoi : on remet en
			// file plutôt que de perdre le déploiement.
			d.log.Warn("dispatch impossible, remise en attente", "deployment", dep.ID, "err", err)
			_ = d.db.ResetToPending(ctx, dep.ID, err.Error())
			continue
		}
		d.log.Info("déploiement envoyé à l'agent",
			"deployment", dep.ID, "app", cmd.GetAppName(),
			"env", dep.Environment, "révision", dep.Revision)
	}
}

// buildDeployCommand assemble l'ordre complet : application, configuration
// d'exécution, variables (simples et secrètes) et identifiants de registry.
func (d *Dispatcher) buildDeployCommand(ctx context.Context, dep models.Deployment) (*kybersv1.DeployCommand, string, error) {
	app, err := d.db.GetAppUnscoped(ctx, dep.AppID)
	if err != nil {
		return nil, "", err
	}

	cfg, err := d.db.GetAppConfig(ctx, dep.AppID, dep.Environment)
	if err != nil {
		return nil, "", err
	}

	envVars, err := d.db.GetEnvVars(ctx, dep.AppID, dep.Environment)
	if err != nil {
		d.log.Error("GetEnvVars", "err", err)
		envVars = map[string]string{}
	}

	// Déchiffrées ici, transmises uniquement à l'agent via gRPC.
	secretVars, err := d.db.GetSecretVars(ctx, dep.AppID, dep.Environment)
	if err != nil {
		return nil, "", err
	}

	cmd := &kybersv1.DeployCommand{
		DeploymentId:  dep.ID,
		AppName:       app.Name,
		Environment:   dep.Environment,
		Image:         dep.Image,
		Replicas:      int32(dep.Replicas),
		ContainerPort: int32(app.ExposedPort()),
		Ports:         portsToProto(app.Ports),
		Env:           envVars,
		SecretEnv:     secretVars,
		Host:          dep.Host,
		// Un certificat n'est demandé que sur un domaine maîtrisé : sur nip.io
		// la validation cert-manager échouerait.
		Tls: dep.Host != "" && d.hosts.TLS(),

		LivenessProbe:  probeToProto(cfg.LivenessProbe),
		ReadinessProbe: probeToProto(cfg.ReadinessProbe),
		StartupProbe:   probeToProto(cfg.StartupProbe),

		Resources: &kybersv1.Resources{
			CpuRequest:    cfg.CPURequest,
			MemoryRequest: cfg.MemoryRequest,
			CpuLimit:      cfg.CPULimit,
			MemoryLimit:   cfg.MemoryLimit,
		},
		Autoscaling: &kybersv1.Autoscaling{
			Enabled:          cfg.AutoscalingEnabled,
			MinReplicas:      int32(cfg.AutoscalingMin),
			MaxReplicas:      int32(cfg.AutoscalingMax),
			TargetCpuPercent: int32(cfg.AutoscalingCPU),
		},

		NetworkPolicy: cfg.NetworkPolicy,
		QuotaCpu:      cfg.QuotaCPU,
		QuotaMemory:   cfg.QuotaMemory,
		QuotaPods:     int32(cfg.QuotaPods),

		RunAsNonRoot:           cfg.RunAsNonRoot,
		RunAsUser:              cfg.RunAsUser,
		ReadOnlyRootFilesystem: cfg.ReadOnlyRootFS,
	}

	if cfg.RegistryID != nil {
		reg, err := d.db.GetRegistryWithPassword(ctx, *cfg.RegistryID)
		if err != nil {
			return nil, "", err
		}
		cmd.Registry = &kybersv1.RegistryCredentials{
			Server:   reg.Server,
			Username: reg.Username,
			Password: reg.Password,
			Email:    reg.Email,
		}
	}

	clusterID := ""
	if app.ClusterID != nil {
		clusterID = *app.ClusterID
	}
	return cmd, clusterID, nil
}

func probeToProto(p *models.Probe) *kybersv1.Probe {
	if !p.Enabled() {
		return nil
	}
	var typ kybersv1.Probe_Type
	switch p.Type {
	case "http":
		typ = kybersv1.Probe_TYPE_HTTP_GET
	case "tcp":
		typ = kybersv1.Probe_TYPE_TCP_SOCKET
	case "exec":
		typ = kybersv1.Probe_TYPE_EXEC
	default:
		return nil
	}
	return &kybersv1.Probe{
		Type:                typ,
		Path:                p.Path,
		Port:                int32(p.Port),
		InitialDelaySeconds: int32(p.InitialDelaySecs),
		PeriodSeconds:       int32(p.PeriodSecs),
		TimeoutSeconds:      int32(p.TimeoutSecs),
		FailureThreshold:    int32(p.FailureThreshold),
		Command:             p.Command,
	}
}

// ---------------------------------------------------------------------------
// Commandes de cycle de vie
// ---------------------------------------------------------------------------

func (d *Dispatcher) dispatchCommands(ctx context.Context) {
	cmds, err := d.db.ClaimPendingCommands(ctx, 10)
	if err != nil {
		d.log.Error("ClaimPendingCommands", "err", err)
		return
	}

	for _, c := range cmds {
		dep, err := d.db.GetDeployment(ctx, c.DeploymentID)
		if err != nil {
			d.log.Error("GetDeployment", "err", err, "command", c.ID)
			_ = d.db.UpdateCommandStatus(ctx, c.ID, models.CmdFailed, "déploiement introuvable")
			continue
		}

		msg, err := buildCommandMessage(c, dep)
		if err != nil {
			d.log.Error("construction de la commande", "err", err, "command", c.ID)
			_ = d.db.UpdateCommandStatus(ctx, c.ID, models.CmdFailed, err.Error())
			continue
		}

		app, err := d.db.GetAppUnscoped(ctx, dep.AppID)
		clusterID := ""
		if err == nil && app.ClusterID != nil {
			clusterID = *app.ClusterID
		}

		if err := d.srv.Send(clusterID, msg); err != nil {
			d.log.Warn("envoi de commande impossible, remise en attente",
				"command", c.ID, "err", err)
			_ = d.db.ResetCommandToPending(ctx, c.ID, err.Error())
			continue
		}
		d.log.Info("commande envoyée à l'agent",
			"command", c.ID, "type", c.Kind, "deployment", c.DeploymentID)
	}
}

func buildCommandMessage(c models.Command, dep *models.Deployment) (*kybersv1.ServerMessage, error) {
	switch c.Kind {
	case models.CommandScale:
		var payload struct {
			Replicas int `json:"replicas"`
		}
		if err := json.Unmarshal(c.Payload, &payload); err != nil {
			return nil, err
		}
		return &kybersv1.ServerMessage{
			Payload: &kybersv1.ServerMessage_Scale{
				Scale: &kybersv1.ScaleCommand{
					CommandId:    c.ID,
					DeploymentId: dep.ID,
					AppName:      dep.AppName,
					Environment:  dep.Environment,
					Replicas:     int32(payload.Replicas),
				},
			},
		}, nil

	case models.CommandRestart:
		return &kybersv1.ServerMessage{
			Payload: &kybersv1.ServerMessage_Restart{
				Restart: &kybersv1.RestartCommand{
					CommandId:    c.ID,
					DeploymentId: dep.ID,
					AppName:      dep.AppName,
					Environment:  dep.Environment,
				},
			},
		}, nil

	case models.CommandDelete:
		var payload struct {
			DeleteNamespace bool `json:"delete_namespace"`
		}
		_ = json.Unmarshal(c.Payload, &payload)
		return &kybersv1.ServerMessage{
			Payload: &kybersv1.ServerMessage_Delete{
				Delete: &kybersv1.DeleteCommand{
					DeploymentId:    dep.ID,
					AppName:         dep.AppName,
					Environment:     dep.Environment,
					DeleteNamespace: payload.DeleteNamespace,
				},
			},
		}, nil
	}
	return nil, errUnknownCommand(c.Kind)
}

type errUnknownCommand string

func (e errUnknownCommand) Error() string { return "type de commande inconnu: " + string(e) }

// portsToProto transmet les ports de l'application à l'agent.
//
// Une application sans port explicite reste décrite par `container_port` seul :
// l'agent sait retomber dessus.
func portsToProto(ports []models.AppPort) []*kybersv1.ContainerPortSpec {
	if len(ports) == 0 {
		return nil
	}
	out := make([]*kybersv1.ContainerPortSpec, 0, len(ports))
	for _, p := range ports {
		out = append(out, &kybersv1.ContainerPortSpec{
			Port:     int32(p.Port),
			Name:     p.Name,
			Exposed:  p.Exposed,
			Protocol: p.Protocol,
		})
	}
	return out
}
