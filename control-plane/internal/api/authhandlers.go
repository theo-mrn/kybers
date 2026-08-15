package api

import (
	"errors"
	"net/http"
	"time"

	"github.com/kybers/kybers/control-plane/internal/auth"
	"github.com/kybers/kybers/control-plane/internal/db"
	"github.com/kybers/kybers/control-plane/internal/models"
)

// ---------------------------------------------------------------------------
// Inscription et connexion
// ---------------------------------------------------------------------------

// bootstrapStatus indique si l'instance attend encore son premier compte.
//
// Public et volontairement pauvre : un booléen, jamais le nombre de comptes.
// Il évite à l'interface de proposer une inscription que `register` refusera.
func (a *API) bootstrapStatus(w http.ResponseWriter, r *http.Request) {
	count, err := a.db.CountUsers(r.Context())
	if err != nil {
		a.fail(w, "CountUsers", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{
		"needs_bootstrap":   count == 0,
		"open_registration": a.openRegistration,
	})
}

// register crée un compte.
//
// Le PREMIER compte créé sur une instance vierge obtient automatiquement une
// organisation : sans cela, personne ne pourrait démarrer. Les suivants doivent
// être invités, ou créer leur propre organisation.
func (a *API) register(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email    string `json:"email"`
		Name     string `json:"name"`
		Password string `json:"password"`
		OrgName  string `json:"org_name"`
	}
	if err := decode(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "JSON invalide")
		return
	}

	if err := auth.ValidateEmail(req.Email); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	hash, err := auth.HashPassword(req.Password)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}

	// Les comptes sont créés par un administrateur : l'auto-inscription ne sert
	// qu'à créer le TOUT PREMIER compte d'une instance vierge, qui devient
	// administrateur de la plateforme.
	count, err := a.db.CountUsers(r.Context())
	if err != nil {
		a.fail(w, "CountUsers", err)
		return
	}
	if count > 0 && !a.openRegistration {
		writeErr(w, http.StatusForbidden,
			"inscription fermée : demandez la création de votre compte à un administrateur")
		return
	}
	// Le premier compte est administrateur, sans quoi personne ne pourrait
	// créer les suivants.
	bootstrap := count == 0

	user, err := a.db.CreateUserAsAdmin(r.Context(), req.Email, req.Name, hash, "", bootstrap, false)
	if err != nil {
		// Contrainte d'unicité : ne pas révéler si l'email existe déjà.
		a.log.Warn("création de compte refusée", "err", err)
		writeErr(w, http.StatusConflict, "impossible de créer ce compte")
		return
	}

	// Le compte de bootstrap devient super-administrateur : c'est le seul
	// moment où ce statut s'obtient, aucune route ne permet de l'attribuer
	// ensuite.
	if bootstrap {
		if err := a.db.PromoteToSuperAdmin(r.Context(), user.ID); err != nil {
			a.log.Error("promotion super-admin impossible", "user", user.ID, "err", err)
		} else {
			user.IsSuperAdmin = true
		}
	}

	// Organisation initiale, pour que le compte soit immédiatement utilisable.
	orgName := req.OrgName
	if orgName == "" {
		orgName = req.Name
	}
	if orgName == "" {
		orgName = "Mon organisation"
	}
	slug := auth.Slugify(orgName)
	if slug == "" {
		slug = "org-" + user.ID[:8]
	}
	org, err := a.db.CreateOrganization(r.Context(), slug, orgName, user.ID)
	if err != nil {
		// Le compte existe : on le signale plutôt que d'échouer en silence.
		a.log.Error("organisation initiale non créée", "err", err, "user", user.ID)
		writeJSON(w, http.StatusCreated, map[string]any{
			"user":    user,
			"warning": "compte créé, mais l'organisation n'a pas pu l'être",
		})
		return
	}

	a.log.Info("compte créé", "user", user.ID, "org", org.Slug)
	if err := a.startSession(w, r, user.ID); err != nil {
		a.fail(w, "startSession", err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"user": user, "organization": org})
}

func (a *API) login(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := decode(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "JSON invalide")
		return
	}

	user, hash, err := a.db.GetUserByEmail(r.Context(), req.Email)
	if err != nil || !auth.CheckPassword(hash, req.Password) {
		// Message identique dans les deux cas : distinguer « email inconnu » de
		// « mot de passe faux » permettrait d'énumérer les comptes.
		writeErr(w, http.StatusUnauthorized, auth.ErrInvalidCredentials.Error())
		return
	}

	if err := a.startSession(w, r, user.ID); err != nil {
		a.fail(w, "startSession", err)
		return
	}
	_ = a.db.TouchUserLogin(r.Context(), user.ID)

	orgs, _ := a.db.ListUserOrganizations(r.Context(), user.ID)
	writeJSON(w, http.StatusOK, map[string]any{"user": user, "organizations": orgs})
}

func (a *API) logout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(SessionCookie); err == nil && c.Value != "" {
		_ = a.db.DeleteSession(r.Context(), auth.HashToken(c.Value))
	}
	clearSessionCookie(w)
	writeJSON(w, http.StatusOK, map[string]string{"status": "déconnecté"})
}

// startSession crée une session et pose le cookie.
func (a *API) startSession(w http.ResponseWriter, r *http.Request, userID string) error {
	token, err := auth.GenerateSessionToken()
	if err != nil {
		return err
	}
	expires := time.Now().Add(auth.SessionDuration)

	if err := a.db.CreateSession(r.Context(), userID, auth.HashToken(token),
		r.UserAgent(), expires); err != nil {
		return err
	}
	setSessionCookie(w, r, token, expires)
	return nil
}

// me retourne l'utilisateur courant et ses organisations : c'est ce que le
// dashboard appelle au chargement pour savoir s'il faut afficher le login.
func (a *API) me(w http.ResponseWriter, r *http.Request) {
	user, _ := currentUser(r)
	orgs, err := a.db.ListUserOrganizations(r.Context(), user.ID)
	if err != nil {
		a.fail(w, "ListUserOrganizations", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"user": user, "organizations": orgs})
}

func (a *API) changePassword(w http.ResponseWriter, r *http.Request) {
	user, _ := currentUser(r)

	var req struct {
		Current string `json:"current_password"`
		New     string `json:"new_password"`
	}
	if err := decode(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "JSON invalide")
		return
	}

	_, hash, err := a.db.GetUserByEmail(r.Context(), user.Email)
	if err != nil || !auth.CheckPassword(hash, req.Current) {
		writeErr(w, http.StatusUnauthorized, "mot de passe actuel incorrect")
		return
	}

	newHash, err := auth.HashPassword(req.New)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := a.db.UpdatePassword(r.Context(), user.ID, newHash); err != nil {
		a.fail(w, "UpdatePassword", err)
		return
	}
	// Le mot de passe temporaire imposé par un admin est remplacé : l'accès
	// complet est rétabli.
	_ = a.db.ClearMustChangePassword(r.Context(), user.ID)

	// Toutes les sessions sont invalidées : un mot de passe changé doit
	// déconnecter d'éventuels accès non autorisés.
	_ = a.db.DeleteUserSessions(r.Context(), user.ID)
	clearSessionCookie(w)

	writeJSON(w, http.StatusOK, map[string]string{
		"status": "mot de passe modifié, reconnectez-vous",
	})
}

// ---------------------------------------------------------------------------
// Organisations
// ---------------------------------------------------------------------------

func (a *API) listOrganizations(w http.ResponseWriter, r *http.Request) {
	user, _ := currentUser(r)
	orgs, err := a.db.ListUserOrganizations(r.Context(), user.ID)
	if err != nil {
		a.fail(w, "ListUserOrganizations", err)
		return
	}
	writeJSON(w, http.StatusOK, orgs)
}

func (a *API) createOrganization(w http.ResponseWriter, r *http.Request) {
	user, _ := currentUser(r)

	var req struct {
		Name string `json:"name"`
		Slug string `json:"slug"`
	}
	if err := decode(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "JSON invalide")
		return
	}
	if req.Name == "" {
		writeErr(w, http.StatusBadRequest, "le champ 'name' est requis")
		return
	}

	slug := req.Slug
	if slug == "" {
		slug = auth.Slugify(req.Name)
	}
	if slug == "" {
		writeErr(w, http.StatusBadRequest, "nom invalide : aucun identifiant ne peut en être dérivé")
		return
	}

	org, err := a.db.CreateOrganization(r.Context(), slug, req.Name, user.ID)
	if err != nil {
		a.log.Warn("création d'organisation refusée", "slug", slug, "err", err)
		writeErr(w, http.StatusConflict, "cet identifiant est déjà pris")
		return
	}
	writeJSON(w, http.StatusCreated, org)
}

func (a *API) listMembers(w http.ResponseWriter, r *http.Request) {
	orgID, _ := currentOrg(r)
	members, err := a.db.ListMembers(r.Context(), orgID)
	if err != nil {
		a.fail(w, "ListMembers", err)
		return
	}
	writeJSON(w, http.StatusOK, members)
}

// addMember ajoute un utilisateur EXISTANT à l'organisation.
//
// Sans envoi d'email, l'invitation se limite à cela : la personne doit déjà
// avoir un compte.
func (a *API) addMember(w http.ResponseWriter, r *http.Request) {
	orgID, _ := currentOrg(r)

	var req struct {
		Email string `json:"email"`
		Role  string `json:"role"`
	}
	if err := decode(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "JSON invalide")
		return
	}
	if req.Role == "" {
		req.Role = auth.RoleMember
	}
	if err := auth.ValidateRole(req.Role); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}

	target, _, err := a.db.GetUserByEmail(r.Context(), req.Email)
	if err != nil {
		writeErr(w, http.StatusNotFound,
			"aucun compte avec cet email : la personne doit d'abord s'inscrire")
		return
	}

	if err := a.db.AddMember(r.Context(), orgID, target.ID, req.Role); err != nil {
		a.fail(w, "AddMember", err)
		return
	}
	a.log.Info("membre ajouté", "org", orgID, "user", target.ID, "role", req.Role)
	writeJSON(w, http.StatusOK, map[string]any{"user": target, "role": req.Role})
}

// updateMemberRole change les droits d'un membre.
//
// Un propriétaire ne peut pas se rétrograder lui-même s'il est le dernier :
// l'organisation deviendrait ingérable, sans personne pour gérer les membres.
// guardPeerEdit applique la hiérarchie : on ne modifie que STRICTEMENT en
// dessous de soi.
//
// Deux comptes de même niveau ne peuvent rien l'un sur l'autre — sinon deux
// administrateurs se rétrograderaient mutuellement, et le plus rapide
// l'emporterait. Se modifier soi-même reste permis, sauf pour le super-admin
// qui rendrait l'instance ingérable en se retirant.
func (a *API) guardPeerEdit(r *http.Request, orgID, targetID, targetRole string,
	actor *models.User) error {

	target, err := a.db.GetUser(r.Context(), targetID)
	if err != nil {
		return errors.New("compte introuvable")
	}

	// Le rôle de l'acteur DANS cette organisation ne compte que s'il n'a aucun
	// statut plateforme : un administrateur domine de toute façon.
	actorRole := ""
	if !actor.IsAdmin && !actor.IsSuperAdmin {
		actorRole, err = a.db.GetMembership(r.Context(), orgID, actor.ID)
		if err != nil {
			return errors.New("accès refusé à cette organisation")
		}
	}

	actorLevel := auth.AccountLevel(actor.IsSuperAdmin, actor.IsAdmin, actorRole)
	targetLevel := auth.AccountLevel(target.IsSuperAdmin, target.IsAdmin, targetRole)

	if auth.CanActOn(actorLevel, targetLevel, actor.ID == targetID) {
		return nil
	}
	return errors.New(levelRefusal(targetLevel))
}

// levelRefusal explique le refus en nommant le niveau qui protège la cible.
func levelRefusal(targetLevel int) string {
	switch targetLevel {
	case auth.LevelSuperAdmin:
		return "ce compte est le super-administrateur de l'instance : personne " +
			"ne peut modifier ses droits"
	case auth.LevelAdmin:
		return "cette personne est administrateur de la plateforme : seul le " +
			"super-administrateur peut modifier ses droits"
	default:
		return "cette personne est admin de l'organisation : seul un " +
			"administrateur de la plateforme peut modifier ses droits"
	}
}

func (a *API) updateMemberRole(w http.ResponseWriter, r *http.Request) {
	orgID, _ := currentOrg(r)
	actor, _ := currentUser(r)
	targetID := r.PathValue("userID")

	var req struct {
		Role string `json:"role"`
	}
	if err := decode(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "JSON invalide")
		return
	}
	if err := auth.ValidateRole(req.Role); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}

	current, err := a.db.GetMembership(r.Context(), orgID, targetID)
	if err != nil {
		writeErr(w, http.StatusNotFound, "ce membre n'appartient pas à l'organisation")
		return
	}

	// Un admin d'organisation ne modifie que ses subordonnés, jamais un pair :
	// sinon deux admins pourraient se rétrograder l'un l'autre, et le plus
	// rapide l'emporterait. Se modifier soi-même reste permis (renoncer à ses
	// droits), et un admin de plateforme n'est pas concerné : il arbitre.
	if err := a.guardPeerEdit(r, orgID, targetID, current, actor); err != nil {
		writeErr(w, http.StatusForbidden, err.Error())
		return
	}

	// Retirer le dernier propriétaire laisserait l'organisation sans
	// administrateur : personne ne pourrait plus gérer les membres.
	if current == auth.RoleOwner && req.Role != auth.RoleOwner {
		members, err := a.db.ListMembers(r.Context(), orgID)
		if err != nil {
			a.fail(w, "ListMembers", err)
			return
		}
		owners := 0
		for _, m := range members {
			if m.Role == auth.RoleOwner {
				owners++
			}
		}
		if owners <= 1 {
			writeErr(w, http.StatusConflict,
				"impossible de rétrograder le dernier propriétaire : "+
					"nommez d'abord un autre propriétaire")
			return
		}
	}

	if err := a.db.AddMember(r.Context(), orgID, targetID, req.Role); err != nil {
		a.fail(w, "AddMember", err)
		return
	}
	a.log.Info("rôle modifié", "org", orgID, "membre", targetID,
		"ancien", current, "nouveau", req.Role, "par", actor.ID)

	writeJSON(w, http.StatusOK, map[string]any{"user_id": targetID, "role": req.Role})
}

func (a *API) removeMember(w http.ResponseWriter, r *http.Request) {
	orgID, _ := currentOrg(r)
	actor, _ := currentUser(r)
	userID := r.PathValue("userID")

	// Exclure un pair reviendrait à le rétrograder de force.
	if role, err := a.db.GetMembership(r.Context(), orgID, userID); err == nil {
		if err := a.guardPeerEdit(r, orgID, userID, role, actor); err != nil {
			writeErr(w, http.StatusForbidden, err.Error())
			return
		}
	}

	if err := a.db.RemoveMember(r.Context(), orgID, userID); err != nil {
		if isNotFound(err) {
			writeErr(w, http.StatusNotFound, "ce membre n'appartient pas à l'organisation")
			return
		}
		if errors.Is(err, db.ErrLastOwner) {
			writeErr(w, http.StatusConflict,
				"dernier propriétaire : nommez-en un autre avant de le retirer")
			return
		}
		a.fail(w, "RemoveMember", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---------------------------------------------------------------------------
// Jetons d'API
// ---------------------------------------------------------------------------

func (a *API) listTokens(w http.ResponseWriter, r *http.Request) {
	user, _ := currentUser(r)
	tokens, err := a.db.ListAPITokens(r.Context(), user.ID)
	if err != nil {
		a.fail(w, "ListAPITokens", err)
		return
	}
	writeJSON(w, http.StatusOK, tokens)
}

// createToken génère un jeton d'API. Il n'est affiché qu'ici : seul son hash
// est conservé.
func (a *API) createToken(w http.ResponseWriter, r *http.Request) {
	user, _ := currentUser(r)

	var req struct {
		Name      string `json:"name"`
		ExpiresIn int    `json:"expires_in_days"`
	}
	if err := decode(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "JSON invalide")
		return
	}
	if req.Name == "" {
		writeErr(w, http.StatusBadRequest, "nommez ce jeton pour le reconnaître plus tard")
		return
	}

	token, prefix, err := auth.GenerateAPIToken()
	if err != nil {
		a.fail(w, "GenerateAPIToken", err)
		return
	}

	var expires *time.Time
	if req.ExpiresIn > 0 {
		t := time.Now().AddDate(0, 0, req.ExpiresIn)
		expires = &t
	}

	created, err := a.db.CreateAPIToken(r.Context(), user.ID, "", req.Name,
		auth.HashToken(token), prefix, expires)
	if err != nil {
		a.fail(w, "CreateAPIToken", err)
		return
	}

	writeJSON(w, http.StatusCreated, map[string]any{
		"api_token": created,
		// Affiché une seule fois : impossible à retrouver ensuite.
		"token":   token,
		"warning": "copiez ce jeton maintenant, il ne sera plus affiché",
	})
}

func (a *API) deleteToken(w http.ResponseWriter, r *http.Request) {
	user, _ := currentUser(r)
	if err := a.db.DeleteAPIToken(r.Context(), user.ID, r.PathValue("id")); err != nil {
		if isNotFound(err) {
			writeErr(w, http.StatusNotFound, "jeton introuvable")
			return
		}
		a.fail(w, "DeleteAPIToken", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
