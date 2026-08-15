package crypto

import "testing"

func TestAllerRetour(t *testing.T) {
	c, err := New("ma-phrase-secrete")
	if err != nil {
		t.Fatal(err)
	}
	const secret = "postgres://user:p@ssw0rd@db:5432/app"

	enc, err := c.Encrypt(secret)
	if err != nil {
		t.Fatal(err)
	}
	if string(enc) == secret {
		t.Fatal("la valeur n'a pas été chiffrée")
	}

	got, err := c.Decrypt(enc)
	if err != nil {
		t.Fatal(err)
	}
	if got != secret {
		t.Errorf("Decrypt = %q, attendu %q", got, secret)
	}
}

// Deux chiffrements de la même valeur doivent différer : sinon un observateur
// de la base pourrait repérer les applications partageant un même secret.
func TestNoncesDifferents(t *testing.T) {
	c, _ := New("clé")
	a, _ := c.Encrypt("identique")
	b, _ := c.Encrypt("identique")
	if string(a) == string(b) {
		t.Error("deux chiffrements identiques : le nonce n'est pas aléatoire")
	}
}

func TestMauvaiseCle(t *testing.T) {
	c1, _ := New("bonne-clé")
	c2, _ := New("mauvaise-clé")

	enc, _ := c1.Encrypt("donnée")
	if _, err := c2.Decrypt(enc); err == nil {
		t.Error("le déchiffrement avec une mauvaise clé doit échouer")
	}
}

func TestDonneeAlteree(t *testing.T) {
	c, _ := New("clé")
	enc, _ := c.Encrypt("donnée")
	enc[len(enc)-1] ^= 0xFF // altère le dernier octet

	if _, err := c.Decrypt(enc); err == nil {
		t.Error("GCM doit détecter l'altération")
	}
}

func TestCleVideRefusee(t *testing.T) {
	if _, err := New(""); err == nil {
		t.Error("une clé vide doit être refusée")
	}
}

func TestDonneeTropCourte(t *testing.T) {
	c, _ := New("clé")
	if _, err := c.Decrypt([]byte{1, 2}); err == nil {
		t.Error("une donnée plus courte qu'un nonce doit être rejetée")
	}
}
