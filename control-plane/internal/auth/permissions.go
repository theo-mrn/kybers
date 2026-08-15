package auth

// Permissions individuelles, plus fines que les rôles.
//
// Un rôle accorde un ensemble de permissions par défaut ; une permission
// explicite peut en ajouter une au-delà du rôle, ou en retirer une malgré lui.
// Cela permet à un administrateur de dire « ce membre déploie mais ne supprime
// pas », sans inventer un rôle par cas particulier.
const (
	PermAppRead       = "app:read"       // voir les applications et leurs déploiements
	PermAppDeploy     = "app:deploy"     // déployer une nouvelle révision
	PermAppConfig     = "app:config"     // modifier ressources, sondes, variables
	PermAppLifecyle   = "app:lifecycle"  // scale, stop, restart, rollback
	PermAppDelete     = "app:delete"     // supprimer une application ou un environnement
	PermSecretRead    = "secret:read"    // lister les noms des secrets
	PermSecretWrite   = "secret:write"   // définir des secrets
	PermLogsRead      = "logs:read"      // consulter logs et events
	PermClusterRead   = "cluster:read"   // voir l'infrastructure
	PermClusterWrite  = "cluster:write"  // enregistrer ou supprimer un cluster
	PermRegistryRead  = "registry:read"  // voir les registries
	PermRegistryWrite = "registry:write" // connecter ou supprimer un registry
	PermMemberManage  = "member:manage"  // gérer les membres de l'organisation
)

// AllPermissions liste les permissions pilotables, avec leur libellé.
// L'ordre est celui de l'affichage dans l'interface.
var AllPermissions = []struct {
	Key   string
	Label string
	Hint  string
}{
	{PermAppRead, "Voir les applications", "consulter les applications et leurs déploiements"},
	{PermAppDeploy, "Déployer", "lancer une nouvelle révision"},
	{PermAppConfig, "Configurer", "ressources, sondes, variables d'environnement"},
	{PermAppLifecyle, "Piloter", "scale, arrêt, redémarrage, rollback"},
	{PermAppDelete, "Supprimer", "supprimer une application ou un environnement"},
	{PermSecretRead, "Voir les secrets", "lister les noms, jamais les valeurs"},
	{PermSecretWrite, "Définir des secrets", "enregistrer des variables sensibles"},
	{PermLogsRead, "Consulter les logs", "logs applicatifs et events Kubernetes"},
	{PermClusterRead, "Voir l'infrastructure", "état des clusters et consommation"},
	{PermClusterWrite, "Gérer les clusters", "enregistrer ou supprimer un cluster"},
	{PermRegistryRead, "Voir les registries", "lister les registres d'images"},
	{PermRegistryWrite, "Gérer les registries", "connecter ou supprimer un registre"},
	{PermMemberManage, "Gérer l'équipe", "ajouter des membres et fixer leurs droits"},
}

// rolePermissions définit ce que chaque rôle accorde par défaut.
var rolePermissions = map[string]map[string]bool{
	RoleOwner: {
		PermAppRead: true, PermAppDeploy: true, PermAppConfig: true,
		PermAppLifecyle: true, PermAppDelete: true,
		PermSecretRead: true, PermSecretWrite: true, PermLogsRead: true,
		PermClusterRead: true, PermClusterWrite: true,
		PermRegistryRead: true, PermRegistryWrite: true,
		PermMemberManage: true,
	},
	RoleMember: {
		PermAppRead: true, PermAppDeploy: true, PermAppConfig: true,
		PermAppLifecyle: true, PermAppDelete: true,
		PermSecretRead: true, PermSecretWrite: true, PermLogsRead: true,
		PermClusterRead: true, PermRegistryRead: true,
		// Un membre déploie mais n'administre ni l'infrastructure ni l'équipe.
	},
	RoleViewer: {
		PermAppRead: true, PermLogsRead: true,
		PermClusterRead: true, PermRegistryRead: true,
	},
}

// RoleGrants indique si un rôle accorde une permission, sans tenir compte des
// exceptions individuelles.
func RoleGrants(role, permission string) bool {
	perms, ok := rolePermissions[role]
	if !ok {
		return false
	}
	return perms[permission]
}

// RolePermissions retourne les permissions accordées par un rôle.
func RolePermissions(role string) map[string]bool {
	out := map[string]bool{}
	for k, v := range rolePermissions[role] {
		out[k] = v
	}
	return out
}

// HasPermission décide de l'autorisation finale.
//
// overrides contient les exceptions individuelles : true = accordée en plus du
// rôle, false = retirée malgré le rôle. Une exception prime toujours sur le
// rôle, ce qui permet des droits sur mesure sans multiplier les rôles.
func HasPermission(role string, overrides map[string]bool, permission string) bool {
	if v, ok := overrides[permission]; ok {
		return v
	}
	return RoleGrants(role, permission)
}

// EffectivePermissions combine rôle et exceptions : c'est ce que l'interface
// affiche pour montrer les droits réels d'un membre.
func EffectivePermissions(role string, overrides map[string]bool) map[string]bool {
	out := RolePermissions(role)
	for k, v := range overrides {
		out[k] = v
	}
	return out
}

// ValidatePermission rejette une clé inconnue : une faute de frappe ne doit pas
// créer silencieusement une permission sans effet.
func ValidatePermission(permission string) bool {
	for _, p := range AllPermissions {
		if p.Key == permission {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// Hiérarchie des comptes
// ---------------------------------------------------------------------------

// Niveaux d'autorité, du plus fort au plus faible. Ils servent à comparer deux
// comptes : on ne modifie que STRICTEMENT en dessous de soi.
const (
	LevelSuperAdmin = 4 // unique, créé à l'installation
	LevelAdmin      = 3 // administrateurs de plateforme, en nombre libre
	LevelOrgAdmin   = 2 // `owner` dans une organisation
	LevelOrgMember  = 1 // member
	LevelOrgViewer  = 0 // viewer, et non-membre
)

// AccountLevel situe un compte dans la hiérarchie.
//
// Le statut plateforme prime sur le rôle d'organisation : un administrateur
// reste au-dessus d'un admin d'organisation, même s'il n'est que lecteur dans
// celle-ci.
func AccountLevel(isSuperAdmin, isAdmin bool, orgRole string) int {
	switch {
	case isSuperAdmin:
		return LevelSuperAdmin
	case isAdmin:
		return LevelAdmin
	case orgRole == RoleOwner:
		return LevelOrgAdmin
	case orgRole == RoleMember:
		return LevelOrgMember
	default:
		return LevelOrgViewer
	}
}

// CanActOn indique si l'acteur peut modifier la cible.
//
// La comparaison est STRICTE : deux comptes de même niveau ne peuvent rien
// l'un sur l'autre. Sans cela, deux administrateurs pourraient se rétrograder
// mutuellement et le résultat dépendrait de qui agit en premier.
//
// Agir sur soi-même reste toujours permis : renoncer à ses propres droits ou
// quitter une organisation ne dépend de personne. Le super-admin fait
// exception — il est seul à son niveau, se retirer rendrait l'instance
// ingérable.
func CanActOn(actorLevel, targetLevel int, isSelf bool) bool {
	if isSelf {
		return actorLevel != LevelSuperAdmin
	}
	return actorLevel > targetLevel
}
