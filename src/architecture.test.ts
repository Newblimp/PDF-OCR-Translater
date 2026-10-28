/**
 * Rules of the code base that AGENTS.md states in prose, checked here so a
 * change that breaks one fails CI instead of waiting for a reviewer:
 *   - the CSP lets the page talk to exactly the providers' hosts;
 *   - public/theme-init.js reads the settings where storage/settings.ts writes them;
 *   - what is imported on first use (`import()`) stays out of the first download;
 *   - the files and names AGENTS.md refers to exist.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { ANTHROPIC_BASE_URL } from "./lib/anthropic/client";
import { PROVIDER_IDS, PROVIDERS } from "./lib/llm/registry";
import { DEFAULT_BASE_URL as MISTRAL_BASE_URL } from "./lib/mistral/client";
import { DEFAULT_OPENAI_BASE_URL } from "./lib/openai/client";
import { SETTINGS_STORAGE_KEY } from "./lib/storage/settings";

const ROOT = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

/** Every file under `dir` (relative to the root), skipping dependencies and build output. */
function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    if (name === "node_modules" || name === "dist" || name === ".git" || name === "test-results" || name === "playwright-report") continue;
    const path = dir === "." ? name : `${dir}/${name}`;
    if (statSync(join(ROOT, path)).isDirectory()) out.push(`${path}/`, ...files(path));
    else out.push(path);
  }
  return out;
}

describe("privacy model", () => {
  it("the CSP connects to the page itself and the providers' hosts, nothing else", () => {
    const csp = /Content-Security-Policy:\s*(.+)/.exec(read("public/_headers"))?.[1] ?? "";
    const connect = /connect-src ([^;]+)/.exec(csp)?.[1]?.trim().split(/\s+/) ?? [];
    expect([...connect].sort()).toEqual(["'self'", ...PROVIDER_IDS.map((id) => `https://${PROVIDERS[id].host}`)].sort());
  });

  it("each client talks to its provider's host", () => {
    expect(MISTRAL_BASE_URL).toBe(`https://${PROVIDERS.mistral.host}`);
    expect(ANTHROPIC_BASE_URL).toBe(`https://${PROVIDERS.anthropic.host}`);
    expect(DEFAULT_OPENAI_BASE_URL).toBe(`https://${PROVIDERS.openai.host}`);
  });
});

describe("theme before the first paint", () => {
  it("public/theme-init.js reads the settings entry storage/settings.ts writes", () => {
    expect(read("public/theme-init.js")).toContain(`localStorage.getItem(${JSON.stringify(SETTINGS_STORAGE_KEY)})`);
  });
});

// ------------------------------------------------------------ lazy loading

interface ModuleImports {
  /** Imports that load with the module: value imports and re-exports (`import type` and `export type` load nothing). */
  static: string[];
  /** `import("...")`: loaded on first use, a chunk of its own. */
  dynamic: string[];
}

function moduleImports(file: string): ModuleImports {
  const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
  const imports: ModuleImports = { static: [], dynamic: [] };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && !node.importClause?.isTypeOnly) {
      // `import { type A } from "x"` still loads "x" under verbatimModuleSyntax.
      imports.static.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && !node.isTypeOnly) {
      imports.static.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [specifier] = node.arguments;
      if (specifier && ts.isStringLiteral(specifier)) imports.dynamic.push(specifier.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return imports;
}

/** A source file for an import of the app's own code; the package name for anything else; null for assets (CSS). */
function resolveImport(from: string, specifier: string): string | null {
  if (!specifier.startsWith(".") && !specifier.startsWith("@/")) {
    const parts = specifier.split("/");
    return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
  }
  const base = specifier.startsWith("@/") ? join("src", specifier.slice(2)) : join(dirname(from), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (/\.tsx?$/.test(candidate) && existsSync(join(ROOT, candidate))) return relative(ROOT, join(ROOT, candidate));
  }
  if (/\.(css|svg|png|json)$/.test(base)) return null;
  throw new Error(`${from}: cannot resolve "${specifier}"`);
}

/** The modules (files and packages) `entry` loads before anything else runs: its static imports, followed through the app's files. */
function staticClosure(entry: string): Set<string> {
  const seen = new Set<string>([entry]);
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    for (const specifier of moduleImports(file).static) {
      const target = resolveImport(file, specifier);
      if (target === null || seen.has(target)) continue;
      seen.add(target);
      if (target.startsWith("src/")) queue.push(target);
    }
  }
  return seen;
}

describe("first download", () => {
  const appFiles = files("src").filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));
  const lazy = new Map<string, string>(); // module → a file that imports it on first use
  for (const file of appFiles) for (const specifier of moduleImports(file).dynamic) lazy.set(resolveImport(file, specifier) ?? specifier, file);
  const initial = staticClosure("src/main.tsx");

  it("finds the modules imported on first use", () => {
    // Guards the test itself: the parser sees the shell and the lazy parts AGENTS.md names.
    expect(initial).toContain("src/app/store.ts");
    for (const module of [
      "src/lib/pipeline/pipeline.ts",
      "src/lib/mistral/client.ts",
      "src/components/OcrView.tsx",
      "pdfjs-dist",
      "@anthropic-ai/sdk",
      "marked",
    ]) {
      expect(lazy.has(module), module).toBe(true);
    }
  });

  it("keeps every module imported on first use out of the page's first download", () => {
    // A static import of one of them from the shell would put it back into the entry chunk (and make its `import()` pointless).
    const eager = [...lazy].filter(([module]) => initial.has(module)).map(([module, by]) => `${module} (imported on first use by ${by})`);
    expect(eager).toEqual([]);
  });
});

// ----------------------------------------------------------------- the guide

describe("AGENTS.md", () => {
  const guide = read("AGENTS.md");
  const all = files(".");
  const code = all
    .filter((f) => /\.(tsx?|js|json|html)$/.test(f) && f !== "package-lock.json")
    .map(read)
    .join("\n");
  const ignored = read(".gitignore").split("\n").filter(Boolean);
  const quoted = [...guide.matchAll(/`([^`\s]+)`/g)].map((m) => m[1]!);

  it("refers only to files and directories that exist", () => {
    // A file (by its extension), a directory (trailing slash) or a path from the root; not an action type, a package or a URL path.
    const paths = quoted.filter(
      (t) => /^[\w.-][\w./-]*$/.test(t) && !/^\.\w+$/.test(t) && (/\.(tsx?|js|css|json|ya?ml|md)$/.test(t) || t.endsWith("/") || /^(src|e2e|public)\//.test(t)),
    );
    expect(paths.length).toBeGreaterThan(20);
    const missing = paths.filter((p) => !ignored.includes(p) && !all.some((f) => f === p || f.endsWith(`/${p}`)));
    expect(missing).toEqual([]);
  });

  it("refers only to names that exist in the code", () => {
    // `name`, `Type.field`, `call()`: every part is a word of the code (a renamed or removed one is not).
    const names = quoted.filter((t) => /^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*(\(\))?$/.test(t) && !/\.(tsx?|js|css|json|ya?ml|md)$/.test(t));
    expect(names.length).toBeGreaterThan(100);
    const missing = names.filter((n) =>
      n
        .replace(/\(\)$/, "")
        .split(".")
        .some((part) => !new RegExp(`\\b${part}\\b`).test(code)),
    );
    expect(missing).toEqual([]);
  });
});
