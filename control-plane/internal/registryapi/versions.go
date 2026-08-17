package registryapi

import (
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Versions d'un runtime, déduites des tags publiés.
//
// Les registres publient des centaines de tags pour une même image : variantes
// d'OS (`22-alpine`, `22-bookworm`), alias mouvants (`latest`, `lts`, `iron`),
// versions préliminaires (`23.0.0-rc.1`). Aucun n'a sa place dans un sélecteur
// de version : la variante d'OS est déjà fixée par le Dockerfile du type, et un
// alias ne dit pas ce qu'il désigne.
//
// Ne restent que les numéros de version, triés du plus récent au plus ancien.

// semver reconnaît un tag purement numérique : « 22 », « 3.12 », « 1.24.1 ».
var semver = regexp.MustCompile(`^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$`)

// Version est un tag exploitable comme version de runtime.
type Version struct {
	// Tag tel qu'il sera écrit dans le Dockerfile.
	Name string `json:"name"`
	// Composantes, pour le tri et le regroupement par majeure.
	Major int `json:"major"`
	Minor int `json:"minor"`
	Patch int `json:"patch"`
	// Vrai quand le tag ne porte que la majeure : « 22 » suit les correctifs,
	// « 22.11.0 » les fige.
	Floating bool `json:"floating"`
}

// FilterVersions retourne les tags exploitables comme versions, du plus récent
// au plus ancien.
//
// `minMajor` écarte les versions trop anciennes pour être proposées : lister
// Node 0.10 n'aide personne. Zéro les conserve toutes.
func FilterVersions(tags []Tag, minMajor int) []Version {
	seen := map[string]bool{}
	out := []Version{}

	for _, t := range tags {
		name := strings.TrimSpace(t.Name)
		m := semver.FindStringSubmatch(name)
		if m == nil || seen[name] {
			continue
		}

		major := atoi(m[1])
		if major < minMajor {
			continue
		}

		seen[name] = true
		out = append(out, Version{
			Name:  name,
			Major: major,
			Minor: atoi(m[2]),
			Patch: atoi(m[3]),
			// « 22 » n'a ni mineure ni correctif exprimés.
			Floating: m[2] == "",
		})
	}

	// Décroissant, la plus récente en tête. Un tag flottant précède toute sa
	// série — « 22 » avant « 22.11.0 » — car il désigne la dernière de la
	// branche : le classer à 22.0.0 l'aurait relégué derrière ses propres
	// correctifs, là où personne ne le cherche.
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.Major != b.Major {
			return a.Major > b.Major
		}
		if a.Floating != b.Floating {
			return a.Floating
		}
		if a.Minor != b.Minor {
			return a.Minor > b.Minor
		}
		return a.Patch > b.Patch
	})
	return out
}

func atoi(s string) int {
	n, _ := strconv.Atoi(s)
	return n
}

// KeepAllowed restreint les versions à celles qu'une organisation autorise.
//
// `allow` liste des préfixes de majeure — « 22, 20 » — et non des tags exacts :
// une entreprise valide une branche du runtime, pas un correctif précis, qui
// change toutes les semaines. Une liste vide n'impose rien.
//
// C'est un filtre sur ce que le registre publie, pas une liste de substitution :
// une version retirée du registre disparaît, même si elle reste autorisée.
func KeepAllowed(versions []Version, allow []string) []Version {
	// Deux natures d'autorisation, parce que les deux se défendent : « 22 »
	// valide une branche entière, « 22.11.0 » fige un correctif précis.
	// Confondre les deux interdisait d'épingler une version exacte.
	branches := map[int]bool{}
	exact := map[string]bool{}

	for _, a := range allow {
		a = strings.TrimSpace(a)
		m := semver.FindStringSubmatch(a)
		if m == nil {
			continue
		}
		if m[2] == "" {
			branches[atoi(m[1])] = true
		} else {
			exact[a] = true
		}
	}
	if len(branches) == 0 && len(exact) == 0 {
		return versions
	}

	out := make([]Version, 0, len(versions))
	for _, v := range versions {
		if branches[v.Major] || exact[v.Name] {
			out = append(out, v)
		}
	}
	return out
}
