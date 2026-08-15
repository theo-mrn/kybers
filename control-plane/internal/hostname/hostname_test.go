package hostname

import "testing"

func TestAvecDomaine(t *testing.T) {
	g := New("apps.exemple.fr", "217.65.146.24")

	if got := g.For("backstage", "demo"); got != "backstage-demo.apps.exemple.fr" {
		t.Errorf("For = %q", got)
	}
	// Le domaine configuré prime sur le repli nip.io.
	if got := g.For("api", "prod"); got != "api-prod.apps.exemple.fr" {
		t.Errorf("For = %q", got)
	}
	if !g.TLS() {
		t.Error("un domaine maîtrisé doit permettre HTTPS")
	}
	if got := g.URL("api-prod.apps.exemple.fr"); got != "https://api-prod.apps.exemple.fr" {
		t.Errorf("URL = %q", got)
	}
}

func TestRepliNipIo(t *testing.T) {
	g := New("", "217.65.146.24")

	want := "backstage-demo.217.65.146.24.nip.io"
	if got := g.For("backstage", "demo"); got != want {
		t.Errorf("For = %q, attendu %q", got, want)
	}
	// Sans domaine maîtrisé, aucun certificat Let's Encrypt n'est possible.
	if g.TLS() {
		t.Error("le repli nip.io ne doit pas annoncer HTTPS")
	}
	if got := g.URL(want); got != "http://"+want {
		t.Errorf("URL = %q", got)
	}
}

func TestDesactive(t *testing.T) {
	g := New("", "")
	if g.Enabled() {
		t.Error("sans domaine ni IP, la génération doit être désactivée")
	}
	if got := g.For("app", "env"); got != "" {
		t.Errorf("For = %q, attendu une chaîne vide", got)
	}
	if got := g.URL(""); got != "" {
		t.Errorf("URL = %q", got)
	}
}

// Les noms d'application et d'environnement viennent de l'utilisateur : ils
// doivent produire un label DNS valide, sinon l'Ingress est rejeté.
func TestLabelsDNSValides(t *testing.T) {
	g := New("exemple.fr", "")

	cases := []struct{ app, env, want string }{
		{"Mon_App", "Prod", "mon-app-prod.exemple.fr"},
		{"api.v2", "staging", "api-v2-staging.exemple.fr"},
		// Les séparateurs consécutifs ne doivent pas produire "--".
		{"my__app", "dev", "my-app-dev.exemple.fr"},
		{"-bord-", "test", "bord-test.exemple.fr"},
	}
	for _, c := range cases {
		if got := g.For(c.app, c.env); got != c.want {
			t.Errorf("For(%q,%q) = %q, attendu %q", c.app, c.env, got, c.want)
		}
	}
}

func TestLabelTronque(t *testing.T) {
	long := ""
	for i := 0; i < 80; i++ {
		long += "a"
	}
	g := New("exemple.fr", "")

	host := g.For(long, "prod")
	label := host[:len(host)-len(".exemple.fr")]
	if len(label) > 63 {
		t.Errorf("label de %d caractères, maximum 63", len(label))
	}
	if label[len(label)-1] == '-' {
		t.Error("le label ne doit pas finir par un tiret")
	}
}

// Un point final dans le domaine configuré ne doit pas produire "app..domaine".
func TestDomaineNormalise(t *testing.T) {
	g := New("  .apps.exemple.fr.  ", "")
	if got := g.For("api", "prod"); got != "api-prod.apps.exemple.fr" {
		t.Errorf("For = %q", got)
	}
}
