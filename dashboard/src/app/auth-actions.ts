"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { api } from "@/lib/api";

// Ces actions parlent directement au Control Plane pour récupérer le cookie de
// session qu'il émet, puis le reposent côté navigateur : le client `api` ne
// peut pas le faire, il ne lit que les réponses JSON.

export type AuthState = { ok: boolean; message: string } | null;

const BASE = process.env.KYBERS_API_URL ?? "http://localhost:8080";

/** Extrait le cookie de session d'une réponse et le pose côté navigateur. */
async function storeSession(res: Response): Promise<boolean> {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) return false;

  const match = /kybers_session=([^;]+)/.exec(setCookie);
  if (!match) return false;

  const jar = await cookies();
  jar.set("kybers_session", match[1], {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    // 30 jours, comme la session côté Control Plane.
    maxAge: 30 * 24 * 60 * 60,
  });

  // Organisation active par défaut, prise dans la réponse de connexion.
  //
  // Le Control Plane refuse toute requête sans `X-Kybers-Org` dès qu'on
  // appartient à plusieurs organisations. Sans ce cookie, la session serait
  // valide mais chaque page vide : clusters, applications et déploiements
  // disparaîtraient sans explication. L'utilisateur peut en changer ensuite.
  try {
    const body = (await res.clone().json()) as {
      organizations?: { slug: string }[];
    };
    const first = body.organizations?.[0]?.slug;
    if (first) {
      jar.set("kybers_org", first, { path: "/", maxAge: 365 * 24 * 60 * 60 });
    }
  } catch {
    // Corps illisible : l'utilisateur choisira son organisation lui-même.
  }

  return true;
}

/** Lit le message d'erreur renvoyé par l'API, plutôt qu'un code HTTP brut. */
async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json();
    return body?.error ?? fallback;
  } catch {
    return fallback;
  }
}

export async function loginAction(
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) {
    return { ok: false, message: "Email et mot de passe requis." };
  }

  try {
    const res = await fetch(`${BASE}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
      cache: "no-store",
    });

    if (!res.ok) {
      return { ok: false, message: await errorMessage(res, "Connexion refusée.") };
    }
    if (!(await storeSession(res))) {
      return { ok: false, message: "Session non établie, réessayez." };
    }
  } catch {
    return { ok: false, message: "Control Plane injoignable." };
  }

  redirect("/");
}

export async function registerAction(
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const email = String(formData.get("email") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const orgName = String(formData.get("org_name") ?? "").trim();

  if (!email || !password) {
    return { ok: false, message: "Email et mot de passe requis." };
  }

  try {
    const res = await fetch(`${BASE}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, name, password, org_name: orgName }),
      cache: "no-store",
    });

    if (!res.ok) {
      return { ok: false, message: await errorMessage(res, "Inscription refusée.") };
    }
    if (!(await storeSession(res))) {
      return { ok: false, message: "Compte créé, mais session non établie." };
    }
  } catch {
    return { ok: false, message: "Control Plane injoignable." };
  }

  redirect("/");
}

export async function logoutAction() {
  const jar = await cookies();
  const session = jar.get("kybers_session");

  if (session) {
    // Invalide la session côté serveur : effacer le cookie ne suffirait pas,
    // le jeton resterait utilisable.
    await fetch(`${BASE}/api/v1/auth/logout`, {
      method: "POST",
      headers: { Cookie: `kybers_session=${session.value}` },
      cache: "no-store",
    }).catch(() => {});
  }

  jar.delete("kybers_session");
  jar.delete("kybers_org");
  redirect("/login");
}

/**
 * Change son propre mot de passe.
 *
 * Le Control Plane invalide toutes les sessions au passage : on efface donc le
 * cookie et on renvoie vers la connexion, sinon la navigation suivante
 * échouerait en 401 sans explication.
 */
export async function changePasswordAction(
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const current = String(formData.get("current_password") ?? "");
  const next = String(formData.get("new_password") ?? "");
  const confirm = String(formData.get("confirm_password") ?? "");

  if (!current || !next) {
    return { ok: false, message: "Renseignez les deux mots de passe." };
  }
  if (next !== confirm) {
    return { ok: false, message: "Les deux saisies ne correspondent pas." };
  }
  if (next === current) {
    return { ok: false, message: "Le nouveau mot de passe est identique." };
  }

  try {
    await api.changePassword(current, next);
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : "Changement impossible.",
    };
  }

  const jar = await cookies();
  jar.delete("kybers_session");
  redirect("/login?changed=1");
}

/** Change l'organisation active, mémorisée dans un cookie. */
export async function switchOrgAction(formData: FormData) {
  const slug = String(formData.get("org") ?? "").trim();
  const jar = await cookies();

  if (slug) {
    jar.set("kybers_org", slug, { path: "/", maxAge: 365 * 24 * 60 * 60 });
  } else {
    jar.delete("kybers_org");
  }
  revalidatePath("/", "layout");
}

// ---------------------------------------------------------------------------
// Membres et droits
// ---------------------------------------------------------------------------

export async function addMemberAction(
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const email = String(formData.get("email") ?? "").trim();
  const role = String(formData.get("role") ?? "member");
  // Organisation visée : celle de la page, pas forcément l'organisation active.
  const org = String(formData.get("org_id") ?? "") || undefined;

  if (!email) return { ok: false, message: "Email requis." };

  try {
    await api.addMember(email, role, org);
    revalidatePath("/", "layout");
    return { ok: true, message: `${email} ajouté comme ${role}.` };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : "Ajout impossible.",
    };
  }
}

export async function updateRoleAction(
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const userId = String(formData.get("user_id") ?? "");
  const role = String(formData.get("role") ?? "");
  const org = String(formData.get("org_id") ?? "") || undefined;

  try {
    await api.updateMemberRole(userId, role, org);
    revalidatePath("/", "layout");
    return { ok: true, message: `Rôle modifié : ${role}.` };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : "Modification impossible.",
    };
  }
}

export async function removeMemberAction(
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const userId = String(formData.get("user_id") ?? "");
  const org = String(formData.get("org_id") ?? "") || undefined;

  try {
    await api.removeMember(userId, org);
    revalidatePath("/", "layout");
    return { ok: true, message: "Membre retiré." };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : "Retrait impossible.",
    };
  }
}

// ---------------------------------------------------------------------------
// Jetons d'API
// ---------------------------------------------------------------------------

export type TokenState =
  | { ok: boolean; message: string; token?: string }
  | null;

export async function createTokenAction(
  _prev: TokenState,
  formData: FormData,
): Promise<TokenState> {
  const name = String(formData.get("name") ?? "").trim();
  const days = Number(formData.get("expires_in_days") ?? 0);

  if (!name) return { ok: false, message: "Nommez ce jeton." };

  try {
    const res = await api.createToken(name, days);
    revalidatePath("/", "layout");
    // Le jeton n'est retourné qu'ici : il n'existe qu'en hash côté serveur.
    return { ok: true, message: "Jeton créé.", token: res.token };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : "Création impossible.",
    };
  }
}

export async function deleteTokenAction(
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const id = String(formData.get("token_id") ?? "");

  try {
    await api.deleteToken(id);
    revalidatePath("/", "layout");
    return { ok: true, message: "Jeton révoqué." };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : "Révocation impossible.",
    };
  }
}

// ---------------------------------------------------------------------------
// Administration de la plateforme
// ---------------------------------------------------------------------------

export type AdminUserState =
  | { ok: boolean; message: string; password?: string; email?: string }
  | null;

/** Crée un compte et l'affecte éventuellement à une organisation. */
export async function adminCreateUserAction(
  _prev: AdminUserState,
  formData: FormData,
): Promise<AdminUserState> {
  const email = String(formData.get("email") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const isAdmin = formData.get("is_admin") === "on";
  const orgId = String(formData.get("org_id") ?? "");
  const role = String(formData.get("role") ?? "member");

  if (!email) return { ok: false, message: "Email requis." };

  try {
    const res = await api.adminCreateUser({
      email,
      name,
      is_admin: isAdmin,
      org_id: orgId || undefined,
      role,
    });
    revalidatePath("/", "layout");
    return {
      ok: true,
      message: `Compte créé pour ${email}.`,
      // Affiché une seule fois : à transmettre à la personne.
      password: res.password,
      email,
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Création impossible." };
  }
}

export async function adminSetUserStatusAction(
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const id = String(formData.get("user_id") ?? "");
  const action = String(formData.get("action") ?? "");

  const payload: { disabled?: boolean; is_admin?: boolean } = {};
  if (action === "disable") payload.disabled = true;
  if (action === "enable") payload.disabled = false;
  if (action === "promote") payload.is_admin = true;
  if (action === "demote") payload.is_admin = false;

  try {
    await api.adminSetUserStatus(id, payload);
    revalidatePath("/", "layout");
    return { ok: true, message: "Compte mis à jour." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Action impossible." };
  }
}

export async function adminResetPasswordAction(
  _prev: AdminUserState,
  formData: FormData,
): Promise<AdminUserState> {
  const id = String(formData.get("user_id") ?? "");

  try {
    const res = await api.adminResetPassword(id);
    revalidatePath("/", "layout");
    return {
      ok: true,
      message: "Mot de passe réinitialisé, sessions fermées.",
      password: res.password,
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Réinitialisation impossible." };
  }
}

export async function adminCreateOrgAction(
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const name = String(formData.get("name") ?? "").trim();
  const ownerId = String(formData.get("owner_id") ?? "");
  const slug = String(formData.get("slug") ?? "").trim();

  if (!name) return { ok: false, message: "Nom requis." };

  try {
    const org = await api.adminCreateOrganization(
      name,
      ownerId || undefined,
      slug || undefined,
    );
    revalidatePath("/", "layout");
    return { ok: true, message: `Organisation « ${org.name} » créée (${org.slug}).` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Création impossible." };
  }
}

export async function adminRenameOrgAction(
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const id = String(formData.get("org_id") ?? "");
  const name = String(formData.get("name") ?? "").trim();

  if (!name) return { ok: false, message: "Nom requis." };

  try {
    await api.adminRenameOrganization(id, name);
    revalidatePath("/", "layout");
    return { ok: true, message: "Nom modifié." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Renommage impossible." };
  }
}

export async function adminDeleteOrgAction(
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const id = String(formData.get("org_id") ?? "");

  try {
    await api.adminDeleteOrganization(id);
    revalidatePath("/", "layout");
    return { ok: true, message: "Organisation supprimée." };
  } catch (e) {
    // Le Control Plane refuse une organisation qui héberge des applications :
    // son message est plus précis que tout ce qu'on pourrait deviner ici.
    return { ok: false, message: e instanceof Error ? e.message : "Suppression impossible." };
  }
}

export async function adminRemoveOrgMemberAction(
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const orgId = String(formData.get("org_id") ?? "");
  const userId = String(formData.get("user_id") ?? "");

  try {
    await api.adminRemoveOrgMember(orgId, userId);
    revalidatePath("/", "layout");
    return { ok: true, message: "Membre retiré." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Retrait impossible." };
  }
}

export async function adminAssignOrgAction(
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const userId = String(formData.get("user_id") ?? "");
  const orgId = String(formData.get("org_id") ?? "");
  const role = String(formData.get("role") ?? "member");

  if (!orgId) return { ok: false, message: "Organisation requise." };

  try {
    await api.adminAssignOrg(userId, orgId, role);
    revalidatePath("/", "layout");
    return { ok: true, message: `Affecté comme ${role}.` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Affectation impossible." };
  }
}

/** Accorde, retire, ou rétablit le défaut du rôle pour une permission. */
export async function setPermissionAction(
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const userId = String(formData.get("user_id") ?? "");
  const permission = String(formData.get("permission") ?? "");
  const value = String(formData.get("value") ?? "");
  const org = String(formData.get("org_id") ?? "") || undefined;

  try {
    if (value === "role") {
      // Retour au défaut du rôle : l'exception est supprimée.
      await api.setUserPermission(userId, permission, false, true, org);
    } else {
      await api.setUserPermission(userId, permission, value === "grant", false, org);
    }
    revalidatePath("/", "layout");
    return { ok: true, message: "Droit mis à jour." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Modification impossible." };
  }
}
