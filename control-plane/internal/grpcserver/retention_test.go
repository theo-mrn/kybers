package grpcserver

import "testing"

func TestDefaultRetention(t *testing.T) {
	r := DefaultRetention()

	// Des valeurs nulles désactiveraient la purge ou supprimeraient tout.
	if r.LogsHours <= 0 || r.UsageHours <= 0 || r.CommandDays <= 0 {
		t.Errorf("durées invalides: %+v", r)
	}
	// L'historique et le rollback dépendent des révisions conservées.
	if r.KeepRevisions < 2 {
		t.Errorf("KeepRevisions = %d : trop faible pour permettre un rollback", r.KeepRevisions)
	}
	// Les relevés de consommation sont bien plus volumineux que les logs
	// (un échantillon toutes les 30 s) : les garder aussi longtemps ferait
	// grossir la base inutilement.
	if r.UsageHours > r.LogsHours {
		t.Errorf("les relevés (%d h) ne devraient pas être conservés plus longtemps que les logs (%d h)",
			r.UsageHours, r.LogsHours)
	}
}
