package registryapi

import "testing"

func names(vs []Version) []string {
	out := make([]string, len(vs))
	for i, v := range vs {
		out[i] = v.Name
	}
	return out
}

func eq(t *testing.T, got, want []string, label string) {
	t.Helper()
	if len(got) != len(want) {
		t.Errorf("%s : %v, attendu %v", label, got, want)
		return
	}
	for i := range got {
		if got[i] != want[i] {
			t.Errorf("%s : %v, attendu %v", label, got, want)
			return
		}
	}
}

func tags(names ...string) []Tag {
	out := make([]Tag, len(names))
	for i, n := range names {
		out[i] = Tag{Name: n}
	}
	return out
}

func TestFilterVersionsEcarteLeBruit(t *testing.T) {
	// Un échantillon représentatif des tags publiés par l'image node.
	in := tags(
		"latest", "lts", "iron", "current-alpine",
		"22-alpine", "22-bookworm", "22.11.0-slim", "22.11.0-alpine3.20",
		"22", "22.11.0", "22.10.0", "20.18.1", "24.0.1",
		"23.0.0-rc.1", "nightly", "", "  ",
	)
	got := names(FilterVersions(in, 0))
	eq(t, got, []string{"24.0.1", "22", "22.11.0", "22.10.0", "20.18.1"}, "filtrage")
}

func TestFilterVersionsTriDecroissant(t *testing.T) {
	got := names(FilterVersions(tags("3.11", "3.13", "3.9", "3.12"), 0))
	eq(t, got, []string{"3.13", "3.12", "3.11", "3.9"}, "tri numérique")

	// 3.9 doit passer après 3.13 : un tri lexical donnerait l'inverse.
	got = names(FilterVersions(tags("1.9.0", "1.10.0", "1.24.1"), 0))
	eq(t, got, []string{"1.24.1", "1.10.0", "1.9.0"}, "tri sur mineure")
}

func TestFilterVersionsFlottantAvantFige(t *testing.T) {
	// « 22 » désigne la dernière 22.x : il doit précéder toute la série, pas
	// se ranger à sa place numérique.
	vs := FilterVersions(tags("22.0.0", "22.11.0", "22"), 0)
	eq(t, names(vs), []string{"22", "22.11.0", "22.0.0"}, "flottant en tête")
	if !vs[0].Floating || vs[1].Floating {
		t.Errorf("Floating mal détecté : %+v", vs)
	}
}

func TestFilterVersionsMinMajor(t *testing.T) {
	got := names(FilterVersions(tags("22", "20", "18", "0.10", "4"), 20))
	eq(t, got, []string{"22", "20"}, "minMajor")
}

func TestFilterVersionsDoublons(t *testing.T) {
	got := names(FilterVersions(tags("22", "22", "22"), 0))
	eq(t, got, []string{"22"}, "doublons")
}

func TestFilterVersionsPrefixeV(t *testing.T) {
	// Certains registres préfixent d'un « v » : le tag est conservé tel quel,
	// car c'est lui qui sera écrit dans le Dockerfile.
	got := names(FilterVersions(tags("v1.24", "1.23"), 0))
	eq(t, got, []string{"v1.24", "1.23"}, "préfixe v")
}

func TestKeepAllowed(t *testing.T) {
	all := FilterVersions(tags("24.1.0", "24", "22.11.0", "22", "20.5.0", "20"), 0)

	// Une majeure autorisée conserve tous ses correctifs.
	eq(t, names(KeepAllowed(all, []string{"22", "20"})),
		[]string{"22", "22.11.0", "20", "20.5.0"}, "filtre par majeure")

	// Sans liste, rien n'est retiré.
	eq(t, names(KeepAllowed(all, nil)), names(all), "liste vide")
	eq(t, names(KeepAllowed(all, []string{"  "})), names(all), "entrées vides")

	// Une majeure autorisée mais absente du registre ne fabrique rien.
	eq(t, names(KeepAllowed(all, []string{"18"})), []string{}, "majeure absente")

	// Un tag précis n'autorise que lui : épingler un correctif est un choix
	// distinct de suivre sa branche.
	eq(t, names(KeepAllowed(all, []string{"22.11.0"})),
		[]string{"22.11.0"}, "tag exact")

	// Les deux natures se combinent.
	eq(t, names(KeepAllowed(all, []string{"24", "22.11.0"})),
		[]string{"24", "24.1.0", "22.11.0"}, "branche et tag exact")
}
