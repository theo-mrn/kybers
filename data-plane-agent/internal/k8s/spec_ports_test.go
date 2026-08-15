package k8s

import "testing"

// Une commande sans ports vient d'un Control Plane antérieur au multi-port :
// la Spec doit retomber sur le port unique plutôt que de n'en exposer aucun.
func TestEffectivePortsFallback(t *testing.T) {
	s := Spec{ContainerPort: 8080}
	got := s.EffectivePorts()

	if len(got) != 1 {
		t.Fatalf("attendu 1 port, obtenu %d", len(got))
	}
	if got[0].Port != 8080 || !got[0].Exposed {
		t.Fatalf("le port unique doit être exposé : %+v", got[0])
	}
}

// Deux ports publics rendraient la cible de l'Ingress ambiguë.
func TestEffectivePortsSingleExposed(t *testing.T) {
	s := Spec{
		ContainerPort: 3000,
		Ports: []Port{
			{Port: 3000, Name: "http", Exposed: true},
			{Port: 7001, Name: "metrics", Exposed: true},
		},
	}
	got := s.EffectivePorts()

	exposed := 0
	for _, p := range got {
		if p.Exposed {
			exposed++
		}
	}
	if exposed != 1 {
		t.Fatalf("un seul port doit rester exposé, obtenu %d", exposed)
	}
	if s.ExposedPort() != 3000 {
		t.Fatalf("le premier port public doit être retenu, obtenu %d", s.ExposedPort())
	}
}

// Sans port explicitement public, l'Ingress doit tout de même pointer quelque
// part : le premier tient ce rôle.
func TestEffectivePortsDefaultsExposed(t *testing.T) {
	s := Spec{Ports: []Port{{Port: 3000}, {Port: 7001}}}
	got := s.EffectivePorts()

	if !got[0].Exposed {
		t.Fatal("le premier port doit devenir public par défaut")
	}
	// Kubernetes exige un nom dès qu'un Service porte plusieurs ports.
	for _, p := range got {
		if p.Name == "" {
			t.Fatalf("port sans nom : %+v", p)
		}
		if p.Protocol != "TCP" {
			t.Fatalf("protocole par défaut attendu TCP : %+v", p)
		}
	}
}
