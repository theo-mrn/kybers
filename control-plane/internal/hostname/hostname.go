// Package hostname construit l'URL publique attribuée à un déploiement.
//
// Sans hostname, une application n'est joignable que depuis l'intérieur du
// cluster : c'est le rôle de ce package de garantir que tout déploiement
// obtienne une adresse, sans que l'utilisateur ait à en saisir une.
package hostname

import (
	"fmt"
	"strings"
)

// Generator produit les hostnames par défaut des déploiements.
type Generator struct {
	// baseDomain : suffixe des URL générées, ex. "apps.exemple.fr".
	// Son DNS doit pointer en wildcard (*.apps.exemple.fr) vers l'ingress.
	baseDomain string
	// ingressIP : repli quand aucun domaine n'est configuré. L'URL passe alors
	// par nip.io, qui résout n'importe quel nom contenant une IP vers cette IP.
	ingressIP string
}

func New(baseDomain, ingressIP string) *Generator {
	return &Generator{
		baseDomain: strings.Trim(strings.TrimSpace(baseDomain), "."),
		ingressIP:  strings.TrimSpace(ingressIP),
	}
}

// Enabled indique si un hostname peut être généré. Faux = aucune exposition
// automatique possible, l'utilisateur doit fournir son propre hostname.
func (g *Generator) Enabled() bool {
	return g.baseDomain != "" || g.ingressIP != ""
}

// For construit le hostname d'une application dans un environnement.
//
//	baseDomain configuré : "backstage-demo.apps.exemple.fr"
//	repli nip.io         : "backstage-demo.217.65.146.24.nip.io"
//
// Retourne une chaîne vide si aucune exposition n'est configurée.
func (g *Generator) For(appName, environment string) string {
	prefix := sanitizeLabel(fmt.Sprintf("%s-%s", appName, environment))
	if prefix == "" {
		return ""
	}

	if g.baseDomain != "" {
		return prefix + "." + g.baseDomain
	}
	if g.ingressIP != "" {
		// nip.io résout <n'importe quoi>.<ip>.nip.io vers <ip> : pratique tant
		// qu'aucun domaine n'est configuré, mais dépend d'un service tiers.
		return fmt.Sprintf("%s.%s.nip.io", prefix, g.ingressIP)
	}
	return ""
}

// TLS indique si l'URL doit être annoncée en HTTPS. Le repli nip.io reste en
// clair : un certificat Let's Encrypt suppose un domaine maîtrisé.
func (g *Generator) TLS() bool {
	return g.baseDomain != ""
}

// URL retourne l'adresse complète, schéma compris.
func (g *Generator) URL(host string) string {
	if host == "" {
		return ""
	}
	if g.TLS() {
		return "https://" + host
	}
	return "http://" + host
}

// sanitizeLabel produit un label DNS valide (RFC 1123) : minuscules, chiffres
// et tirets, 63 caractères au plus, sans tiret aux extrémités.
func sanitizeLabel(in string) string {
	out := strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '-':
			return r
		case r >= 'A' && r <= 'Z':
			return r + 32
		default:
			return '-'
		}
	}, in)

	// Les séparateurs consécutifs produisent des tirets en série, invalides.
	for strings.Contains(out, "--") {
		out = strings.ReplaceAll(out, "--", "-")
	}
	out = strings.Trim(out, "-")
	if len(out) > 63 {
		out = strings.Trim(out[:63], "-")
	}
	return out
}
