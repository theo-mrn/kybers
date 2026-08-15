// Package crypto chiffre les données sensibles avant leur écriture en base :
// mots de passe de registry et variables d'environnement secrètes.
//
// AES-256-GCM : chiffrement authentifié, donc une valeur altérée en base est
// détectée au déchiffrement plutôt que renvoyée corrompue.
package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
)

type Cipher struct {
	aead cipher.AEAD
}

// New dérive une clé AES-256 depuis la phrase secrète fournie.
//
// SHA-256 sur la phrase suffit ici car ENCRYPTION_KEY est une valeur de
// configuration à forte entropie, pas un mot de passe humain. Pour un secret
// choisi par un utilisateur, un KDF lent (argon2/scrypt) serait nécessaire.
func New(passphrase string) (*Cipher, error) {
	if passphrase == "" {
		return nil, errors.New("clé de chiffrement vide")
	}
	key := sha256.Sum256([]byte(passphrase))

	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &Cipher{aead: aead}, nil
}

// Encrypt retourne nonce || ciphertext. Un nonce aléatoire par appel garantit
// que deux valeurs identiques produisent des chiffrés différents.
func (c *Cipher) Encrypt(plaintext string) ([]byte, error) {
	nonce := make([]byte, c.aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	return c.aead.Seal(nonce, nonce, []byte(plaintext), nil), nil
}

func (c *Cipher) Decrypt(data []byte) (string, error) {
	ns := c.aead.NonceSize()
	if len(data) < ns {
		return "", fmt.Errorf("donnée chiffrée trop courte (%d octets)", len(data))
	}
	plaintext, err := c.aead.Open(nil, data[:ns], data[ns:], nil)
	if err != nil {
		return "", fmt.Errorf("déchiffrement impossible: %w", err)
	}
	return string(plaintext), nil
}
