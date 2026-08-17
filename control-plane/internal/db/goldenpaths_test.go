package db

import "testing"

func TestSlugOf(t *testing.T) {
	cases := map[string]string{
		"Service Node":   "service-node",
		"Service Python": "service-python",
		"Service Go":     "service-go",
		"  Étrange !! ":  "trange",
		"A--B":           "a--b",
	}
	for in, want := range cases {
		if got := slugOf(in); got != want {
			t.Errorf("slugOf(%q) = %q, attendu %q", in, got, want)
		}
	}
}

// Les clés exposées doivent être uniques : elles servent d'identifiant d'API.
func TestBuiltinKeysUnique(t *testing.T) {
	seen := map[string]bool{}
	for _, gp := range ListBuiltinGoldenPaths() {
		if gp.Key == "" {
			t.Errorf("%s : clé vide", gp.Folder.Name)
		}
		if seen[gp.Key] {
			t.Errorf("clé dupliquée : %s", gp.Key)
		}
		seen[gp.Key] = true

		if gp.Folder.DefaultPort == 0 || len(gp.Files) == 0 {
			t.Errorf("%s : préfait incomplet", gp.Key)
		}
		t.Logf("%-16s port=%d fichiers=%d", gp.Key, gp.Folder.DefaultPort, len(gp.Files))
	}
}
