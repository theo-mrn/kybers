package auth

import (
	"strings"
	"testing"
)

func TestHashEtVerificationMotDePasse(t *testing.T) {
	const pwd = "correct-cheval-batterie-agrafe"

	hash, err := HashPassword(pwd)
	if err != nil {
		t.Fatal(err)
	}
	// Le mot de passe ne doit jamais apparaître en clair dans le hash.
	if strings.Contains(hash, pwd) {
		t.Fatal("le hash contient le mot de passe")
	}
	if !CheckPassword(hash, pwd) {
		t.Error("le bon mot de passe devrait être accepté")
	}
	if CheckPassword(hash, pwd+"x") {
		t.Error("un mot de passe erroné doit être refusé")
	}
}

// bcrypt ajoute un sel : deux hashs du même mot de passe diffèrent, ce qui
// empêche de repérer les utilisateurs partageant un mot de passe.
func TestHashsDifferentsPourMemeMotDePasse(t *testing.T) {
	h1, _ := HashPassword("un-mot-de-passe-long")
	h2, _ := HashPassword("un-mot-de-passe-long")
	if h1 == h2 {
		t.Error("deux hashs identiques : le sel n'est pas appliqué")
	}
}

func TestMotDePasseTropCourtRefuse(t *testing.T) {
	if _, err := HashPassword("court"); err == nil {
		t.Error("un mot de passe trop court doit être refusé")
	}
	// La limite est en caractères, pas en octets : les accents comptent pour un.
	if err := ValidatePassword("éèàùçéèàùç"); err != nil {
		t.Errorf("10 caractères accentués devraient passer: %v", err)
	}
}

func TestNormalisationEmail(t *testing.T) {
	cases := map[string]string{
		"  Theo@Exemple.FR  ": "theo@exemple.fr",
		"USER@DOMAIN.COM":     "user@domain.com",
	}
	for in, want := range cases {
		if got := NormalizeEmail(in); got != want {
			t.Errorf("NormalizeEmail(%q) = %q, attendu %q", in, got, want)
		}
	}
}

func TestValidationEmail(t *testing.T) {
	valides := []string{"a@b.fr", "theo.morin@exemple.co.uk", "x+tag@domaine.io"}
	for _, e := range valides {
		if err := ValidateEmail(e); err != nil {
			t.Errorf("ValidateEmail(%q) = %v, attendu nil", e, err)
		}
	}

	invalides := []string{"", "sans-arobase", "@domaine.fr", "a@", "a@b", "a b@c.fr"}
	for _, e := range invalides {
		if err := ValidateEmail(e); err == nil {
			t.Errorf("ValidateEmail(%q) devrait échouer", e)
		}
	}
}

// Un jeton doit être imprévisible : deux générations ne se ressemblent jamais.
func TestGenerationJetons(t *testing.T) {
	t1, p1, err := GenerateAPIToken()
	if err != nil {
		t.Fatal(err)
	}
	t2, _, _ := GenerateAPIToken()

	if t1 == t2 {
		t.Fatal("deux jetons identiques : la génération n'est pas aléatoire")
	}
	if !strings.HasPrefix(t1, TokenPrefix) {
		t.Errorf("le jeton devrait commencer par %q", TokenPrefix)
	}
	// Le préfixe affiché ne doit pas suffire à reconstituer le jeton.
	if len(p1) >= len(t1) {
		t.Error("le préfixe ne doit révéler qu'une petite partie du jeton")
	}
	if !strings.HasPrefix(t1, p1) {
		t.Error("le préfixe doit correspondre au début du jeton")
	}

	s1, _ := GenerateSessionToken()
	s2, _ := GenerateSessionToken()
	if s1 == s2 || s1 == "" {
		t.Error("les jetons de session doivent être uniques et non vides")
	}
}

func TestHashToken(t *testing.T) {
	token, _, _ := GenerateAPIToken()
	h := HashToken(token)

	// Le stockage ne doit pas permettre de retrouver le jeton.
	if strings.Contains(h, token) || h == token {
		t.Fatal("le hash révèle le jeton")
	}
	// Déterministe : la vérification doit retrouver le même hash.
	if HashToken(token) != h {
		t.Error("le hash devrait être déterministe")
	}
	if HashToken(token+"x") == h {
		t.Error("deux jetons différents ne doivent pas produire le même hash")
	}
}

func TestSecureCompare(t *testing.T) {
	if !SecureCompare("abc", "abc") {
		t.Error("deux chaînes identiques devraient correspondre")
	}
	if SecureCompare("abc", "abd") || SecureCompare("abc", "ab") {
		t.Error("des chaînes différentes ne doivent pas correspondre")
	}
}

func TestSlugify(t *testing.T) {
	cases := map[string]string{
		"Mon Organisation": "mon-organisation",
		"ACME Corp.":       "acme-corp",
		"  espaces  ":      "espaces",
		"Déjà Vu":          "deja-vu", // les accents sont translittérés
		"Équipe Données":   "equipe-donnees",
		"Cœur ✦ Noël":      "c-ur-noel", // hors table : remplacé par un tiret
		"a---b":            "a-b",
		"---":              "",
	}
	for in, want := range cases {
		if got := Slugify(in); got != want {
			t.Errorf("Slugify(%q) = %q, attendu %q", in, got, want)
		}
	}

	// Un nom très long doit être tronqué sans finir par un tiret.
	long := Slugify(strings.Repeat("a", 100))
	if len(long) > 40 || strings.HasSuffix(long, "-") {
		t.Errorf("slug tronqué invalide: %q (%d caractères)", long, len(long))
	}
}

func TestPermissionsParRole(t *testing.T) {
	// Un viewer ne doit jamais pouvoir écrire, un member ne doit jamais
	// pouvoir administrer.
	cases := []struct {
		role     string
		canWrite bool
		canAdmin bool
	}{
		{RoleOwner, true, true},
		{RoleMember, true, false},
		{RoleViewer, false, false},
		{"inconnu", false, false},
	}
	for _, c := range cases {
		if CanWrite(c.role) != c.canWrite {
			t.Errorf("CanWrite(%q) = %v, attendu %v", c.role, CanWrite(c.role), c.canWrite)
		}
		if CanAdmin(c.role) != c.canAdmin {
			t.Errorf("CanAdmin(%q) = %v, attendu %v", c.role, CanAdmin(c.role), c.canAdmin)
		}
	}
}

func TestValidateRole(t *testing.T) {
	for _, r := range []string{RoleOwner, RoleMember, RoleViewer} {
		if err := ValidateRole(r); err != nil {
			t.Errorf("ValidateRole(%q) = %v", r, err)
		}
	}
	if err := ValidateRole("admin"); err == nil {
		t.Error("un rôle inconnu doit être rejeté")
	}
}

func TestHiérarchieDesComptes(t *testing.T) {
	super := AccountLevel(true, true, RoleOwner)
	admin := AccountLevel(false, true, "")
	orgAdmin := AccountLevel(false, false, RoleOwner)
	member := AccountLevel(false, false, RoleMember)

	cases := []struct {
		nom           string
		acteur, cible int
		soi           bool
		attendu       bool
	}{
		// On ne modifie que STRICTEMENT en dessous de soi.
		{"super → admin", super, admin, false, true},
		{"super → admin d'org", super, orgAdmin, false, true},
		{"admin → admin d'org", admin, orgAdmin, false, true},
		{"admin d'org → membre", orgAdmin, member, false, true},

		// Entre pairs, personne ne tranche : sinon le plus rapide gagnerait.
		{"admin → admin", admin, admin, false, false},
		{"admin d'org → admin d'org", orgAdmin, orgAdmin, false, false},

		// Vers le haut, jamais.
		{"admin → super", admin, super, false, false},
		{"admin d'org → admin", orgAdmin, admin, false, false},
		{"membre → admin d'org", member, orgAdmin, false, false},

		// Sur soi-même : permis, sauf pour le super-admin qui rendrait
		// l'instance ingérable en se retirant.
		{"admin sur lui-même", admin, admin, true, true},
		{"membre sur lui-même", member, member, true, true},
		{"super sur lui-même", super, super, true, false},
	}

	for _, c := range cases {
		if got := CanActOn(c.acteur, c.cible, c.soi); got != c.attendu {
			t.Errorf("%s : CanActOn = %v, attendu %v", c.nom, got, c.attendu)
		}
	}

	// Le statut plateforme prime sur le rôle d'organisation : un admin reste
	// au-dessus d'un admin d'org, même s'il n'est que lecteur dans celle-ci.
	if AccountLevel(false, true, RoleViewer) <= orgAdmin {
		t.Error("un administrateur de plateforme doit dominer un admin d'organisation")
	}
}
