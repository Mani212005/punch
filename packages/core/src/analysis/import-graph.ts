import ts from "typescript";
import path from "node:path";
import { type EvidenceRecord } from "@punch/shared";
import { SourceWorkdir } from "./source-fetch.js";

export interface ImportSite {
  file: string;
  line: number;
  column: number;
  specifier: string;
  isRelative: boolean;
  packageName?: string;
  importedSymbols: string[];
  importType:
    | "esm_default"
    | "esm_named"
    | "esm_namespace"
    | "esm_side_effect"
    | "esm_dynamic"
    | "cjs_require"
    | "cjs_destructure"
    | "cjs_property"
    | "reexport_named"
    | "reexport_all"
    | "reexport_namespace";
  isDynamic: boolean;
  resolvedFilePath?: string;
}

export interface DynamicImportSite {
  file: string;
  line: number;
  column: number;
  rawExpression: string;
  reason: string;
}

export interface ReExportRecord {
  file: string;
  line: number;
  exportedSymbol: string;
  sourceSpecifier: string;
  sourceSymbol: string;
  isExternal: boolean;
  packageName?: string;
  resolvedFilePath?: string;
}

export interface ImportGraphResult {
  importedPackages: string[];
  packageUsage: Record<
    string,
    {
      used: boolean;
      importCount: number;
      importSites: ImportSite[];
      importedSymbols: string[];
    }
  >;
  fileGraph: Record<string, string[]>; // file -> relative imported files
  reverseFileGraph: Record<string, string[]>; // file -> files that import it
  reExports: ReExportRecord[];
  dynamicImports: DynamicImportSite[];
  hasUnknowns: boolean;
  filesAnalyzed: number;
  truncated: boolean;
  timedOut: boolean;
  evidence: EvidenceRecord[];
}

export interface AnalyzeImportGraphOptions {
  workdir: string | SourceWorkdir;
  targetPackages?: string[];
  maxFiles?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function makeEvidenceId(kind: string): string {
  return `ev_${kind}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Extracts the root package name from an import specifier.
 * E.g.:
 *  'lodash/get' -> 'lodash'
 *  '@punch/shared/trace.js' -> '@punch/shared'
 *  'express' -> 'express'
 *  './utils' -> undefined
 */
export function extractPackageName(specifier: string): string | undefined {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("\\")) {
    return undefined;
  }
  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    if (parts.length >= 2) {
      return `${parts[0]}/${parts[1]}`;
    }
    return specifier;
  }
  const parts = specifier.split("/");
  return parts[0];
}

/**
 * Attempts to resolve a relative module specifier to an actual file in the files map.
 */
export function resolveRelativeSpecifier(
  currentFile: string,
  specifier: string,
  availableFiles: Set<string>,
): string | undefined {
  const currentDir = path.dirname(currentFile);
  const target = path.join(currentDir, specifier).replace(/\\/g, "/");

  // Direct match
  if (availableFiles.has(target)) return target;

  // Extensions to try
  const extensions = [
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".json",
    "/index.ts",
    "/index.tsx",
    "/index.js",
    "/index.jsx",
    "/index.mjs",
    "/index.cjs",
  ];

  // Try stripping .js/.mjs if looking for .ts
  const stripped = target.replace(/\.(js|jsx|mjs|cjs)$/, "");
  if (stripped !== target) {
    for (const ext of extensions) {
      const candidate = `${stripped}${ext}`;
      if (availableFiles.has(candidate)) return candidate;
    }
  }

  for (const ext of extensions) {
    const candidate = `${target}${ext}`;
    if (availableFiles.has(candidate)) return candidate;
  }

  return undefined;
}

/**
 * Parses AST of a source file using TypeScript compiler API and extracts imports, requires, re-exports.
 */
function extractImportsFromFile(
  filePath: string,
  content: string,
  availableFiles: Set<string>,
): {
  importSites: ImportSite[];
  reExports: ReExportRecord[];
  dynamicImports: DynamicImportSite[];
} {
  const importSites: ImportSite[] = [];
  const reExports: ReExportRecord[] = [];
  const dynamicImports: DynamicImportSite[] = [];

  const isJsx = filePath.endsWith(".tsx") || filePath.endsWith(".jsx");
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    isJsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  // Track local imports for re-exporting local identifiers
  const localImportedSymbols = new Map<
    string,
    { specifier: string; originalSymbol: string; packageName?: string }
  >();

  function getLineCol(node: ts.Node) {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    return { line: line + 1, column: character + 1 };
  }

  function visit(node: ts.Node) {
    // 1. ESM ImportDeclaration: import ... from 'specifier'
    if (ts.isImportDeclaration(node)) {
      const moduleSpecifier = node.moduleSpecifier;
      if (ts.isStringLiteral(moduleSpecifier)) {
        const specifier = moduleSpecifier.text;
        const packageName = extractPackageName(specifier);
        const isRelative = !packageName;
        const resolved = isRelative
          ? resolveRelativeSpecifier(filePath, specifier, availableFiles)
          : undefined;
        const { line, column } = getLineCol(node);

        const clause = node.importClause;
        if (!clause) {
          // import 'specifier';
          importSites.push({
            file: filePath,
            line,
            column,
            specifier,
            isRelative,
            packageName,
            importedSymbols: ["*"],
            importType: "esm_side_effect",
            isDynamic: false,
            resolvedFilePath: resolved,
          });
        } else {
          const importedSymbols: string[] = [];
          let importType: ImportSite["importType"] = "esm_named";

          // Default import: import foo from 'spec'
          if (clause.name) {
            importedSymbols.push("default");
            importType = "esm_default";
            localImportedSymbols.set(clause.name.text, {
              specifier,
              originalSymbol: "default",
              packageName,
            });
          }

          // Named or Namespace imports
          if (clause.namedBindings) {
            if (ts.isNamespaceImport(clause.namedBindings)) {
              importedSymbols.push("*");
              importType = "esm_namespace";
              localImportedSymbols.set(clause.namedBindings.name.text, {
                specifier,
                originalSymbol: "*",
                packageName,
              });
            } else if (ts.isNamedImports(clause.namedBindings)) {
              importType = "esm_named";
              for (const elem of clause.namedBindings.elements) {
                const importedName = elem.propertyName ? elem.propertyName.text : elem.name.text;
                importedSymbols.push(importedName);
                localImportedSymbols.set(elem.name.text, {
                  specifier,
                  originalSymbol: importedName,
                  packageName,
                });
              }
            }
          }

          importSites.push({
            file: filePath,
            line,
            column,
            specifier,
            isRelative,
            packageName,
            importedSymbols,
            importType,
            isDynamic: false,
            resolvedFilePath: resolved,
          });
        }
      }
    }

    // 2. ESM ExportDeclaration with module specifier: export ... from 'specifier'
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      if (ts.isStringLiteral(node.moduleSpecifier)) {
        const specifier = node.moduleSpecifier.text;
        const packageName = extractPackageName(specifier);
        const isRelative = !packageName;
        const resolved = isRelative
          ? resolveRelativeSpecifier(filePath, specifier, availableFiles)
          : undefined;
        const { line, column } = getLineCol(node);

        if (node.exportClause) {
          if (ts.isNamedExports(node.exportClause)) {
            for (const elem of node.exportClause.elements) {
              const sourceSymbol = elem.propertyName ? elem.propertyName.text : elem.name.text;
              const exportedSymbol = elem.name.text;

              reExports.push({
                file: filePath,
                line,
                exportedSymbol,
                sourceSpecifier: specifier,
                sourceSymbol,
                isExternal: !isRelative,
                packageName,
                resolvedFilePath: resolved,
              });

              importSites.push({
                file: filePath,
                line,
                column,
                specifier,
                isRelative,
                packageName,
                importedSymbols: [sourceSymbol],
                importType: "reexport_named",
                isDynamic: false,
                resolvedFilePath: resolved,
              });
            }
          } else if (ts.isNamespaceExport(node.exportClause)) {
            const exportedSymbol = node.exportClause.name.text;
            reExports.push({
              file: filePath,
              line,
              exportedSymbol,
              sourceSpecifier: specifier,
              sourceSymbol: "*",
              isExternal: !isRelative,
              packageName,
              resolvedFilePath: resolved,
            });

            importSites.push({
              file: filePath,
              line,
              column,
              specifier,
              isRelative,
              packageName,
              importedSymbols: ["*"],
              importType: "reexport_namespace",
              isDynamic: false,
              resolvedFilePath: resolved,
            });
          }
        } else {
          // export * from 'specifier'
          reExports.push({
            file: filePath,
            line,
            exportedSymbol: "*",
            sourceSpecifier: specifier,
            sourceSymbol: "*",
            isExternal: !isRelative,
            packageName,
            resolvedFilePath: resolved,
          });

          importSites.push({
            file: filePath,
            line,
            column,
            specifier,
            isRelative,
            packageName,
            importedSymbols: ["*"],
            importType: "reexport_all",
            isDynamic: false,
            resolvedFilePath: resolved,
          });
        }
      }
    }

    // 3. Exporting locally imported identifier: export { parse }
    if (ts.isExportDeclaration(node) && !node.moduleSpecifier && node.exportClause) {
      if (ts.isNamedExports(node.exportClause)) {
        const { line } = getLineCol(node);
        for (const elem of node.exportClause.elements) {
          const localName = elem.propertyName ? elem.propertyName.text : elem.name.text;
          const exportedSymbol = elem.name.text;
          const mapped = localImportedSymbols.get(localName);
          if (mapped) {
            const isRelative = !mapped.packageName;
            const resolved = isRelative
              ? resolveRelativeSpecifier(filePath, mapped.specifier, availableFiles)
              : undefined;

            reExports.push({
              file: filePath,
              line,
              exportedSymbol,
              sourceSpecifier: mapped.specifier,
              sourceSymbol: mapped.originalSymbol,
              isExternal: !isRelative,
              packageName: mapped.packageName,
              resolvedFilePath: resolved,
            });
          }
        }
      }
    }

    // 4. CommonJS require(...) and ESM Dynamic import(...)
    if (ts.isCallExpression(node)) {
      const expr = node.expression;

      // require('specifier')
      if (ts.isIdentifier(expr) && expr.text === "require") {
        const arg = node.arguments[0];
        const { line, column } = getLineCol(node);

        if (arg && ts.isStringLiteral(arg)) {
          const specifier = arg.text;
          const packageName = extractPackageName(specifier);
          const isRelative = !packageName;
          const resolved = isRelative
            ? resolveRelativeSpecifier(filePath, specifier, availableFiles)
            : undefined;

          // Check if parent is variable declaration destructure: const { a, b } = require('...')
          let importedSymbols = ["*"];
          let importType: ImportSite["importType"] = "cjs_require";

          if (ts.isVariableDeclaration(node.parent)) {
            const nameNode = node.parent.name;
            if (ts.isObjectBindingPattern(nameNode)) {
              importType = "cjs_destructure";
              importedSymbols = nameNode.elements.map((el) => {
                return el.propertyName
                  ? (el.propertyName as ts.Identifier).text
                  : (el.name as ts.Identifier).text;
              });
            } else if (ts.isIdentifier(nameNode)) {
              importType = "cjs_require";
              importedSymbols = ["default", "*"];
            }
          } else if (ts.isPropertyAccessExpression(node.parent)) {
            // const p = require('...').parse
            importType = "cjs_property";
            importedSymbols = [node.parent.name.text];
          }

          importSites.push({
            file: filePath,
            line,
            column,
            specifier,
            isRelative,
            packageName,
            importedSymbols,
            importType,
            isDynamic: false,
            resolvedFilePath: resolved,
          });
        } else if (arg) {
          // Dynamic require: require(variableName)
          const rawText = arg.getText(sourceFile);
          dynamicImports.push({
            file: filePath,
            line,
            column,
            rawExpression: `require(${rawText})`,
            reason: `Dynamic require expression with non-literal argument: require(${rawText})`,
          });
        }
      }

      // import('specifier') dynamic import
      if (
        expr.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(expr) && expr.text === "import")
      ) {
        const arg = node.arguments[0];
        const { line, column } = getLineCol(node);

        if (arg && ts.isStringLiteral(arg)) {
          const specifier = arg.text;
          const packageName = extractPackageName(specifier);
          const isRelative = !packageName;
          const resolved = isRelative
            ? resolveRelativeSpecifier(filePath, specifier, availableFiles)
            : undefined;

          importSites.push({
            file: filePath,
            line,
            column,
            specifier,
            isRelative,
            packageName,
            importedSymbols: ["*"],
            importType: "esm_dynamic",
            isDynamic: true,
            resolvedFilePath: resolved,
          });
        } else if (arg) {
          const rawText = arg.getText(sourceFile);
          dynamicImports.push({
            file: filePath,
            line,
            column,
            rawExpression: `import(${rawText})`,
            reason: `Dynamic import expression with non-literal argument: import(${rawText})`,
          });
        }
      }

      // Check eval() or new Function()
      if (ts.isIdentifier(expr) && expr.text === "eval") {
        const { line, column } = getLineCol(node);
        dynamicImports.push({
          file: filePath,
          line,
          column,
          rawExpression: "eval(...)",
          reason: "Dynamic code execution via eval()",
        });
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  return { importSites, reExports, dynamicImports };
}

/**
 * Builds the complete import graph across all JS/TS files in the workdir.
 */
export async function analyzeImportGraph(
  options: AnalyzeImportGraphOptions,
): Promise<ImportGraphResult> {
  let workdir: SourceWorkdir;
  if (typeof options.workdir === "string") {
    workdir = new SourceWorkdir({ baseDir: options.workdir });
  } else {
    workdir = options.workdir;
  }

  const {
    files: fileContents,
    truncated,
    timedOut,
  } = workdir.readAllSourceFiles({
    maxFiles: options.maxFiles,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });

  const availableFiles = new Set(fileContents.keys());
  const allImportSites: ImportSite[] = [];
  const allReExports: ReExportRecord[] = [];
  const allDynamicImports: DynamicImportSite[] = [];

  const fileGraph: Record<string, string[]> = {};
  const reverseFileGraph: Record<string, string[]> = {};
  const packageUsage: ImportGraphResult["packageUsage"] = {};
  const importedPackagesSet = new Set<string>();

  for (const [filePath, content] of fileContents.entries()) {
    fileGraph[filePath] = [];
    if (!reverseFileGraph[filePath]) {
      reverseFileGraph[filePath] = [];
    }

    const { importSites, reExports, dynamicImports } = extractImportsFromFile(
      filePath,
      content,
      availableFiles,
    );

    allImportSites.push(...importSites);
    allReExports.push(...reExports);
    allDynamicImports.push(...dynamicImports);

    for (const site of importSites) {
      if (site.isRelative && site.resolvedFilePath) {
        const target = site.resolvedFilePath;
        if (!fileGraph[filePath]) {
          fileGraph[filePath] = [];
        }
        if (!fileGraph[filePath].includes(target)) {
          fileGraph[filePath].push(target);
        }
        if (!reverseFileGraph[target]) {
          reverseFileGraph[target] = [];
        }
        if (!reverseFileGraph[target].includes(filePath)) {
          reverseFileGraph[target].push(filePath);
        }
      } else if (site.packageName) {
        importedPackagesSet.add(site.packageName);
        let usage = packageUsage[site.packageName];
        if (!usage) {
          usage = {
            used: true,
            importCount: 0,
            importSites: [],
            importedSymbols: [],
          };
          packageUsage[site.packageName] = usage;
        }
        usage.importCount++;
        usage.importSites.push(site);
        for (const sym of site.importedSymbols) {
          if (!usage.importedSymbols.includes(sym)) {
            usage.importedSymbols.push(sym);
          }
        }
      }
    }
  }

  // Check targetPackages if provided (to detect unused packages with explicit false)
  if (options.targetPackages) {
    for (const pkg of options.targetPackages) {
      if (!packageUsage[pkg]) {
        packageUsage[pkg] = {
          used: false,
          importCount: 0,
          importSites: [],
          importedSymbols: [],
        };
      }
    }
  }

  const importedPackages = Array.from(importedPackagesSet).sort();
  const hasUnknowns = allDynamicImports.length > 0;

  // Generate evidence records
  const evidence: EvidenceRecord[] = [];

  // Graph evidence
  evidence.push({
    id: makeEvidenceId("import_graph"),
    kind: "dependency_graph",
    ref: "import-graph",
    excerpt: `Import graph built across ${fileContents.size} source files. Found ${importedPackages.length} imported packages: ${importedPackages.slice(0, 20).join(", ")}${importedPackages.length > 20 ? "..." : ""}.${hasUnknowns ? ` Flagged ${allDynamicImports.length} dynamic/unknown imports.` : ""}${truncated ? " [TRUNCATED]" : ""}`,
    fetchedAt: Date.now(),
    tool: "analyze_import_graph",
  });

  // Evidence for target packages
  if (options.targetPackages) {
    for (const pkg of options.targetPackages) {
      const usage = packageUsage[pkg];
      if (usage && !usage.used) {
        evidence.push({
          id: makeEvidenceId("unused_package"),
          kind: "static_search",
          ref: `package:${pkg}`,
          excerpt: `Proved package '${pkg}' is UNUSED: no import statement or require() found across ${fileContents.size} inspected source files.`,
          fetchedAt: Date.now(),
          tool: "analyze_import_graph",
        });
      } else if (usage && usage.used) {
        const files = Array.from(new Set(usage.importSites.map((s) => s.file)));
        evidence.push({
          id: makeEvidenceId("used_package"),
          kind: "static_search",
          ref: `package:${pkg}`,
          excerpt: `Package '${pkg}' is USED: imported in ${files.length} files (${files.slice(0, 5).join(", ")}${files.length > 5 ? "..." : ""}) with symbols [${usage.importedSymbols.join(", ")}].`,
          fetchedAt: Date.now(),
          tool: "analyze_import_graph",
        });
      }
    }
  }

  return {
    importedPackages,
    packageUsage,
    fileGraph,
    reverseFileGraph,
    reExports: allReExports,
    dynamicImports: allDynamicImports,
    hasUnknowns,
    filesAnalyzed: fileContents.size,
    truncated,
    timedOut,
    evidence,
  };
}
