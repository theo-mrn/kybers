package api

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/kybers/kybers/control-plane/internal/auth"
	"github.com/kybers/kybers/control-plane/internal/db"
	"github.com/kybers/kybers/control-plane/internal/models"
)

// SessionCookie est le nom du cookie de session du dashboard.
const SessionCookie = "kybers_session"

// Clés de contexte, typées pour éviter toute collision.
type ctxKey int

const (
	ctxUser ctxKey = iota
	ctxOrg
	ctxRole
)

// currentUser retourne l'utilisateur de la requête. Le second retour est faux
// si la requête n'est pas authentifiée.
func currentUser(r *http.Request) (*models.User, bool) {
	u, ok := r.Context().Value(ctxUser).(*models.User)
	return u, ok
}

// currentOrg retourne l'organisation active et le rôle de l'utilisateur.
func currentOrg(r *http.Request) (orgID, role string) {
	orgID, _ = r.Context().Value(ctxOrg).(string)
	role, _ = r.Context().Value(ctxRole).(string)
	return orgID, role
}

// authenticate identifie l'appelant, par cookie de session ou jeton d'API.
//
// Le cookie sert au dashboard (httpOnly, non lisible en JS) ; le jeton sert à
// la CLI et à la CI. Les deux résolvent vers le même utilisateur.
func (a *API) authenticate(r *http.Request) (*models.User, error) {
	// Jeton d'API en priorité : une requête qui en présente un exprime son
	// intention, même si un cookie traîne.
	if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
		token := strings.TrimSpace(strings.TrimPrefix(h, "Bearer "))
		if token == "" {
			return nil, errors.New("jeton vide")
		}
		return a.db.GetAPITokenUser(r.Context(), auth.HashToken(token))
	}

	c, err := r.Cookie(SessionCookie)
	if err != nil || c.Value == "" {
		return nil, errors.New("non authentifié")
	}
	return a.db.GetSessionUser(r.Context(), auth.HashToken(c.Value))
}

// requireAuth n'autorise que les requêtes authentifiées.
//
// Un compte dont le mot de passe temporaire n'a pas été changé ne peut rien
// faire d'autre que le changer : sinon un mot de passe connu de l'admin
// donnerait un accès durable.
func (a *API) requireAuth(next http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, err := a.authenticate(r)
		if err != nil {
			writeErr(w, http.StatusUnauthorized, "authentification requise")
			return
		}

		if user.MustChangePassword && !isPasswordRoute(r) {
			writeErr(w, http.StatusForbidden,
				"mot de passe temporaire : définissez votre mot de passe avant de continuer")
			return
		}

		ctx := context.WithValue(r.Context(), ctxUser, user)
		next(w, r.WithContext(ctx))
	})
}

// isPasswordRoute autorise les seules routes nécessaires au changement de mot
// de passe, pour ne pas enfermer l'utilisateur.
func isPasswordRoute(r *http.Request) bool {
	p := r.URL.Path
	return p == "/api/v1/auth/password" || p == "/api/v1/auth/me"
}

// requirePerm exige une PERMISSION précise, en tenant compte des exceptions
// individuelles. C'est le contrôle réellement appliqué : un rôle ne suffit pas
// si l'administrateur a retiré ce droit à cette personne.
func (a *API) requirePerm(next http.HandlerFunc, permission string) http.Handler {
	return a.requireAuth(func(w http.ResponseWriter, r *http.Request) {
		user, _ := currentUser(r)

		orgID, err := a.resolveOrg(r, user.ID)
		if err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}

		role, err := a.db.GetMembership(r.Context(), orgID, user.ID)
		if err != nil {
			writeErr(w, http.StatusForbidden, "accès refusé à cette organisation")
			return
		}

		// Les exceptions individuelles priment sur le rôle.
		overrides, err := a.db.GetUserPermissions(r.Context(), orgID, user.ID)
		if err != nil {
			a.log.Error("GetUserPermissions", "err", err)
			overrides = nil
		}

		if !auth.HasPermission(role, overrides, permission) {
			writeErr(w, http.StatusForbidden,
				"droit manquant : "+permission)
			return
		}

		ctx := context.WithValue(r.Context(), ctxOrg, orgID)
		ctx = context.WithValue(ctx, ctxRole, role)
		next(w, r.WithContext(ctx))
	})
}

// requireOrg exige une organisation ET vérifie que l'utilisateur en est membre.
//
// L'organisation est désignée par l'en-tête X-Kybers-Org ou le paramètre `org`
// (slug ou identifiant). Sans précision, l'unique organisation de l'utilisateur
// est retenue — pratique tant qu'il n'en a qu'une, refusé au-delà pour éviter
// d'agir sur la mauvaise.
func (a *API) requireOrg(next http.HandlerFunc, minRole string) http.Handler {
	return a.requireAuth(func(w http.ResponseWriter, r *http.Request) {
		user, _ := currentUser(r)

		orgID, err := a.resolveOrg(r, user.ID)
		if err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}

		role, err := a.db.GetMembership(r.Context(), orgID, user.ID)
		if err != nil {
			// Ne pas distinguer « organisation inexistante » de « non membre » :
			// cela révélerait l'existence d'organisations tierces.
			writeErr(w, http.StatusForbidden, "accès refusé à cette organisation")
			return
		}

		if !roleSatisfies(role, minRole) {
			writeErr(w, http.StatusForbidden,
				"rôle insuffisant : "+minRole+" requis, vous êtes "+role)
			return
		}

		ctx := context.WithValue(r.Context(), ctxOrg, orgID)
		ctx = context.WithValue(ctx, ctxRole, role)
		next(w, r.WithContext(ctx))
	})
}

// resolveOrg détermine l'organisation visée par la requête.
func (a *API) resolveOrg(r *http.Request, userID string) (string, error) {
	ref := r.Header.Get("X-Kybers-Org")
	if ref == "" {
		ref = r.URL.Query().Get("org")
	}

	if ref != "" {
		// Un slug est plus lisible dans une URL ; un identifiant reste accepté.
		if org, err := a.db.GetOrganizationBySlug(r.Context(), ref); err == nil {
			return org.ID, nil
		}
		return ref, nil
	}

	orgs, err := a.db.ListUserOrganizations(r.Context(), userID)
	if err != nil {
		return "", errors.New("organisations illisibles")
	}
	switch len(orgs) {
	case 0:
		return "", errors.New("aucune organisation : créez-en une d'abord")
	case 1:
		return orgs[0].ID, nil
	default:
		return "", errors.New(
			"plusieurs organisations : précisez laquelle avec l'en-tête X-Kybers-Org")
	}
}

// roleSatisfies compare un rôle au minimum requis.
func roleSatisfies(role, minRole string) bool {
	switch minRole {
	case auth.RoleOwner:
		return auth.CanAdmin(role)
	case auth.RoleMember:
		return auth.CanWrite(role)
	default: // viewer : tout membre convient
		return role != ""
	}
}

// setSessionCookie place le cookie de session.
//
// httpOnly interdit sa lecture par JavaScript, SameSite=Lax limite les envois
// intersites, et Secure n'est activé qu'en HTTPS — sinon le cookie serait
// rejeté en développement local.
func setSessionCookie(w http.ResponseWriter, r *http.Request, token string, expires time.Time) {
	http.SetCookie(w, &http.Cookie{
		Name:     SessionCookie,
		Value:    token,
		Path:     "/",
		Expires:  expires,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https",
	})
}

func clearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     SessionCookie,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})
}

// isNotFound distingue une absence d'une erreur technique.
func isNotFound(err error) bool {
	return errors.Is(err, db.ErrNotFound)
}
