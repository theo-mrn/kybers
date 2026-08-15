/**
 * Chemins de destination dans le dépôt.
 *
 * Le chemin d'un modèle est saisi à la main : `/README.md`, `./README.md` et
 * `README.md` désignent le même fichier sans se ressembler. Comparer les
 * chaînes brutes laisserait passer des collisions qui écraseraient un fichier
 * à l'écriture, `PutFile` étant un upsert côté GitHub.
 */

/**
 * Ramène un chemin à sa forme canonique, telle que l'API GitHub la verra.
 *
 * Résout `.` et `..`, supprime les séparateurs redondants et le préfixe
 * racine. Un `..` qui remonterait au-delà de la racine est conservé tel quel :
 * c'est un chemin invalide, et le signaler vaut mieux que le corriger en
 * silence.
 */
export function normalizePath(path: string): string {
  const parts = path.trim().replace(/\\/g, "/").split("/");
  const out: string[] = [];

  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === ".." && out.length > 0 && out[out.length - 1] !== "..") {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join("/");
}

/** Une collision : un chemin visé par plusieurs fichiers. */
export type Collision = { path: string; names: string[] };

/**
 * Repère les fichiers qui visent le même chemin.
 *
 * Deux modèles peuvent légitimement produire un README ; les cocher tous les
 * deux ne produit pas deux fichiers, mais un seul, écrit deux fois. L'ordre
 * d'écriture décide du gagnant — autant l'empêcher.
 */
export function findCollisions(
  files: { path: string; name?: string }[],
): Collision[] {
  const byPath = new Map<string, string[]>();

  for (const f of files) {
    const key = normalizePath(f.path);
    if (!key) continue;
    byPath.set(key, [...(byPath.get(key) ?? []), f.name ?? f.path]);
  }

  return [...byPath.entries()]
    .filter(([, names]) => names.length > 1)
    .map(([path, names]) => ({ path, names }));
}

/**
 * Valide un chemin de destination.
 *
 * Retourne `null` si le chemin est utilisable, sinon le motif du refus.
 * GitHub rejette ces chemins de toute façon ; les intercepter ici évite une
 * écriture partielle qu'il faudrait reprendre à la main.
 */
export function validatePath(path: string): string | null {
  const raw = path.trim();
  if (!raw) return "Indiquez un chemin de destination.";

  const clean = normalizePath(raw);
  if (!clean) return "Ce chemin ne désigne aucun fichier.";
  if (clean.startsWith("..")) return "Le chemin sort de la racine du dépôt.";
  if (raw.startsWith("/")) return null; // toléré : normalisé en relatif

  if (clean.split("/").includes(".git"))
    return "Le dossier .git est réservé à Git.";

  return null;
}

/** Nom de fichier, dernier segment du chemin. */
export function basename(path: string): string {
  const clean = normalizePath(path);
  return clean.slice(clean.lastIndexOf("/") + 1);
}

/** Dossier parent, chaîne vide à la racine. */
export function dirname(path: string): string {
  const clean = normalizePath(path);
  const at = clean.lastIndexOf("/");
  return at === -1 ? "" : clean.slice(0, at);
}

/**
 * Recalcule le chemin d'un fichier déplacé vers un dossier.
 *
 * `dir` vide désigne la racine du dépôt. Le nom du fichier est conservé : un
 * déplacement ne renomme pas.
 */
export function moveTo(path: string, dir: string): string {
  const name = basename(path);
  const target = normalizePath(dir);
  return target ? `${target}/${name}` : name;
}

/**
 * Vérifie qu'un déplacement est possible.
 *
 * Retourne `null` si le geste est valide, sinon son motif de refus. Deux cas
 * n'ont pas de sens : déposer un fichier là où il est déjà, et déposer sur un
 * dossier qui contient déjà ce nom — ce dernier écraserait un fichier existant.
 */
export function canMove(
  path: string,
  dir: string,
  siblings: string[],
): string | null {
  const next = moveTo(path, dir);
  if (next === normalizePath(path)) return "Le fichier est déjà ici.";
  if (siblings.some((s) => normalizePath(s) === next))
    return `${basename(path)} existe déjà dans ce dossier.`;
  return null;
}
