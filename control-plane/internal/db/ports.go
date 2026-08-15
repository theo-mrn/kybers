package db

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/kybers/kybers/control-plane/internal/models"
)

// Ports ouverts par une application.
//
// Une image peut en ouvrir plusieurs : un port applicatif et un port de
// métriques, par exemple. Tous deviennent des entrées du Service Kubernetes ;
// seul le port exposé est routé par l'Ingress.

// ListAppPorts retourne les ports d'une application, dans l'ordre d'affichage.
func (d *DB) ListAppPorts(ctx context.Context, appID string) ([]models.AppPort, error) {
	rows, err := d.Pool.Query(ctx, `
		SELECT port, name, exposed, protocol
		FROM app_ports WHERE app_id = $1
		ORDER BY position, port`, appID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []models.AppPort{}
	for rows.Next() {
		var p models.AppPort
		if err := rows.Scan(&p.Port, &p.Name, &p.Exposed, &p.Protocol); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// listPortsFor charge les ports de plusieurs applications en une requête.
//
// Sans cela, lister N applications déclencherait N requêtes supplémentaires.
func (d *DB) listPortsFor(ctx context.Context, appIDs []string) (map[string][]models.AppPort, error) {
	out := map[string][]models.AppPort{}
	if len(appIDs) == 0 {
		return out, nil
	}

	rows, err := d.Pool.Query(ctx, `
		SELECT app_id, port, name, exposed, protocol
		FROM app_ports WHERE app_id = ANY($1)
		ORDER BY position, port`, appIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var appID string
		var p models.AppPort
		if err := rows.Scan(&appID, &p.Port, &p.Name, &p.Exposed, &p.Protocol); err != nil {
			return nil, err
		}
		out[appID] = append(out[appID], p)
	}
	return out, rows.Err()
}

// SetAppPorts remplace les ports d'une application.
//
// L'écriture est transactionnelle : une liste refusée en cours de route ne doit
// pas laisser l'application sans aucun port, ce qui la rendrait indéployable.
func (d *DB) SetAppPorts(ctx context.Context, appID string, ports []models.AppPort) error {
	if len(ports) == 0 {
		return fmt.Errorf("au moins un port est requis")
	}

	// L'Ingress ne route que vers une destination : deux ports publics sur un
	// même hôte seraient ambigus. La base l'interdit aussi, mais un message
	// clair vaut mieux qu'une violation de contrainte.
	exposed := 0
	seen := map[string]bool{}
	for _, p := range ports {
		if p.Port <= 0 || p.Port > 65535 {
			return fmt.Errorf("port invalide : %d", p.Port)
		}
		if p.Protocol != "UDP" {
			p.Protocol = "TCP"
		}
		key := fmt.Sprintf("%d/%s", p.Port, p.Protocol)
		if seen[key] {
			return fmt.Errorf("port en double : %d", p.Port)
		}
		seen[key] = true
		if p.Exposed {
			exposed++
		}
	}
	if exposed > 1 {
		return fmt.Errorf("un seul port peut être exposé publiquement")
	}

	tx, err := d.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `DELETE FROM app_ports WHERE app_id = $1`, appID); err != nil {
		return err
	}

	rows := make([][]any, 0, len(ports))
	for i, p := range ports {
		protocol := p.Protocol
		if protocol != "UDP" {
			protocol = "TCP"
		}
		name := p.Name
		if name == "" {
			// Kubernetes exige un nom quand un Service porte plusieurs ports.
			name = fmt.Sprintf("port-%d", p.Port)
		}
		rows = append(rows, []any{appID, p.Port, name, p.Exposed, protocol, i})
	}

	_, err = tx.CopyFrom(ctx,
		pgx.Identifier{"app_ports"},
		[]string{"app_id", "port", "name", "exposed", "protocol", "position"},
		pgx.CopyFromRows(rows))
	if err != nil {
		return err
	}

	// `apps.container_port` reste le port public : les clients de l'API qui ne
	// connaissent pas encore `ports` continuent de voir la bonne valeur.
	public := ports[0].Port
	for _, p := range ports {
		if p.Exposed {
			public = p.Port
			break
		}
	}
	if _, err := tx.Exec(ctx,
		`UPDATE apps SET container_port = $2 WHERE id = $1`, appID, public); err != nil {
		return err
	}

	return tx.Commit(ctx)
}
