package api

import (
	"errors"
	"net/http"

	"github.com/kybers/kybers/control-plane/internal/auth"
	"github.com/kybers/kybers/control-plane/internal/db"
	"github.com/kybers/kybers/control-plane/internal/models"
)

// requireAdmin réserve une route aux administrateurs de la plateforme.
func (a *API) requireAdmin(next http.HandlerFunc) http.Handler {
	return a.requireAuth(func(w http.ResponseWriter, r *http.Request) {
		user, _ := currentUser(r)
		if !user.IsAdmin {
			writeErr(w, http.StatusForbidden,
				"réservé aux administrateurs de la plateforme")
			return
		}
		next(w, r)
	})
}

// requireSuperAdmin réserve une route au super-administrateur.
func (a *API) requireSuperAdmin(next http.HandlerFunc) http.Handler {
	return a.requireAuth(func(w http.ResponseWriter, r *http.Request) {
		user, _ := currentUser(r)
		if !user.IsSuperAdmin {
			writeErr(w, http.StatusForbidden,
				"réservé au super-administrateur de l'instance")
			return
		}
		next(w, r)
	})
}

// guardAccountEdit applique la hiérarchie hors de toute organisation, pour les
// actions de plateforme : désactivation, réinitialisation de mot de passe,
// changement de statut.
//
// Comme ailleurs, la comparaison est stricte — un administrateur ne modifie pas
// un pair — et le super-admin n'est modifiable par personne.
func (a *API) guardAccountEdit(actor, target *models.User) error {
	actorLevel := auth.AccountLevel(actor.IsSuperAdmin, actor.IsAdmin, "")
	targetLevel := auth.AccountLevel(target.IsSuperAdmin, target.IsAdmin, "")

	if auth.CanActOn(actorLevel, targetLevel, actor.ID == target.ID) {
		return nil
	}
	return errors.New(levelRefusal(targetLevel))
}

// ---------------------------------------------------------------------------
// Gestion des comptes
// ---------------------------------------------------------------------------

func (a *API) adminListUsers(w http.ResponseWriter, r *http.Request) {
	users, err := a.db.ListAllUsers(r.Context())
	if err != nil {
		a.fail(w, "ListAllUsers", err)
		return
	}
	writeJSON(w, http.StatusOK, users)
}

// adminCreateUser crée un compte et l'affecte éventuellement à une organisation.
//
// Le mot de passe est temporaire : l'utilisateur devra le changer à sa première
// connexion, ce qui évite qu'un admin connaisse durablement les identifiants
// de ses collègues.
func (a *API) adminCreateUser(w http.ResponseWriter, r *http.Request) {
	actor, _ := currentUser(r)

	var req struct {
		Email    string `json:"email"`
		Name     string `json:"name"`
		Password string `json:"password"`
		IsAdmin  bool   `json:"is_admin"`
		// Affectation initiale, facultative.
		OrgID string `json:"org_id"`
		Role  string `json:"role"`
	}
	if err := decode(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "JSON invalide")
		return
	}

	if err := auth.ValidateEmail(req.Email); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}

	// Un administrateur ne peut pas se créer de pairs : cela reviendrait à
	// s'octroyer le pouvoir de nomination du super-admin.
	if req.IsAdmin && !actor.IsSuperAdmin {
		writeErr(w, http.StatusForbidden,
			"seul le super-administrateur crée un administrateur")
		return
	}

	// Sans mot de passe fourni, on en génère un : c'est plus sûr qu'une valeur
	// choisie à la hâte, et il n'est affiché qu'une fois.
	password := req.Password
	generated := false
	if password == "" {
		p, err := auth.GeneratePassword()
		if err != nil {
			a.fail(w, "GeneratePassword", err)
			return
		}
		password = p
		generated = true
	}

	hash, err := auth.HashPassword(password)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}

	user, err := a.db.CreateUserAsAdmin(r.Context(), req.Email, req.Name, hash,
		actor.ID, req.IsAdmin, true)
	if err != nil {
		a.log.Warn("création de compte refusée", "email", req.Email, "err", err)
		writeErr(w, http.StatusConflict, "un compte existe déjà avec cet email")
		return
	}

	// Affectation à une organisation, si demandée.
	assigned := ""
	if req.OrgID != "" {
		role := req.Role
		if role == "" {
			role = auth.RoleMember
		}
		if err := auth.ValidateRole(role); err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		if err := a.db.AddMember(r.Context(), req.OrgID, user.ID, role); err != nil {
			// Le compte existe : on le signale plutôt que d'échouer en silence.
			a.log.Error("affectation impossible", "user", user.ID, "org", req.OrgID, "err", err)
		} else {
			assigned = role
		}
	}

	a.db.LogAdminAction(r.Context(), actor.ID, "user.create", user.Email,
		map[string]any{"is_admin": req.IsAdmin, "org_id": req.OrgID, "role": assigned})

	resp := map[string]any{"user": user}
	if generated {
		// Affiché une seule fois : seul le hash est conservé.
		resp["password"] = password
		resp["warning"] = "mot de passe temporaire — transmettez-le, il ne sera plus affiché"
	}
	writeJSON(w, http.StatusCreated, resp)
}

// adminResetPassword impose un nouveau mot de passe temporaire.
func (a *API) adminResetPassword(w http.ResponseWriter, r *http.Request) {
	actor, _ := currentUser(r)
	userID := r.PathValue("id")

	// Réinitialiser un mot de passe donne accès au compte : la même hiérarchie
	// s'applique qu'à un changement de statut.
	target, err := a.db.GetUser(r.Context(), userID)
	if err != nil {
		writeErr(w, http.StatusNotFound, "compte introuvable")
		return
	}
	if err := a.guardAccountEdit(actor, target); err != nil {
		writeErr(w, http.StatusForbidden, err.Error())
		return
	}

	var req struct {
		Password string `json:"password"`
	}
	_ = decode(r, &req)

	password := req.Password
	generated := false
	if password == "" {
		p, err := auth.GeneratePassword()
		if err != nil {
			a.fail(w, "GeneratePassword", err)
			return
		}
		password = p
		generated = true
	}

	hash, err := auth.HashPassword(password)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := a.db.ResetPassword(r.Context(), userID, hash); err != nil {
		a.fail(w, "ResetPassword", err)
		return
	}

	a.db.LogAdminAction(r.Context(), actor.ID, "user.reset_password", userID, nil)

	resp := map[string]any{"status": "mot de passe réinitialisé, sessions fermées"}
	if generated {
		resp["password"] = password
	}
	writeJSON(w, http.StatusOK, resp)
}

// adminSetUserStatus active ou désactive un compte, et gère le rôle admin.
func (a *API) adminSetUserStatus(w http.ResponseWriter, r *http.Request) {
	actor, _ := currentUser(r)
	userID := r.PathValue("id")

	var req struct {
		Disabled *bool `json:"disabled"`
		IsAdmin  *bool `json:"is_admin"`
	}
	if err := decode(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "JSON invalide")
		return
	}

	target, err := a.db.GetUser(r.Context(), userID)
	if err != nil {
		writeErr(w, http.StatusNotFound, "compte introuvable")
		return
	}

	// Hiérarchie stricte : un administrateur ne touche pas à un pair, et
	// personne ne touche au super-admin. Ce dernier subsistant toujours,
	// l'instance ne peut plus se retrouver sans administrateur.
	if err := a.guardAccountEdit(actor, target); err != nil {
		writeErr(w, http.StatusForbidden, err.Error())
		return
	}

	// Nommer un administrateur relève du seul super-admin : sinon un admin
	// pourrait s'entourer de pairs et diluer le niveau au-dessus de lui.
	if req.IsAdmin != nil && !actor.IsSuperAdmin {
		writeErr(w, http.StatusForbidden,
			"seul le super-administrateur nomme ou révoque un administrateur")
		return
	}

	if req.IsAdmin != nil {
		if err := a.db.SetUserAdmin(r.Context(), userID, *req.IsAdmin); err != nil {
			a.fail(w, "SetUserAdmin", err)
			return
		}
		a.db.LogAdminAction(r.Context(), actor.ID, "user.set_admin", target.Email,
			map[string]any{"is_admin": *req.IsAdmin})
	}
	if req.Disabled != nil {
		if err := a.db.SetUserDisabled(r.Context(), userID, *req.Disabled); err != nil {
			a.fail(w, "SetUserDisabled", err)
			return
		}
		a.db.LogAdminAction(r.Context(), actor.ID, "user.set_disabled", target.Email,
			map[string]any{"disabled": *req.Disabled})
	}

	updated, _ := a.db.GetUser(r.Context(), userID)
	writeJSON(w, http.StatusOK, updated)
}

// adminAssignOrg affecte un compte à une organisation, avec son rôle.
func (a *API) adminAssignOrg(w http.ResponseWriter, r *http.Request) {
	actor, _ := currentUser(r)

	var req struct {
		UserID string `json:"user_id"`
		OrgID  string `json:"org_id"`
		Role   string `json:"role"`
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

	if err := a.db.AddMember(r.Context(), req.OrgID, req.UserID, req.Role); err != nil {
		a.fail(w, "AddMember", err)
		return
	}
	a.db.LogAdminAction(r.Context(), actor.ID, "user.assign_org", req.UserID,
		map[string]any{"org_id": req.OrgID, "role": req.Role})

	writeJSON(w, http.StatusOK, map[string]any{"user_id": req.UserID, "role": req.Role})
}

// ---------------------------------------------------------------------------
// Permissions individuelles
// ---------------------------------------------------------------------------

// getUserPermissions retourne les droits effectifs d'un membre : ceux de son
// rôle, corrigés par ses exceptions individuelles.
func (a *API) getUserPermissions(w http.ResponseWriter, r *http.Request) {
	orgID, _ := currentOrg(r)
	userID := r.PathValue("userID")

	role, err := a.db.GetMembership(r.Context(), orgID, userID)
	if err != nil {
		writeErr(w, http.StatusNotFound, "ce membre n'appartient pas à l'organisation")
		return
	}

	overrides, err := a.db.GetUserPermissions(r.Context(), orgID, userID)
	if err != nil {
		a.fail(w, "GetUserPermissions", err)
		return
	}

	// Le détail permet à l'interface de distinguer ce qui vient du rôle de ce
	// qui a été décidé individuellement.
	catalog := make([]map[string]any, 0, len(auth.AllPermissions))
	effective := auth.EffectivePermissions(role, overrides)
	for _, p := range auth.AllPermissions {
		entry := map[string]any{
			"key":        p.Key,
			"label":      p.Label,
			"hint":       p.Hint,
			"granted":    effective[p.Key],
			"from_role":  auth.RoleGrants(role, p.Key),
			"overridden": false,
		}
		if _, ok := overrides[p.Key]; ok {
			entry["overridden"] = true
		}
		catalog = append(catalog, entry)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"user_id":     userID,
		"role":        role,
		"permissions": catalog,
	})
}

// setUserPermission accorde ou retire une permission individuellement.
// reset=true supprime l'exception : le rôle reprend la main.
func (a *API) setUserPermission(w http.ResponseWriter, r *http.Request) {
	orgID, _ := currentOrg(r)
	actor, _ := currentUser(r)
	userID := r.PathValue("userID")

	var req struct {
		Permission string `json:"permission"`
		Granted    bool   `json:"granted"`
		Reset      bool   `json:"reset"`
	}
	if err := decode(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "JSON invalide")
		return
	}
	if !auth.ValidatePermission(req.Permission) {
		writeErr(w, http.StatusBadRequest, "permission inconnue : "+req.Permission)
		return
	}

	targetRole, err := a.db.GetMembership(r.Context(), orgID, userID)
	if err != nil {
		writeErr(w, http.StatusNotFound, "ce membre n'appartient pas à l'organisation")
		return
	}

	// Les droits d'un admin d'organisation ne se règlent pas entre pairs.
	if err := a.guardPeerEdit(r, orgID, userID, targetRole, actor); err != nil {
		writeErr(w, http.StatusForbidden, err.Error())
		return
	}

	if req.Reset {
		if err := a.db.ClearUserPermission(r.Context(), orgID, userID, req.Permission); err != nil {
			a.fail(w, "ClearUserPermission", err)
			return
		}
	} else if err := a.db.SetUserPermission(r.Context(), orgID, userID,
		req.Permission, req.Granted, actor.ID); err != nil {
		a.fail(w, "SetUserPermission", err)
		return
	}

	a.db.LogAdminAction(r.Context(), actor.ID, "permission.set", userID,
		map[string]any{"permission": req.Permission, "granted": req.Granted, "reset": req.Reset})

	writeJSON(w, http.StatusOK, map[string]any{
		"permission": req.Permission,
		"granted":    req.Granted,
		"reset":      req.Reset,
	})
}

// adminListOrganizations liste toutes les organisations de la plateforme.
func (a *API) adminListOrganizations(w http.ResponseWriter, r *http.Request) {
	orgs, err := a.db.ListAllOrganizations(r.Context())
	if err != nil {
		a.fail(w, "ListAllOrganizations", err)
		return
	}
	writeJSON(w, http.StatusOK, orgs)
}

// adminCreateOrganization crée une organisation sans y placer son créateur :
// un administrateur de plateforme n'a pas vocation à être membre de tout.
func (a *API) adminCreateOrganization(w http.ResponseWriter, r *http.Request) {
	actor, _ := currentUser(r)

	var req struct {
		Name    string `json:"name"`
		Slug    string `json:"slug"`
		OwnerID string `json:"owner_id"`
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

	// Sans propriétaire désigné, l'admin le devient : une organisation sans
	// membre serait inaccessible.
	owner := req.OwnerID
	if owner == "" {
		owner = actor.ID
	}

	org, err := a.db.CreateOrganization(r.Context(), slug, req.Name, owner)
	if err != nil {
		a.log.Warn("création d'organisation refusée", "slug", slug, "err", err)
		writeErr(w, http.StatusConflict, "cet identifiant est déjà pris")
		return
	}

	a.db.LogAdminAction(r.Context(), actor.ID, "org.create", org.Slug,
		map[string]any{"owner_id": owner})
	writeJSON(w, http.StatusCreated, org)
}

// adminRenameOrganization change le nom affiché d'une organisation.
func (a *API) adminRenameOrganization(w http.ResponseWriter, r *http.Request) {
	actor, _ := currentUser(r)
	id := r.PathValue("id")

	var req struct {
		Name string `json:"name"`
	}
	if err := decode(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, "JSON invalide")
		return
	}
	if req.Name == "" {
		writeErr(w, http.StatusBadRequest, "le champ 'name' est requis")
		return
	}

	org, err := a.db.RenameOrganization(r.Context(), id, req.Name)
	if err != nil {
		if isNotFound(err) {
			writeErr(w, http.StatusNotFound, "organisation introuvable")
			return
		}
		a.fail(w, "RenameOrganization", err)
		return
	}

	a.db.LogAdminAction(r.Context(), actor.ID, "org.rename", org.Slug,
		map[string]any{"name": req.Name})
	writeJSON(w, http.StatusOK, org)
}

// adminDeleteOrganization supprime une organisation vide.
//
// Une organisation qui héberge encore des applications est refusée : la
// cascade en base les effacerait sans rien retirer du cluster. Il faut
// supprimer les applications d'abord, ce qui passe par l'agent.
func (a *API) adminDeleteOrganization(w http.ResponseWriter, r *http.Request) {
	actor, _ := currentUser(r)
	id := r.PathValue("id")

	if err := a.db.DeleteOrganization(r.Context(), id); err != nil {
		if errors.Is(err, db.ErrOrgNotEmpty) {
			writeErr(w, http.StatusConflict,
				"organisation non vide : supprimez d'abord ses applications")
			return
		}
		if isNotFound(err) {
			writeErr(w, http.StatusNotFound, "organisation introuvable")
			return
		}
		a.fail(w, "DeleteOrganization", err)
		return
	}

	a.db.LogAdminAction(r.Context(), actor.ID, "org.delete", id, nil)
	w.WriteHeader(http.StatusNoContent)
}

// adminListOrgMembers montre qui compose une organisation, sans exiger que
// l'administrateur en soit membre.
func (a *API) adminListOrgMembers(w http.ResponseWriter, r *http.Request) {
	members, err := a.db.ListMembers(r.Context(), r.PathValue("id"))
	if err != nil {
		a.fail(w, "ListMembers", err)
		return
	}
	writeJSON(w, http.StatusOK, members)
}

// adminRemoveOrgMember retire quelqu'un d'une organisation.
func (a *API) adminRemoveOrgMember(w http.ResponseWriter, r *http.Request) {
	actor, _ := currentUser(r)
	orgID, userID := r.PathValue("id"), r.PathValue("userID")

	if err := a.db.RemoveMember(r.Context(), orgID, userID); err != nil {
		if errors.Is(err, db.ErrLastOwner) {
			writeErr(w, http.StatusConflict,
				"dernier propriétaire : nommez-en un autre avant de le retirer")
			return
		}
		if isNotFound(err) {
			writeErr(w, http.StatusNotFound, "cette personne n'est pas membre")
			return
		}
		a.fail(w, "RemoveMember", err)
		return
	}

	a.db.LogAdminAction(r.Context(), actor.ID, "org.remove_member", userID,
		map[string]any{"org_id": orgID})
	w.WriteHeader(http.StatusNoContent)
}

// ---------------------------------------------------------------------------
// Portée des clusters
// ---------------------------------------------------------------------------

// adminListClusters montre tous les clusters de la plateforme et, pour chacun,
// les organisations auxquelles il est restreint.
//
// Une liste `organizations` vide signifie « aucune restriction » : le cluster
// est visible par toutes. C'est le cas courant — plusieurs organisations
// partagent la même infrastructure, isolées par leurs namespaces.
func (a *API) adminListClusters(w http.ResponseWriter, r *http.Request) {
	// orgID vide : vue plateforme, sans filtre.
	clusters, err := a.db.ListClusters(r.Context(), "")
	if err != nil {
		a.fail(w, "ListClusters", err)
		return
	}

	live := map[string]bool{}
	for _, name := range a.grpc.ConnectedAgents() {
		live[name] = true
	}

	out := make([]map[string]any, 0, len(clusters))
	for _, c := range clusters {
		orgs, err := a.db.ListClusterOrgs(r.Context(), c.ID)
		if err != nil {
			a.fail(w, "ListClusterOrgs", err)
			return
		}
		out = append(out, map[string]any{
			"id":            c.ID,
			"name":          c.Name,
			"connected":     live[c.Name],
			"last_seen":     c.LastSeen,
			"organizations": orgs,
			"shared":        len(orgs) == 0,
		})
	}
	writeJSON(w, http.StatusOK, out)
}

// adminRestrictCluster réserve un cluster à une organisation de plus.
//
// La PREMIÈRE restriction change le sens du cluster : de « visible par toutes »
// il devient « visible par celle-ci seulement ». Les autres organisations le
// perdent alors de vue, d'où l'avertissement renvoyé.
func (a *API) adminRestrictCluster(w http.ResponseWriter, r *http.Request) {
	actor, _ := currentUser(r)
	clusterID, orgID := r.PathValue("id"), r.PathValue("orgID")

	before, err := a.db.ListClusterOrgs(r.Context(), clusterID)
	if err != nil {
		a.fail(w, "ListClusterOrgs", err)
		return
	}

	if err := a.db.RestrictClusterToOrg(r.Context(), clusterID, orgID); err != nil {
		a.fail(w, "RestrictClusterToOrg", err)
		return
	}
	a.db.LogAdminAction(r.Context(), actor.ID, "cluster.restrict", clusterID,
		map[string]any{"org_id": orgID})

	resp := map[string]any{"status": "organisation autorisée"}
	if len(before) == 0 {
		resp["warning"] = "ce cluster n'est plus partagé : seules les " +
			"organisations autorisées le voient désormais"
	}
	writeJSON(w, http.StatusOK, resp)
}

// adminUnrestrictCluster retire une organisation de la liste. Retirer la
// dernière rend le cluster à nouveau visible par toutes.
func (a *API) adminUnrestrictCluster(w http.ResponseWriter, r *http.Request) {
	actor, _ := currentUser(r)
	clusterID, orgID := r.PathValue("id"), r.PathValue("orgID")

	if err := a.db.UnrestrictClusterFromOrg(r.Context(), clusterID, orgID); err != nil {
		if isNotFound(err) {
			writeErr(w, http.StatusNotFound, "cette organisation n'est pas autorisée")
			return
		}
		a.fail(w, "UnrestrictClusterFromOrg", err)
		return
	}

	rest, err := a.db.ListClusterOrgs(r.Context(), clusterID)
	if err != nil {
		a.fail(w, "ListClusterOrgs", err)
		return
	}
	a.db.LogAdminAction(r.Context(), actor.ID, "cluster.unrestrict", clusterID,
		map[string]any{"org_id": orgID})

	resp := map[string]any{"status": "organisation retirée"}
	if len(rest) == 0 {
		resp["warning"] = "plus aucune restriction : ce cluster redevient " +
			"visible par toutes les organisations"
	}
	writeJSON(w, http.StatusOK, resp)
}
