/**
 * Tolerant JSON parser for streamed output: parses as much of a truncated
 * JSON document as possible, closing unfinished strings, arrays and objects.
 * Used to render the translation while it is still being generated.
 *
 * Returns `undefined` when nothing parsable has arrived yet.
 */
export function parsePartialJson(text: string): unknown {
  const src = text.replace(/^\s*```(?:json)?\s*/i, "");
  let i = 0;
  const n = src.length;

  const ws = () => {
    while (i < n && /\s/.test(src[i]!)) i++;
  };

  function value(): unknown {
    for (;;) {
      ws();
      if (i >= n) return undefined;
      const c = src[i]!;
      if (c === "{") return object();
      if (c === "[") return array();
      if (c === '"') return string();
      if (c === "t" || c === "f" || c === "n") {
        const lit = literal();
        if (lit !== undefined || i >= n) return lit;
        continue; // a word that merely started like a literal (prose): keep skipping
      }
      if (c === "-" || (c >= "0" && c <= "9")) return number();
      // Unexpected character (e.g. prose before the JSON): skip it (iteratively, never recursively).
      i++;
    }
  }

  /** At the top level, prose such as "Here is the JSON: {...}" is skipped until an object or array starts. */
  function topLevel(): unknown {
    const firstStructural = src.search(/[{[]/);
    if (firstStructural > 0) i = firstStructural;
    return value();
  }

  function object(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    i++; // {
    for (;;) {
      ws();
      if (i >= n) return out;
      if (src[i] === "}") {
        i++;
        return out;
      }
      if (src[i] === ",") {
        i++;
        continue;
      }
      if (src[i] !== '"') {
        i++;
        continue;
      }
      const keyStart = i;
      const key = string();
      ws();
      if (i >= n) return out; // key without value yet: drop it
      if (src[i] !== ":") {
        // Malformed; skip.
        i = keyStart + 1;
        continue;
      }
      i++; // :
      ws();
      if (i >= n) return out;
      const v = value();
      if (v !== undefined) out[key] = v;
    }
  }

  function array(): unknown[] {
    const out: unknown[] = [];
    i++; // [
    for (;;) {
      ws();
      if (i >= n) return out;
      if (src[i] === "]") {
        i++;
        return out;
      }
      if (src[i] === ",") {
        i++;
        continue;
      }
      const v = value();
      if (v === undefined) return out;
      out.push(v);
    }
  }

  function string(): string {
    i++; // opening quote
    let out = "";
    while (i < n) {
      const c = src[i]!;
      if (c === '"') {
        i++;
        return out;
      }
      if (c === "\\") {
        const e = src[i + 1];
        if (e === undefined) return out; // truncated inside an escape
        i += 2;
        switch (e) {
          case "n":
            out += "\n";
            break;
          case "t":
            out += "\t";
            break;
          case "r":
            out += "\r";
            break;
          case "b":
            out += "\b";
            break;
          case "f":
            out += "\f";
            break;
          case "u": {
            const hex = src.slice(i, i + 4);
            if (hex.length < 4) return out;
            out += String.fromCharCode(parseInt(hex, 16) || 0xfffd);
            i += 4;
            break;
          }
          default:
            out += e;
        }
        continue;
      }
      out += c;
      i++;
    }
    return out; // unterminated string: return what we have
  }

  function literal(): unknown {
    const rest = src.slice(i, i + 5);
    if (rest.startsWith("true")) {
      i += 4;
      return true;
    }
    if (rest.startsWith("false")) {
      i += 5;
      return false;
    }
    if (rest.startsWith("null")) {
      i += 4;
      return null;
    }
    // Either a truncated literal at the very end ("tr", "nu") or prose that starts with t/f/n.
    if (i + 5 >= n && ("true".startsWith(rest) || "false".startsWith(rest) || "null".startsWith(rest))) {
      i = n;
      return undefined;
    }
    i++;
    return undefined;
  }

  function number(): unknown {
    const m = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(src.slice(i));
    if (!m) {
      i++;
      return undefined;
    }
    i += m[0].length;
    if (i >= n) return Number(m[0]); // may still grow; best effort
    return Number(m[0]);
  }

  return topLevel();
}
