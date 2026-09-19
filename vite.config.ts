import { defineConfig, type Plugin } from "vite";
import preact from "@preact/preset-vite";
import { fileURLToPath, URL } from "node:url";
import { createRequire } from "node:module";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

const require = createRequire(import.meta.url);

/**
 * pdf.js needs a few auxiliary files at runtime (CMaps for CJK fonts,
 * standard fonts, WASM image decoders). They are fetched on demand, so we
 * serve them under /pdfjs/ instead of bundling them. Only used for the
 * in-browser preview; nothing here touches the network beyond our own origin.
 */
function pdfjsAssets(): Plugin {
  const pdfjsRoot = dirname(require.resolve("pdfjs-dist/package.json"));
  const dirs = ["cmaps", "standard_fonts", "wasm"] as const;
  const mime: Record<string, string> = {
    ".wasm": "application/wasm",
    ".bcmap": "application/octet-stream",
    ".pfb": "application/octet-stream",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
  };
  return {
    name: "pdfjs-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split("?")[0] ?? "";
        const match = /^\/pdfjs\/(cmaps|standard_fonts|wasm)\/([^/]+)$/.exec(url);
        if (!match) return next();
        const file = join(pdfjsRoot, match[1]!, match[2]!);
        if (!existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader("Content-Type", mime[extname(file)] ?? "application/octet-stream");
        res.end(readFileSync(file));
      });
    },
    generateBundle() {
      for (const dir of dirs) {
        const abs = join(pdfjsRoot, dir);
        if (!existsSync(abs)) continue;
        for (const name of readdirSync(abs)) {
          const file = join(abs, name);
          if (!statSync(file).isFile()) continue;
          this.emitFile({ type: "asset", fileName: `pdfjs/${dir}/${name}`, source: readFileSync(file) });
        }
      }
    },
  };
}

/**
 * Applies the Cloudflare Pages `public/_headers` rules (Content-Security-Policy
 * and friends) to the dev and preview servers, so local runs behave like the
 * deployed site and CSP problems surface before deployment.
 */
function cloudflareHeaders(): Plugin {
  const file = fileURLToPath(new URL("./public/_headers", import.meta.url));
  const rules = parseHeadersFile(readFileSync(file, "utf8"));
  const middleware = (dev: boolean) => (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const path = req.url?.split("?")[0] ?? "/";
    for (const rule of rules) {
      if (!rule.pattern.test(path)) continue;
      for (const [name, value] of Object.entries(rule.headers)) {
        if (dev && name.toLowerCase() === "cache-control") continue; // never cache in dev
        res.setHeader(name, value);
      }
    }
    next();
  };
  return {
    name: "cloudflare-headers",
    configureServer(server) {
      server.middlewares.use(middleware(true));
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware(false));
    },
  };
}

function parseHeadersFile(text: string): Array<{ pattern: RegExp; headers: Record<string, string> }> {
  const rules: Array<{ pattern: RegExp; headers: Record<string, string> }> = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    if (!/^\s/.test(raw)) {
      const glob = raw.trim();
      const source = "^" + glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/:[A-Za-z_]+/g, "[^/]+") + "$";
      rules.push({ pattern: new RegExp(source), headers: {} });
      continue;
    }
    const rule = rules.at(-1);
    const colon = raw.indexOf(":");
    if (!rule || colon === -1) continue;
    rule.headers[raw.slice(0, colon).trim()] = raw.slice(colon + 1).trim();
  }
  return rules;
}

// Static single-page app. There is deliberately no server code: the
// document is only ever sent from the browser to api.mistral.ai.
export default defineConfig({
  plugins: [preact(), pdfjsAssets(), cloudflareHeaders()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    target: "es2022",
    sourcemap: false,
    // pdf.js and the Markdown renderer are imported lazily, so the bundler
    // already emits them as separate chunks loaded on demand.
  },
});
