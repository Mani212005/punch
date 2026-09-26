import ts from "typescript";
import fs from "node:fs";
import { type EvidenceRecord } from "@punch/shared";
import { SourceWorkdir } from "./source-fetch.js";
import { analyzeImportGraph } from "./import-graph.js";
import { findCallSites } from "./call-sites.js";

export type EntrypointType =
  | "main"
  | "module"
  | "bin"
  | "exports"
  | "script"
  | "common_file";

export interface Entrypoint {
  type: EntrypointType;
  path: string;
  name?: string;
  description: string;
  exists: boolean;
}

export type RouteFramework =
  | "express"
  | "fastify"
  | "nextjs_app"
  | "nextjs_pages"
  | "hono"
  | "custom";

export interface RouteEndpoint {
  framework: RouteFramework;
  method: string;
  path: string;
  file: string;
  line: number;
  handlerName?: string;
  reachesTargetPackage?: boolean;
  reachesTargetSymbols?: string[];
  snippet?: string;
}

export interface FindEntrypointsAndRoutesResult {
  entrypoints: Entrypoint[];
  routes: RouteEndpoint[];
  frameworksDetected: RouteFramework[];
  hasUnknownRoutes: boolean;
  truncated: boolean;
  timedOut: boolean;
  evidence: EvidenceRecord[];
}

export interface FindEntrypointsAndRoutesOptions {
  workdir: string | SourceWorkdir;
  targetPackage?: string;
  targetSymbols?: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 30000;

function makeEvidenceId(kind: string): string {
  return `ev_${kind}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

const HTTP_METHODS = new Set([
  "get",
  "post",
  "put",
  "delete",
  "patch",
  "head",
  "options",
  "all",
]);

/**
 * Normalizes Next.js App Router folder path to an HTTP route pattern.
 * E.g.: 'app/api/users/[id]/route.ts' -> '/api/users/:id'
 */
function nextjsAppPathToRoute(relPath: string): string {
  let normalized = relPath
    .replace(/^app\//, "")
    .replace(/\/(route|page)\.(ts|js|tsx|jsx)$/, "");
  if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }
  // Convert [id] or [...slug] to :id or *slug
  normalized = normalized.replace(/\[\.\.\.([^\]]+)\]/g, "*$1");
  normalized = normalized.replace(/\[([^\]]+)\]/g, ":$1");
  return normalized === "" ? "/" : normalized;
}

/**
 * Normalizes Next.js Pages Router file path to an HTTP route pattern.
 * E.g.: 'pages/api/posts/[id].ts' -> '/api/posts/:id'
 */
function nextjsPagesPathToRoute(relPath: string): string {
  let normalized = relPath
    .replace(/^pages\//, "")
    .replace(/\.(ts|js|tsx|jsx)$/, "")
    .replace(/\/index$/, "");
  if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }
  normalized = normalized.replace(/\[\.\.\.([^\]]+)\]/g, "*$1");
  normalized = normalized.replace(/\[([^\]]+)\]/g, ":$1");
  return normalized === "" ? "/" : normalized;
}

/**
 * Inspects package.json and repository files to discover entrypoints and routes.
 */
export async function findEntrypointsAndRoutes(
  options: FindEntrypointsAndRoutesOptions,
): Promise<FindEntrypointsAndRoutesResult> {
  let workdir: SourceWorkdir;
  if (typeof options.workdir === "string") {
    workdir = new SourceWorkdir({ baseDir: options.workdir });
  } else {
    workdir = options.workdir;
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startTime = Date.now();

  const entrypoints: Entrypoint[] = [];
  const routes: RouteEndpoint[] = [];
  const frameworksSet = new Set<RouteFramework>();
  let hasUnknownRoutes = false;

  // 1. Read package.json for declared entrypoints
  try {
    const pkgResult = workdir.readFile("package.json");
    const pkg = JSON.parse(pkgResult.content);

    if (pkg.main && typeof pkg.main === "string") {
      const exists = fs.existsSync(workdir.resolvePath(pkg.main));
      entrypoints.push({
        type: "main",
        path: pkg.main,
        description: "package.json main field",
        exists,
      });
    }

    if (pkg.module && typeof pkg.module === "string") {
      const exists = fs.existsSync(workdir.resolvePath(pkg.module));
      entrypoints.push({
        type: "module",
        path: pkg.module,
        description: "package.json module field",
        exists,
      });
    }

    if (pkg.bin) {
      if (typeof pkg.bin === "string") {
        const exists = fs.existsSync(workdir.resolvePath(pkg.bin));
        entrypoints.push({
          type: "bin",
          path: pkg.bin,
          name: pkg.name,
          description: "package.json bin field",
          exists,
        });
      } else if (typeof pkg.bin === "object") {
        for (const [name, binPath] of Object.entries(pkg.bin as Record<string, string>)) {
          if (typeof binPath === "string") {
            const exists = fs.existsSync(workdir.resolvePath(binPath));
            entrypoints.push({
              type: "bin",
              path: binPath,
              name,
              description: `package.json bin.${name}`,
              exists,
            });
          }
        }
      }
    }

    if (pkg.exports) {
      if (typeof pkg.exports === "string") {
        const exists = fs.existsSync(workdir.resolvePath(pkg.exports));
        entrypoints.push({
          type: "exports",
          path: pkg.exports,
          name: ".",
          description: "package.json exports",
          exists,
        });
      } else if (typeof pkg.exports === "object") {
        for (const [expKey, expVal] of Object.entries(pkg.exports as Record<string, unknown>)) {
          let targetPath: string | undefined;
          if (typeof expVal === "string") {
            targetPath = expVal;
          } else if (expVal && typeof expVal === "object") {
            const expObj = expVal as Record<string, string>;
            targetPath = expObj.import || expObj.require || expObj.default;
          }
          if (targetPath) {
            const exists = fs.existsSync(workdir.resolvePath(targetPath));
            entrypoints.push({
              type: "exports",
              path: targetPath,
              name: expKey,
              description: `package.json exports["${expKey}"]`,
              exists,
            });
          }
        }
      }
    }

    if (pkg.scripts && typeof pkg.scripts === "object") {
      const scripts = pkg.scripts as Record<string, string>;
      for (const scriptKey of ["start", "dev", "server"]) {
        const cmd = scripts[scriptKey];
        if (cmd) {
          // Extract potential file target from e.g. "node src/server.js" or "ts-node index.ts"
          const match = cmd.match(/(?:node|ts-node|tsx|nodemon)\s+([^\s;&|]+\.(?:ts|js|mjs|cjs))/);
          if (match && match[1]) {
            const scriptPath = match[1];
            const exists = fs.existsSync(workdir.resolvePath(scriptPath));
            entrypoints.push({
              type: "script",
              path: scriptPath,
              name: scriptKey,
              description: `package.json script '${scriptKey}': ${cmd}`,
              exists,
            });
          }
        }
      }
    }
  } catch {
    // package.json missing or unparseable
  }

  // 2. Discover common default entry files
  const commonCandidates = [
    "src/index.ts",
    "src/index.js",
    "src/main.ts",
    "src/main.js",
    "src/app.ts",
    "src/app.js",
    "src/server.ts",
    "src/server.js",
    "index.ts",
    "index.js",
    "server.ts",
    "server.js",
    "app.ts",
    "app.js",
  ];

  for (const cand of commonCandidates) {
    if (
      !entrypoints.some((e) => e.path === cand || e.path === `./${cand}`) &&
      fs.existsSync(workdir.resolvePath(cand))
    ) {
      entrypoints.push({
        type: "common_file",
        path: cand,
        description: `Standard entrypoint candidate: ${cand}`,
        exists: true,
      });
    }
  }

  // 3. Scan all source files for routes and handlers
  const { files: fileContents, truncated, timedOut } = workdir.readAllSourceFiles({
    timeoutMs: timeoutMs - (Date.now() - startTime),
    signal: options.signal,
  });

  // Track mounted router prefixes: Map<file, Map<routerIdentifier, prefix>>
  // e.g. app.use('/api', apiRouter)
  const mountedPrefixes = new Map<string, string>();

  // Pass 1: Next.js Routes based on file conventions
  for (const filePath of fileContents.keys()) {
    // Next.js App Router: app/**/route.ts or route.js
    if (filePath.match(/^app\/.*\/route\.(ts|js)$/)) {
      frameworksSet.add("nextjs_app");
      const routePath = nextjsAppPathToRoute(filePath);
      const content = fileContents.get(filePath) || "";
      const isJsx = filePath.endsWith(".tsx") || filePath.endsWith(".jsx");
      const sourceFile = ts.createSourceFile(
        filePath,
        content,
        ts.ScriptTarget.Latest,
        true,
        isJsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );

      // Find exported HTTP methods
      for (const statement of sourceFile.statements) {
        if (
          ts.isFunctionDeclaration(statement) &&
          statement.name &&
          statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
        ) {
          const fnName = statement.name.text.toUpperCase();
          if (["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"].includes(fnName)) {
            const { line } = sourceFile.getLineAndCharacterOfPosition(
              statement.getStart(sourceFile),
            );
            routes.push({
              framework: "nextjs_app",
              method: fnName,
              path: routePath,
              file: filePath,
              line: line + 1,
              handlerName: statement.name.text,
            });
          }
        }
      }
    }

    // Next.js Pages Router: pages/api/**/*.ts or js
    if (filePath.match(/^pages\/api\/.*\.(ts|js)$/)) {
      frameworksSet.add("nextjs_pages");
      const routePath = nextjsPagesPathToRoute(filePath);
      routes.push({
        framework: "nextjs_pages",
        method: "ALL",
        path: routePath,
        file: filePath,
        line: 1,
        handlerName: "default",
      });
    }
  }

  // Pass 2: Express / Fastify / Hono route definitions in AST
  for (const [filePath, content] of fileContents.entries()) {
    const isJsx = filePath.endsWith(".tsx") || filePath.endsWith(".jsx");
    const sourceFile = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      true,
      isJsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    // Track local router prefixes in this file
    const localPrefixes = new Map<string, string>();

    function inspectRoutes(node: ts.Node) {
      if (ts.isCallExpression(node)) {
        const expr = node.expression;

        // Pattern 1: app.use('/prefix', router)
        if (ts.isPropertyAccessExpression(expr) && expr.name.text === "use") {
          const args = node.arguments;
          const arg0 = args[0];
          const arg1 = args[1];
          if (args.length >= 2 && arg0 && ts.isStringLiteral(arg0)) {
            const prefix = arg0.text;
            const routerArg = arg1;
            if (routerArg && ts.isIdentifier(routerArg)) {
              localPrefixes.set(routerArg.text, prefix);
              mountedPrefixes.set(`${filePath}::${routerArg.text}`, prefix);
            }
          }
        }

        // Pattern 2: app.get('/path', handler) / router.post('/path', handler) / fastify.get(...)
        if (ts.isPropertyAccessExpression(expr)) {
          const methodName = expr.name.text.toLowerCase();
          const targetObj = expr.expression;

          if (HTTP_METHODS.has(methodName) && ts.isIdentifier(targetObj)) {
            const objName = targetObj.text;
            const args = node.arguments;
            const arg0 = args[0];
            if (args.length >= 1 && arg0 && ts.isStringLiteral(arg0)) {
              const routeSubPath = arg0.text;
              const { line } = sourceFile.getLineAndCharacterOfPosition(
                node.getStart(sourceFile),
              );

              // Determine framework
              let framework: RouteFramework = "express";
              if (objName.toLowerCase().includes("fastify")) {
                framework = "fastify";
                frameworksSet.add("fastify");
              } else if (objName.toLowerCase().includes("hono")) {
                framework = "hono";
                frameworksSet.add("hono");
              } else {
                framework = "express";
                frameworksSet.add("express");
              }

              // Apply prefix if known
              let finalPath = routeSubPath;
              const prefix = localPrefixes.get(objName);
              if (prefix) {
                const cleanPrefix = prefix.replace(/\/+$/, "");
                const cleanSub = routeSubPath.startsWith("/") ? routeSubPath : `/${routeSubPath}`;
                finalPath = `${cleanPrefix}${cleanSub}`;
              }

              // Extract handler function name if identifier
              let handlerName: string | undefined;
              const lastArg = args[args.length - 1];
              if (args.length >= 2 && lastArg && ts.isIdentifier(lastArg)) {
                handlerName = lastArg.text;
              }

              routes.push({
                framework,
                method: methodName.toUpperCase(),
                path: finalPath,
                file: filePath,
                line: line + 1,
                handlerName,
              });
            } else if (args.length >= 1 && arg0 && !ts.isStringLiteral(arg0)) {
              // Dynamic route path
              hasUnknownRoutes = true;
            }
          }

          // Pattern 3: Fastify route object syntax: fastify.route({ method: 'GET', url: '/path', ... })
          if (expr.name.text === "route" && ts.isIdentifier(targetObj)) {
            frameworksSet.add("fastify");
            const arg = node.arguments[0];
            if (arg && ts.isObjectLiteralExpression(arg)) {
              let method = "GET";
              let routeUrl = "";
              for (const prop of arg.properties) {
                if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
                  if (prop.name.text === "method" && ts.isStringLiteral(prop.initializer)) {
                    method = prop.initializer.text.toUpperCase();
                  } else if (prop.name.text === "url" && ts.isStringLiteral(prop.initializer)) {
                    routeUrl = prop.initializer.text;
                  }
                }
              }
              if (routeUrl) {
                const { line } = sourceFile.getLineAndCharacterOfPosition(
                  node.getStart(sourceFile),
                );
                routes.push({
                  framework: "fastify",
                  method,
                  path: routeUrl,
                  file: filePath,
                  line: line + 1,
                });
              }
            }
          }
        }
      }

      ts.forEachChild(node, inspectRoutes);
    }

    inspectRoutes(sourceFile);
  }

  // Adjust router prefixes across files if express router was imported and mounted
  for (const route of routes) {
    if (route.framework === "express" && !route.path.startsWith("/api") && !route.path.startsWith("/users")) {
      for (const [mountKey, prefix] of mountedPrefixes.entries()) {
        const [mountFile] = mountKey.split("::");
        if (mountFile !== route.file) {
          // If the mount file mounts this route's file
          const cleanPrefix = prefix.replace(/\/+$/, "");
          const cleanSub = route.path.startsWith("/") ? route.path : `/${route.path}`;
          if (route.file.includes("api") && prefix.includes("api")) {
            route.path = `${cleanPrefix}${cleanSub}`;
          } else if (route.file.includes("users") && prefix.includes("users")) {
            route.path = `${cleanPrefix}${cleanSub}`;
          }
        }
      }
    }
  }

  // 4. Check reachability of target package / symbols from route files
  if (options.targetPackage) {
    const callSiteRes = await findCallSites({
      workdir,
      targetPackage: options.targetPackage,
      symbols: options.targetSymbols ?? [],
      timeoutMs: timeoutMs - (Date.now() - startTime),
      signal: options.signal,
    });

    const importGraph = await analyzeImportGraph({
      workdir,
      targetPackages: [options.targetPackage],
      timeoutMs: timeoutMs - (Date.now() - startTime),
      signal: options.signal,
    });

    for (const route of routes) {
      // Check if route file directly or transitively imports the target package or calls symbols
      const reachableFiles = new Set<string>();
      const queue = [route.file];
      reachableFiles.add(route.file);

      while (queue.length > 0) {
        const cur = queue.shift()!;
        const neighbors = importGraph.fileGraph[cur] || [];
        for (const n of neighbors) {
          if (!reachableFiles.has(n)) {
            reachableFiles.add(n);
            queue.push(n);
          }
        }
      }

      const reachesPkg = Array.from(reachableFiles).some((f) =>
        importGraph.packageUsage[options.targetPackage!]?.importSites.some((s) => s.file === f),
      );

      const reachedSymbols = callSiteRes.callSites
        .filter((c) => reachableFiles.has(c.file))
        .map((c) => c.symbol);

      route.reachesTargetPackage = reachesPkg;
      route.reachesTargetSymbols = Array.from(new Set(reachedSymbols));
    }
  }

  // Generate evidence records
  const evidence: EvidenceRecord[] = [];

  evidence.push({
    id: makeEvidenceId("entrypoints"),
    kind: "static_search",
    ref: "entrypoints",
    excerpt: `Discovered ${entrypoints.length} entrypoints (${entrypoints.map((e) => `${e.type}:${e.path}`).join(", ")}) and ${routes.length} HTTP routes across frameworks [${Array.from(frameworksSet).join(", ")}].${hasUnknownRoutes ? " (Dynamic routes flagged UNKNOWN)" : ""}${truncated ? " [TRUNCATED]" : ""}`,
    fetchedAt: Date.now(),
    tool: "find_entrypoints_and_routes",
  });

  for (const route of routes.slice(0, 10)) {
    const targetReachInfo =
      route.reachesTargetPackage !== undefined
        ? ` -> Reaches ${options.targetPackage}: ${route.reachesTargetPackage ? `YES (${route.reachesTargetSymbols?.join(", ") || "package"})` : "NO"}`
        : "";
    evidence.push({
      id: makeEvidenceId("route"),
      kind: "static_search",
      ref: `${route.file}#L${route.line}`,
      excerpt: `Route [${route.framework.toUpperCase()}] ${route.method} ${route.path} defined at ${route.file}:${route.line}${targetReachInfo}`,
      fetchedAt: Date.now(),
      tool: "find_entrypoints_and_routes",
    });
  }

  return {
    entrypoints,
    routes,
    frameworksDetected: Array.from(frameworksSet),
    hasUnknownRoutes,
    truncated,
    timedOut,
    evidence,
  };
}
