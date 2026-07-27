export interface SpindleWriteBinding {
  path: string;
  stringKey: string;
}

type Token = { kind: "identifier" | "string" | "punctuation"; text: string };

const identifierStart = (char: string): boolean => /[A-Za-z_$π]/u.test(char);
const identifierPart = (char: string): boolean => /[A-Za-z0-9_$π]/u.test(char);

const readEscape = (source: string, index: number): { value: string; next: number } => {
  const char = source[index];
  if (char === undefined) return { value: "", next: index };
  const simple: Record<string, string> = {
    n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", 0: "\0",
  };
  if (char in simple) return { value: simple[char]!, next: index + 1 };
  if (char === "\n") return { value: "", next: index + 1 };
  if (char === "\r") return { value: "", next: source[index + 1] === "\n" ? index + 2 : index + 1 };
  if (char === "x") {
    const digits = source.slice(index + 1, index + 3);
    if (/^[0-9a-f]{2}$/i.test(digits)) return { value: String.fromCharCode(Number.parseInt(digits, 16)), next: index + 3 };
  }
  if (char === "u") {
    if (source[index + 1] === "{") {
      const end = source.indexOf("}", index + 2);
      const digits = end < 0 ? "" : source.slice(index + 2, end);
      if (/^[0-9a-f]{1,6}$/i.test(digits)) {
        return { value: String.fromCodePoint(Number.parseInt(digits, 16)), next: end + 1 };
      }
    }
    const digits = source.slice(index + 1, index + 5);
    if (/^[0-9a-f]{4}$/i.test(digits)) return { value: String.fromCharCode(Number.parseInt(digits, 16)), next: index + 5 };
  }
  return { value: char, next: index + 1 };
};

const tokenize = (source: string): Token[] => {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (/\s/u.test(char)) { index++; continue; }
    if (char === "/" && source[index + 1] === "/") {
      index = source.indexOf("\n", index + 2);
      if (index < 0) break;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end < 0 ? source.length : end + 2;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      const quote = char;
      let value = "";
      let dynamicTemplate = false;
      index++;
      while (index < source.length) {
        const current = source[index]!;
        if (current === quote) { index++; break; }
        if (quote === "`" && current === "$" && source[index + 1] === "{") dynamicTemplate = true;
        if (current === "\\") {
          const escaped = readEscape(source, index + 1);
          value += escaped.value;
          index = escaped.next;
          continue;
        }
        value += current;
        index++;
      }
      if (!dynamicTemplate) tokens.push({ kind: "string", text: value });
      continue;
    }
    if (identifierStart(char)) {
      const start = index++;
      while (index < source.length && identifierPart(source[index]!)) index++;
      tokens.push({ kind: "identifier", text: source.slice(start, index) });
      continue;
    }
    tokens.push({ kind: "punctuation", text: char });
    index++;
  }
  return tokens;
};

export const spindleStringLiterals = (code: string): string[] =>
  tokenize(code).filter((token) => token.kind === "string").map((token) => token.text);

const propertyName = (token: Token | undefined): string | undefined =>
  token?.kind === "identifier" || token?.kind === "string" ? token.text : undefined;

const namedStringKey = (tokens: Token[], start: number, end: number): string | undefined => {
  if (tokens[start]?.text !== "π") return undefined;
  if (tokens[start + 1]?.text === "." && tokens[start + 2]?.kind === "identifier" && start + 3 === end) {
    return tokens[start + 2]!.text;
  }
  if (tokens[start + 1]?.text === "[" && tokens[start + 2]?.kind === "string" && tokens[start + 3]?.text === "]" && start + 4 === end) {
    return tokens[start + 2]!.text;
  }
  return undefined;
};

const objectBinding = (tokens: Token[], start: number): { binding?: SpindleWriteBinding; next: number } => {
  let depth = 1;
  let index = start + 1;
  let path: string | undefined;
  let stringKey: string | undefined;
  while (index < tokens.length && depth > 0) {
    if (tokens[index]?.text === "{") { depth++; index++; continue; }
    if (tokens[index]?.text === "}") { depth--; index++; continue; }
    if (depth !== 1) { index++; continue; }
    const name = propertyName(tokens[index]);
    if (!name || tokens[index + 1]?.text !== ":") { index++; continue; }
    const valueStart = index + 2;
    let valueEnd = valueStart;
    let nested = 0;
    while (valueEnd < tokens.length) {
      const text = tokens[valueEnd]!.text;
      if (nested === 0 && (text === "," || text === "}")) break;
      if (text === "(" || text === "[" || text === "{") nested++;
      else if (text === ")" || text === "]" || text === "}") nested--;
      valueEnd++;
    }
    if (["path", "file", "file_path"].includes(name) && valueEnd === valueStart + 1 && tokens[valueStart]?.kind === "string") {
      path = tokens[valueStart]!.text;
    } else if (["content", "text", "contents"].includes(name)) {
      stringKey = namedStringKey(tokens, valueStart, valueEnd);
    }
    index = valueEnd;
  }
  return path !== undefined && stringKey !== undefined
    ? { binding: { path, stringKey }, next: index }
    : { next: index };
};

export const spindleWriteBindings = (code: string): SpindleWriteBinding[] => {
  const tokens = tokenize(code);
  const bindings: SpindleWriteBinding[] = [];
  for (let index = 0; index < tokens.length - 5; index++) {
    if (tokens[index]?.text !== "pi" || tokens[index + 1]?.text !== "." || tokens[index + 2]?.text !== "write" || tokens[index + 3]?.text !== "(" || tokens[index + 4]?.text !== "{") continue;
    const parsed = objectBinding(tokens, index + 4);
    if (parsed.binding) bindings.push(parsed.binding);
    index = parsed.next - 1;
  }
  return bindings;
};
