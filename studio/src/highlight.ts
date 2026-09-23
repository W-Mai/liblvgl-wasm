type TokenKind = "comment" | "directive" | "function" | "keyword" | "number" | "string" | "type";
export type SourceToken = { text: string; kind?: TokenKind };

const keywords: Record<string, Set<string>> = {
  js: new Set("async await break case catch class const continue default do else export extends false finally for from function if import in let new null return static super switch this throw true try typeof undefined var void while yield".split(" ")),
  ts: new Set("as async await break case catch class const continue default do else enum export extends false finally for from function if implements import in interface keyof let namespace new null private protected public readonly return static super switch this throw true try type typeof undefined var void while yield".split(" ")),
  c: new Set("auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while".split(" ")),
  cpp: new Set("auto bool break case catch char class const constexpr continue decltype default delete do double else enum explicit extern false float for friend if inline int long namespace new nullptr operator private protected public return short signed sizeof static struct switch template this throw true try typedef typename union unsigned using virtual void volatile while".split(" ")),
  rs: new Set("as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while".split(" ")),
  sh: new Set("case do done elif else esac exit export fi for function if in local readonly return set then unset until while".split(" ")),
  toml: new Set(["true", "false"]),
};

const tokenPattern = /\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\n]*|#[^\n]*|"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|`(?:\\.|[^`\\])*`?|\b(?:0[xX][\da-fA-F]+|\d+(?:\.\d+)?)\b|[A-Za-z_$][\w$]*/g;

export function tokenizeSource(source: string, filename: string): SourceToken[] {
  const extension = filename.split(".").at(-1) || "";
  const language = extension === "h" ? "c" : extension;
  const tokens: SourceToken[] = [];
  tokenPattern.lastIndex = 0;
  let offset = 0;
  for (const match of source.matchAll(tokenPattern)) {
    const index = match.index;
    if (index > offset) tokens.push({ text: source.slice(offset, index) });
    const text = match[0];
    let kind: TokenKind | undefined;
    if (text.startsWith("//") || text.startsWith("/*")) kind = "comment";
    else if (text.startsWith("#")) kind = language === "sh" || language === "toml" ? "comment" : "directive";
    else if (/^["'`]/.test(text)) kind = "string";
    else if (/^\d/.test(text)) kind = "number";
    else if (keywords[language]?.has(text)) kind = "keyword";
    else if (/^(?:[ui]\d+|[A-Za-z_]\w*_t)$/.test(text)) kind = "type";
    else if (/^\s*\(/.test(source.slice(index + text.length))) kind = "function";
    tokens.push({ text, kind });
    offset = index + text.length;
  }
  if (offset < source.length) tokens.push({ text: source.slice(offset) });
  return tokens;
}

export function renderHighlighted(code: HTMLElement, source: string, filename: string): void {
  const fragment = document.createDocumentFragment();
  for (const token of tokenizeSource(source, filename)) {
    if (!token.kind) {
      fragment.append(document.createTextNode(token.text));
      continue;
    }
    const span = document.createElement("span");
    span.className = `syntax-${token.kind}`;
    span.textContent = token.text;
    fragment.append(span);
  }
  code.replaceChildren(fragment);
}
