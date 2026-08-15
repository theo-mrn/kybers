/**
 * Coloration syntaxique légère.
 *
 * Shiki ferait mieux, mais charge un moteur WASM et une grammaire complète
 * côté client — disproportionné pour afficher un workflow YAML et un README.
 * On tokenise donc ligne par ligne, ce qui suffit pour les langages que les
 * modèles produisent réellement.
 *
 * Les couleurs viennent des variables du thème : la coloration doit suivre le
 * vert/sombre de Kybers, pas un thème d'éditeur importé.
 */

export type Token = { text: string; className?: string };

/** Étiquette de langage, déduite de l'extension. */
export function languageOf(path: string) {
  const p = path.toLowerCase();
  if (p.endsWith(".yml") || p.endsWith(".yaml")) return "yaml";
  if (p.endsWith(".md")) return "markdown";
  if (p.endsWith(".json")) return "json";
  if (p.endsWith(".sh") || p.endsWith(".bash")) return "shell";
  if (p.endsWith(".ts") || p.endsWith(".tsx")) return "typescript";
  if (p.endsWith(".js") || p.endsWith(".jsx") || p.endsWith(".mjs"))
    return "javascript";
  if (p.endsWith(".go")) return "go";
  if (p.endsWith(".py")) return "python";
  if (p.endsWith(".css")) return "css";
  if (p.endsWith(".toml")) return "toml";
  if (p.includes("dockerfile")) return "dockerfile";
  return "texte";
}

const CLS = {
  comment: "text-muted-foreground/70 italic",
  string: "text-success",
  keyword: "text-primary",
  number: "text-chart-4",
  key: "text-chart-2",
  heading: "font-semibold text-foreground",
  placeholder: "rounded bg-primary/15 px-0.5 text-primary",
} as const;

const KEYWORDS: Record<string, string[]> = {
  typescript: ["import","from","export","default","const","let","var","function","return","async","await","if","else","for","while","type","interface","class","extends","new","try","catch","throw","as"],
  javascript: ["import","from","export","default","const","let","var","function","return","async","await","if","else","for","while","class","extends","new","try","catch","throw"],
  go: ["package","import","func","return","var","const","type","struct","interface","if","else","for","range","go","defer","chan","map","select","switch","case","nil"],
  python: ["import","from","def","return","class","if","elif","else","for","while","with","as","try","except","raise","lambda","None","True","False"],
  shell: ["if","then","else","fi","for","in","do","done","while","case","esac","function","export","local","return","echo","set"],
  dockerfile: ["FROM","RUN","CMD","LABEL","EXPOSE","ENV","ADD","COPY","ENTRYPOINT","VOLUME","USER","WORKDIR","ARG","HEALTHCHECK"],
};

/** Motif de commentaire de début de ligne, par langage. */
const LINE_COMMENT: Record<string, string> = {
  yaml: "#",
  shell: "#",
  python: "#",
  toml: "#",
  dockerfile: "#",
  typescript: "//",
  javascript: "//",
  go: "//",
};

/**
 * Découpe une ligne en jetons colorisés.
 *
 * Le traitement est volontairement sans état d'une ligne à l'autre : un
 * commentaire de bloc non refermé ne colorisera pas la suite, ce qui est une
 * approximation acceptable pour un aperçu en lecture seule.
 */
export function highlight(line: string, language: string): Token[] {
  if (line === "") return [{ text: "" }];

  const comment = LINE_COMMENT[language];
  if (comment) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith(comment)) return [{ text: line, className: CLS.comment }];
  }

  const tokens =
    language === "markdown"
      ? markdown(line)
      : language === "yaml" || language === "toml"
        ? yaml(line)
        : language === "json"
          ? json(line)
          : code(line, KEYWORDS[language] ?? []);

  return tokens.flatMap(splitPlaceholders);
}

/**
 * Isole les substitutions Kybers, quel que soit le langage.
 *
 * C'est l'information la plus utile de l'aperçu : voir d'un coup d'œil ce qui
 * sera remplacé à l'écriture.
 */
function splitPlaceholders(token: Token): Token[] {
  if (!token.text.includes("{{")) return [token];

  const out: Token[] = [];
  const re = /\{\{\s*\w+\s*\}\}/g;
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(token.text))) {
    if (m.index > last)
      out.push({ text: token.text.slice(last, m.index), className: token.className });
    out.push({ text: m[0], className: CLS.placeholder });
    last = m.index + m[0].length;
  }
  if (last < token.text.length)
    out.push({ text: token.text.slice(last), className: token.className });

  return out;
}

function markdown(line: string): Token[] {
  if (/^\s*#{1,6}\s/.test(line)) return [{ text: line, className: CLS.heading }];
  if (/^\s*(```|~~~)/.test(line)) return [{ text: line, className: CLS.comment }];
  if (/^\s*[-*+]\s/.test(line) || /^\s*\d+\.\s/.test(line)) {
    const at = line.search(/\S/);
    return [
      { text: line.slice(0, at) },
      { text: line.slice(at, at + 1), className: CLS.keyword },
      { text: line.slice(at + 1) },
    ];
  }
  return [{ text: line }];
}

function yaml(line: string): Token[] {
  // `clé:` en tête de ligne, éventuellement précédée d'un tiret de liste.
  const m = /^(\s*(?:-\s+)?)([\w.\-"']+)(\s*:)(.*)$/.exec(line);
  if (!m) return [{ text: line }];
  return [
    { text: m[1] },
    { text: m[2], className: CLS.key },
    { text: m[3] },
    ...value(m[4]),
  ];
}

function json(line: string): Token[] {
  const m = /^(\s*)("(?:[^"\\]|\\.)*")(\s*:)(.*)$/.exec(line);
  if (!m) return value(line);
  return [
    { text: m[1] },
    { text: m[2], className: CLS.key },
    { text: m[3] },
    ...value(m[4]),
  ];
}

/** Colorise une valeur : chaîne, nombre, littéral. */
function value(text: string): Token[] {
  const out: Token[] = [];
  const re = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\b\d+(?:\.\d+)?\b)|(\b(?:true|false|null|yes|no|on|off)\b)/g;
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({
      text: m[0],
      className: m[1] ? CLS.string : m[2] ? CLS.number : CLS.keyword,
    });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

function code(line: string, keywords: string[]): Token[] {
  const out: Token[] = [];
  const kw = keywords.length
    ? new RegExp(`\\b(?:${keywords.join("|")})\\b`)
    : null;

  // Un seul balayage : chaînes, commentaires de fin de ligne, nombres, mots-clés.
  const re = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\/\/.*$|#.*$)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][\w]*)/g;
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(line))) {
    if (m.index > last) out.push({ text: line.slice(last, m.index) });

    if (m[1]) out.push({ text: m[0], className: CLS.string });
    else if (m[2]) out.push({ text: m[0], className: CLS.comment });
    else if (m[3]) out.push({ text: m[0], className: CLS.number });
    else if (m[4] && kw?.test(m[4]))
      out.push({ text: m[0], className: CLS.keyword });
    else out.push({ text: m[0] });

    last = m.index + m[0].length;
  }
  if (last < line.length) out.push({ text: line.slice(last) });
  return out;
}
