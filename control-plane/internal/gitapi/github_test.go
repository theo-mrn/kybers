package gitapi

import "testing"

// Les utilisateurs collent aussi bien « owner/nom » que l'URL de leur
// navigateur : les deux doivent aboutir à la même référence.
func TestParseRepo(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"acme/api", "acme/api"},
		{"https://github.com/acme/api", "acme/api"},
		{"https://github.com/acme/api.git", "acme/api"},
		{"https://github.com/acme/api/", "acme/api"},
		{"git@github.com:acme/api.git", "acme/api"},
		{"  acme/api  ", "acme/api"},
		// Une URL profonde reste exploitable : seuls les deux derniers
		// segments identifient le dépôt.
		{"https://github.com/acme/api/tree/main", "acme/api"},
	}

	for _, c := range cases {
		got, err := ParseRepo(c.in)
		if err != nil {
			t.Fatalf("ParseRepo(%q) : %v", c.in, err)
		}
		if got != c.want {
			t.Errorf("ParseRepo(%q) = %q, attendu %q", c.in, got, c.want)
		}
	}
}

func TestParseRepoRejects(t *testing.T) {
	for _, in := range []string{"", "api", "   "} {
		if _, err := ParseRepo(in); err == nil {
			t.Errorf("ParseRepo(%q) aurait dû échouer", in)
		}
	}
}

// Sans jeton, le client reste utilisable mais inerte : l'intégration Git est
// facultative et ne doit pas empêcher le démarrage.
func TestNotConfigured(t *testing.T) {
	c := New("", "")
	if c.Configured(t.Context()) {
		t.Fatal("un client sans jeton ne doit pas être configuré")
	}
	if _, err := c.GetRepo(t.Context(), "acme/api"); err == nil {
		t.Fatal("un client sans jeton doit refuser les appels")
	}
}
