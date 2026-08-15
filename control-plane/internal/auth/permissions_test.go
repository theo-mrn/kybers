package auth

import "testing"

func TestPermissionsParDefautSelonRole(t *testing.T) {
	// Un propriétaire a tout ; un lecteur ne peut rien modifier.
	if !RoleGrants(RoleOwner, PermMemberManage) {
		t.Error("un propriétaire doit gérer l'équipe")
	}
	if RoleGrants(RoleMember, PermMemberManage) {
		t.Error("un membre ne doit pas gérer l'équipe")
	}
	if RoleGrants(RoleViewer, PermAppDeploy) {
		t.Error("un lecteur ne doit pas déployer")
	}
	if !RoleGrants(RoleViewer, PermAppRead) {
		t.Error("un lecteur doit pouvoir consulter")
	}
	// Les secrets ne sont pas lisibles par un simple lecteur : même les noms
	// révèlent la structure d'une application.
	if RoleGrants(RoleViewer, PermSecretRead) {
		t.Error("un lecteur ne doit pas accéder aux secrets")
	}
}

// Le cas d'usage central : un membre qui déploie mais ne supprime pas.
func TestPermissionRetireeMalgreLeRole(t *testing.T) {
	overrides := map[string]bool{PermAppDelete: false}

	if !HasPermission(RoleMember, overrides, PermAppDeploy) {
		t.Error("le déploiement doit rester autorisé")
	}
	if HasPermission(RoleMember, overrides, PermAppDelete) {
		t.Error("la suppression a été explicitement retirée")
	}
}

// L'inverse : accorder un droit au-delà du rôle.
func TestPermissionAccordeeAuDelaDuRole(t *testing.T) {
	overrides := map[string]bool{PermAppDeploy: true}

	if !HasPermission(RoleViewer, overrides, PermAppDeploy) {
		t.Error("le déploiement a été explicitement accordé")
	}
	// Les autres permissions du lecteur restent inchangées.
	if HasPermission(RoleViewer, overrides, PermAppDelete) {
		t.Error("seule la permission accordée doit changer")
	}
}

func TestEffectivePermissions(t *testing.T) {
	eff := EffectivePermissions(RoleMember, map[string]bool{
		PermAppDelete:    false,
		PermMemberManage: true,
	})

	if eff[PermAppDelete] {
		t.Error("la suppression devait être retirée")
	}
	if !eff[PermMemberManage] {
		t.Error("la gestion d'équipe devait être accordée")
	}
	if !eff[PermAppDeploy] {
		t.Error("les permissions du rôle non modifiées doivent subsister")
	}
}

// Un rôle inconnu ne doit rien accorder : une valeur corrompue en base ne doit
// pas ouvrir des droits.
func TestRoleInconnuNAccordeRien(t *testing.T) {
	if RoleGrants("superadmin", PermAppRead) {
		t.Error("un rôle inconnu ne doit accorder aucune permission")
	}
	if len(RolePermissions("nimporte-quoi")) != 0 {
		t.Error("un rôle inconnu ne doit produire aucune permission")
	}
}

func TestValidatePermission(t *testing.T) {
	if !ValidatePermission(PermAppDeploy) {
		t.Error("une permission connue doit être acceptée")
	}
	// Une faute de frappe ne doit pas créer une permission sans effet.
	if ValidatePermission("app:deployy") {
		t.Error("une permission inconnue doit être rejetée")
	}
}

// Toutes les permissions déclarées doivent être accordées par au moins un rôle,
// sinon elles seraient inatteignables sans exception individuelle.
func TestToutesLesPermissionsSontAtteignables(t *testing.T) {
	for _, p := range AllPermissions {
		if !RoleGrants(RoleOwner, p.Key) {
			t.Errorf("le propriétaire devrait accorder %q", p.Key)
		}
	}
}
