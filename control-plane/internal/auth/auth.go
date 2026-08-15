// Package auth gère l'identité : mots de passe, sessions et jetons d'API.
//
// Principe commun aux sessions et aux jetons : seul un HASH est stocké en base.
// Une lecture de la base ne permet donc pas d'usurper une identité, et un
// secret n'est affiché qu'une fois, au moment de sa création.
package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
)

// Durées de vie par défaut.
const (
	SessionDuration = 30 * 24 * time.Hour // 30 jours
	// Préfixe des jetons d'API : reconnaissable dans un log ou un dépôt Git,
	// ce qui permet aux outils de détection de secrets de les repérer.
	TokenPrefix = "kyb_"
)

// Rôles au sein d'une organisation, du plus au moins permissif.
const (
	RoleOwner  = "owner"  // gère les membres, les clusters, supprime l'organisation
	RoleMember = "member" // déploie et administre les applications
	RoleViewer = "viewer" // lecture seule
)

var (
	ErrInvalidCredentials = errors.New("email ou mot de passe incorrect")
	ErrWeakPassword       = errors.New("le mot de passe doit faire au moins 10 caractères")
	ErrInvalidEmail       = errors.New("adresse email invalide")
)

// HashPassword produit un hash bcrypt. Le coût par défaut (10) représente
// environ 50 ms de calcul : assez lent pour freiner une attaque par force
// brute, assez rapide pour ne pas gêner une connexion légitime.
func HashPassword(password string) (string, error) {
	if err := ValidatePassword(password); err != nil {
		return "", err
	}
	h, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return "", err
	}
	return string(h), nil
}

// CheckPassword compare un mot de passe à son hash.
func CheckPassword(hash, password string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) == nil
}

// ValidatePassword impose une longueur minimale.
//
// La longueur prime sur la complexité : imposer des caractères spéciaux pousse
// aux mots de passe courts et prévisibles, alors qu'une phrase longue résiste
// mieux.
func ValidatePassword(password string) error {
	if len([]rune(password)) < 10 {
		return ErrWeakPassword
	}
	return nil
}

// NormalizeEmail met en minuscules et retire les espaces : deux écritures d'une
// même adresse ne doivent pas créer deux comptes.
func NormalizeEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}

// ValidateEmail effectue une vérification de forme, pas d'existence.
func ValidateEmail(email string) error {
	e := NormalizeEmail(email)
	at := strings.Index(e, "@")
	if at <= 0 || at == len(e)-1 {
		return ErrInvalidEmail
	}
	if !strings.Contains(e[at+1:], ".") || strings.ContainsAny(e, " \t\n") {
		return ErrInvalidEmail
	}
	return nil
}

// GenerateSessionToken produit un jeton de session opaque, à placer dans un
// cookie httpOnly.
func GenerateSessionToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// GenerateAPIToken produit un jeton d'API et son préfixe affichable.
//
// Le préfixe permet de reconnaître un jeton dans une liste sans le révéler :
// « kyb_a1b2c3… ».
func GenerateAPIToken() (token, prefix string, err error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", "", err
	}
	token = TokenPrefix + hex.EncodeToString(b)
	// 6 caractères après le préfixe : assez pour distinguer, trop peu pour
	// deviner le reste.
	prefix = token[:len(TokenPrefix)+6]
	return token, prefix, nil
}

// HashToken hache un jeton pour le stockage.
//
// SHA-256 suffit ici, contrairement aux mots de passe : un jeton fait 256 bits
// d'entropie aléatoire, il n'est pas attaquable par dictionnaire. Un hash lent
// pénaliserait chaque requête API sans bénéfice.
func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// SecureCompare compare deux chaînes en temps constant, pour ne pas révéler
// leur préfixe commun par le temps de réponse.
func SecureCompare(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

// Slugify transforme un nom d'organisation en identifiant d'URL.
// deaccent ramène les lettres latines accentuées à leur équivalent ASCII.
// Couvre le français et les langues voisines : au-delà, le caractère devient un
// tiret, ce qui reste un identifiant valide.
var deaccent = map[rune]rune{
	'á': 'a', 'à': 'a', 'â': 'a', 'ä': 'a', 'ã': 'a', 'å': 'a',
	'é': 'e', 'è': 'e', 'ê': 'e', 'ë': 'e',
	'í': 'i', 'ì': 'i', 'î': 'i', 'ï': 'i',
	'ó': 'o', 'ò': 'o', 'ô': 'o', 'ö': 'o', 'õ': 'o',
	'ú': 'u', 'ù': 'u', 'û': 'u', 'ü': 'u',
	'ç': 'c', 'ñ': 'n', 'ý': 'y', 'ÿ': 'y',
}

func Slugify(name string) string {
	var b strings.Builder
	lastDash := true // évite un tiret en tête

	for _, r := range strings.ToLower(strings.TrimSpace(name)) {
		// Les accents sont translittérés plutôt que remplacés par un tiret :
		// « Équipe Données » doit donner `equipe-donnees`, pas `quipe-donn-es`.
		if a, ok := deaccent[r]; ok {
			r = a
		}

		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
			lastDash = false
		case !lastDash:
			b.WriteRune('-')
			lastDash = true
		}
	}

	s := strings.Trim(b.String(), "-")
	if len(s) > 40 {
		s = strings.Trim(s[:40], "-")
	}
	return s
}

// CanWrite indique si un rôle autorise les modifications.
func CanWrite(role string) bool {
	return role == RoleOwner || role == RoleMember
}

// CanAdmin indique si un rôle autorise la gestion de l'organisation :
// membres, clusters, registries, suppression.
func CanAdmin(role string) bool {
	return role == RoleOwner
}

// ValidateRole rejette un rôle inconnu.
func ValidateRole(role string) error {
	switch role {
	case RoleOwner, RoleMember, RoleViewer:
		return nil
	default:
		return fmt.Errorf("rôle invalide: %q (attendu owner, member ou viewer)", role)
	}
}

// GeneratePassword produit un mot de passe temporaire lisible.
//
// Le format par groupes (Xk7m-Qp2v-Rt9s) se transcrit sans erreur à l'oral ou
// par messagerie, et les caractères ambigus (0/O, 1/l/I) sont exclus.
func GeneratePassword() (string, error) {
	const alphabet = "abcdefghijkmnpqrstuvwxyzACDEFGHJKLMNPQRSTUVWXYZ23456789"
	const groups, groupSize = 4, 4

	b := make([]byte, groups*groupSize)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}

	var sb strings.Builder
	for i, v := range b {
		if i > 0 && i%groupSize == 0 {
			sb.WriteByte('-')
		}
		sb.WriteByte(alphabet[int(v)%len(alphabet)])
	}
	return sb.String(), nil
}
