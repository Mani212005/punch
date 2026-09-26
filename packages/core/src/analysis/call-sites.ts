import ts from "typescript";
import { type EvidenceRecord } from "@punch/shared";
import { SourceWorkdir } from "./source-fetch.js";
import {
  analyzeImportGraph,
  extractPackageName,
  resolveRelativeSpecifier,
  type ReExportRecord,
} from "./import-graph.js";

export type ImportStyle =
  | "named"
  | "default"
  | "namespace"
  | "commonjs_destructure"
  | "commonjs_property"
  | "reexport"
  | "direct_call"
  | "dynamic";

export interface CallSite {
  file: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  symbol: string;
  targetPackage: string;
  importStyle: ImportStyle;
  snippet: string;
  isDirectCall: boolean;
  isDynamic: boolean;
  confidence: "certain" | "probable" | "unknown";
}

export interface DynamicUsage {
  file: string;
  line: number;
  column: number;
  reason: string;
  snippet: string;
}

export interface FindCallSitesResult {
  targetPackage: string;
  searchedSymbols: string[];
  found: boolean;
  totalCallSites: number;
  callSites: CallSite[];
  dynamicUsages: DynamicUsage[];
  hasUnknowns: boolean;
  filesInspected: number;
  truncated: boolean;
  timedOut: boolean;
  evidence: EvidenceRecord[];
}

export interface FindCallSitesOptions {
  workdir: string | SourceWorkdir;
  targetPackage: string;
  symbols: string[];
  maxResults?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_MAX_RESULTS = 50;
const DEFAULT_TIMEOUT_MS = 30000;

function makeEvidenceId(kind: string): string {
  return `ev_${kind}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function extractSnippet(lines: string[], startLine: number, endLine: number): string {
  const start = Math.max(0, startLine - 1);
  const end = Math.min(lines.length, endLine);
  const slice = lines.slice(start, end);
  return slice.map((l, idx) => `${start + idx + 1}: ${l}`).join("\n");
}

/**
 * Searches for all call sites and usages of symbols belonging to a target package.
 */
export async function findCallSites(options: FindCallSitesOptions): Promise<FindCallSitesResult> {
  let workdir: SourceWorkdir;
  if (typeof options.workdir === "string") {
    workdir = new SourceWorkdir({ baseDir: options.workdir });
  } else {
    workdir = options.workdir;
  }

  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startTime = Date.now();

  const targetPkg = options.targetPackage;
  const targetSymbols = new Set(options.symbols.map((s) => s.toLowerCase()));
  const checkAnySymbol =
    options.symbols.length === 0 ||
    options.symbols.includes("*") ||
    options.symbols.includes("all");

  // 1. Build import graph first to map re-exports and module linkages
  const importGraph = await analyzeImportGraph({
    workdir,
    targetPackages: [targetPkg],
    timeoutMs,
    signal: options.signal,
  });

  const {
    files: fileContents,
    truncated: filesTruncated,
    timedOut: filesTimedOut,
  } = workdir.readAllSourceFiles({
    timeoutMs: timeoutMs - (Date.now() - startTime),
    signal: options.signal,
  });

  const availableFiles = new Set(fileContents.keys());
  let truncated = filesTruncated;
  let timedOut = filesTimedOut;

  // Build mapping of re-exported symbols from local files to target package
  // Map: `${file}::${exportedSymbol}` -> { originalSymbol, targetPackage }
  const reExportMap = new Map<string, { originalSymbol: string; targetPackage: string }>();

  function registerReExports(reExports: ReExportRecord[]) {
    for (const rx of reExports) {
      if (rx.isExternal && rx.packageName === targetPkg) {
        reExportMap.set(`${rx.file}::${rx.exportedSymbol}`, {
          originalSymbol: rx.sourceSymbol,
          targetPackage: rx.packageName,
        });
      } else if (!rx.isExternal && rx.resolvedFilePath) {
        // Chained re-export
        const parentKey = `${rx.resolvedFilePath}::${rx.sourceSymbol}`;
        const parent = reExportMap.get(parentKey);
        if (parent) {
          reExportMap.set(`${rx.file}::${rx.exportedSymbol}`, parent);
        }
      }
    }
  }

  registerReExports(importGraph.reExports);

  const callSites: CallSite[] = [];
  const dynamicUsages: DynamicUsage[] = [];

  // Pass over each file AST
  for (const [filePath, content] of fileContents.entries()) {
    if (options.signal?.aborted || Date.now() - startTime > timeoutMs) {
      timedOut = true;
      truncated = true;
      break;
    }
    if (callSites.length >= maxResults) {
      truncated = true;
      break;
    }

    const lines = content.split(/\r?\n/);
    const isJsx = filePath.endsWith(".tsx") || filePath.endsWith(".jsx");
    const sourceFile = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      true,
      isJsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    // Track local identifiers in this file:
    // 1. Direct symbol bindings: localIdent -> { originalSymbol, importStyle: "named" | "reexport" }
    // 2. Package namespace/default bindings: localIdent -> { importStyle: "default" | "namespace" | "cjs" }
    const localDirectBindings = new Map<
      string,
      { originalSymbol: string; importStyle: ImportStyle }
    >();
    const localPackageBindings = new Map<string, ImportStyle>();

    // Aliased local variables (e.g. const p = qs.parse or const merge = _.merge)
    const localAliases = new Map<string, { symbol: string; importStyle: ImportStyle }>();

    function getLineSpan(node: ts.Node) {
      const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
      return {
        line: start.line + 1,
        column: start.character + 1,
        endLine: end.line + 1,
        endColumn: end.character + 1,
      };
    }

    // Step 1: Scan imports and requires in this file
    function scanImports(node: ts.Node) {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const specifier = node.moduleSpecifier.text;
        const pkgName = extractPackageName(specifier);

        // A. Direct package import
        if (pkgName === targetPkg) {
          const clause = node.importClause;
          if (clause) {
            // Default import: import qs from 'qs'
            if (clause.name) {
              localPackageBindings.set(clause.name.text, "default");
              if (
                targetSymbols.has("default") ||
                targetSymbols.has(targetPkg.toLowerCase()) ||
                checkAnySymbol
              ) {
                localDirectBindings.set(clause.name.text, {
                  originalSymbol: "default",
                  importStyle: "default",
                });
              }
            }
            if (clause.namedBindings) {
              // Namespace: import * as qs from 'qs'
              if (ts.isNamespaceImport(clause.namedBindings)) {
                localPackageBindings.set(clause.namedBindings.name.text, "namespace");
              } else if (ts.isNamedImports(clause.namedBindings)) {
                // Named imports: import { parse as p } from 'qs'
                for (const elem of clause.namedBindings.elements) {
                  const importedName = elem.propertyName ? elem.propertyName.text : elem.name.text;
                  const localName = elem.name.text;
                  if (targetSymbols.has(importedName.toLowerCase()) || checkAnySymbol) {
                    localDirectBindings.set(localName, {
                      originalSymbol: importedName,
                      importStyle: "named",
                    });
                  }
                }
              }
            }
          }
        } else if (!pkgName) {
          // B. Relative import: check if imported file re-exports target symbol
          const clause = node.importClause;
          if (clause && clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
            for (const elem of clause.namedBindings.elements) {
              const importedName = elem.propertyName ? elem.propertyName.text : elem.name.text;
              const localName = elem.name.text;

              // Check in reExportMap if resolved file re-exports target symbol
              const resolved = resolveRelativeSpecifier(filePath, specifier, availableFiles);
              if (resolved) {
                const targetInfo = reExportMap.get(`${resolved}::${importedName}`);
                if (targetInfo && targetInfo.targetPackage === targetPkg) {
                  if (
                    targetSymbols.has(targetInfo.originalSymbol.toLowerCase()) ||
                    checkAnySymbol
                  ) {
                    localDirectBindings.set(localName, {
                      originalSymbol: targetInfo.originalSymbol,
                      importStyle: "reexport",
                    });
                  }
                }
              }
            }
          }
        }
      }

      // C. CommonJS requires: const qs = require('qs') or const { parse } = require('qs')
      if (
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        ts.isCallExpression(node.initializer) &&
        ts.isIdentifier(node.initializer.expression) &&
        node.initializer.expression.text === "require"
      ) {
        const arg = node.initializer.arguments[0];
        if (arg && ts.isStringLiteral(arg)) {
          const specifier = arg.text;
          const pkgName = extractPackageName(specifier);
          if (pkgName === targetPkg) {
            if (ts.isIdentifier(node.name)) {
              localPackageBindings.set(node.name.text, "default");
              if (
                targetSymbols.has("default") ||
                targetSymbols.has(targetPkg.toLowerCase()) ||
                checkAnySymbol
              ) {
                localDirectBindings.set(node.name.text, {
                  originalSymbol: "default",
                  importStyle: "default",
                });
              }
            } else if (ts.isObjectBindingPattern(node.name)) {
              for (const el of node.name.elements) {
                const importedName = el.propertyName
                  ? (el.propertyName as ts.Identifier).text
                  : (el.name as ts.Identifier).text;
                const localName = (el.name as ts.Identifier).text;
                if (targetSymbols.has(importedName.toLowerCase()) || checkAnySymbol) {
                  localDirectBindings.set(localName, {
                    originalSymbol: importedName,
                    importStyle: "commonjs_destructure",
                  });
                }
              }
            }
          }
        }
      }

      ts.forEachChild(node, scanImports);
    }

    scanImports(sourceFile);

    // Step 2: Track local aliases (e.g. const p = qs.parse)
    function scanAliases(node: ts.Node) {
      if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
        const varName = node.name.text;
        const init = node.initializer;

        if (ts.isPropertyAccessExpression(init) && ts.isIdentifier(init.expression)) {
          const objName = init.expression.text;
          const propName = init.name.text;
          if (localPackageBindings.has(objName)) {
            const pkgStyle = localPackageBindings.get(objName)!;
            if (targetSymbols.has(propName.toLowerCase()) || checkAnySymbol) {
              localAliases.set(varName, {
                symbol: propName,
                importStyle: pkgStyle,
              });
            }
          }
        } else if (ts.isIdentifier(init)) {
          const direct = localDirectBindings.get(init.text);
          if (direct) {
            localAliases.set(varName, {
              symbol: direct.originalSymbol,
              importStyle: direct.importStyle,
            });
          }
        }
      }

      ts.forEachChild(node, scanAliases);
    }

    scanAliases(sourceFile);

    // Step 3: Find call sites and property accesses
    function scanCallSites(node: ts.Node) {
      if (callSites.length >= maxResults) {
        truncated = true;
        return;
      }

      // Check dynamic execution: eval, Function, dynamic require
      if (ts.isCallExpression(node)) {
        const expr = node.expression;

        // Dynamic require
        if (ts.isIdentifier(expr) && expr.text === "require") {
          const arg = node.arguments[0];
          if (arg && !ts.isStringLiteral(arg)) {
            const span = getLineSpan(node);
            const raw = arg.getText(sourceFile);
            dynamicUsages.push({
              file: filePath,
              line: span.line,
              column: span.column,
              reason: `Dynamic require expression: require(${raw}) - symbol reachability UNKNOWN`,
              snippet: extractSnippet(lines, span.line, span.endLine),
            });
          }
        }

        // eval()
        if (ts.isIdentifier(expr) && expr.text === "eval") {
          const span = getLineSpan(node);
          dynamicUsages.push({
            file: filePath,
            line: span.line,
            column: span.column,
            reason: "Dynamic code execution via eval() - symbol reachability UNKNOWN",
            snippet: extractSnippet(lines, span.line, span.endLine),
          });
        }

        // Case 1: Direct function call of a named/re-exported import: parse(...)
        if (ts.isIdentifier(expr)) {
          const identName = expr.text;
          const direct = localDirectBindings.get(identName);
          const alias = localAliases.get(identName);

          if (direct) {
            const span = getLineSpan(node);
            callSites.push({
              file: filePath,
              line: span.line,
              column: span.column,
              endLine: span.endLine,
              endColumn: span.endColumn,
              symbol: direct.originalSymbol,
              targetPackage: targetPkg,
              importStyle: direct.importStyle,
              snippet: extractSnippet(lines, span.line, span.endLine),
              isDirectCall: true,
              isDynamic: false,
              confidence: "certain",
            });
          } else if (alias) {
            const span = getLineSpan(node);
            callSites.push({
              file: filePath,
              line: span.line,
              column: span.column,
              endLine: span.endLine,
              endColumn: span.endColumn,
              symbol: alias.symbol,
              targetPackage: targetPkg,
              importStyle: alias.importStyle,
              snippet: extractSnippet(lines, span.line, span.endLine),
              isDirectCall: true,
              isDynamic: false,
              confidence: "certain",
            });
          }
        }

        // Case 2: Member call on namespace/default object: qs.parse(...) or _.merge(...)
        if (ts.isPropertyAccessExpression(expr)) {
          const objExpr = expr.expression;
          const propName = expr.name.text;

          if (ts.isIdentifier(objExpr)) {
            const objName = objExpr.text;
            if (localPackageBindings.has(objName)) {
              const importStyle = localPackageBindings.get(objName)!;
              if (targetSymbols.has(propName.toLowerCase()) || checkAnySymbol) {
                const span = getLineSpan(node);
                callSites.push({
                  file: filePath,
                  line: span.line,
                  column: span.column,
                  endLine: span.endLine,
                  endColumn: span.endColumn,
                  symbol: propName,
                  targetPackage: targetPkg,
                  importStyle,
                  snippet: extractSnippet(lines, span.line, span.endLine),
                  isDirectCall: true,
                  isDynamic: false,
                  confidence: "certain",
                });
              }
            }
          }

          // Case 3: Inline require call: require('qs').parse(...)
          if (
            ts.isCallExpression(objExpr) &&
            ts.isIdentifier(objExpr.expression) &&
            objExpr.expression.text === "require"
          ) {
            const arg = objExpr.arguments[0];
            if (arg && ts.isStringLiteral(arg) && extractPackageName(arg.text) === targetPkg) {
              if (targetSymbols.has(propName.toLowerCase()) || checkAnySymbol) {
                const span = getLineSpan(node);
                callSites.push({
                  file: filePath,
                  line: span.line,
                  column: span.column,
                  endLine: span.endLine,
                  endColumn: span.endColumn,
                  symbol: propName,
                  targetPackage: targetPkg,
                  importStyle: "commonjs_property",
                  snippet: extractSnippet(lines, span.line, span.endLine),
                  isDirectCall: true,
                  isDynamic: false,
                  confidence: "certain",
                });
              }
            }
          }
        }

        // Case 4: Element access call: qs['parse'](...)
        if (ts.isElementAccessExpression(expr)) {
          const objExpr = expr.expression;
          const argExpr = expr.argumentExpression;
          if (
            ts.isIdentifier(objExpr) &&
            argExpr &&
            ts.isStringLiteral(argExpr) &&
            localPackageBindings.has(objExpr.text)
          ) {
            const propName = argExpr.text;
            const importStyle = localPackageBindings.get(objExpr.text)!;
            if (targetSymbols.has(propName.toLowerCase()) || checkAnySymbol) {
              const span = getLineSpan(node);
              callSites.push({
                file: filePath,
                line: span.line,
                column: span.column,
                endLine: span.endLine,
                endColumn: span.endColumn,
                symbol: propName,
                targetPackage: targetPkg,
                importStyle,
                snippet: extractSnippet(lines, span.line, span.endLine),
                isDirectCall: true,
                isDynamic: false,
                confidence: "certain",
              });
            }
          }
        }
      }

      ts.forEachChild(node, scanCallSites);
    }

    scanCallSites(sourceFile);
  }

  const found = callSites.length > 0;
  const hasUnknowns = dynamicUsages.length > 0;

  // Generate evidence records
  const evidence: EvidenceRecord[] = [];

  if (found) {
    for (const site of callSites.slice(0, 10)) {
      evidence.push({
        id: makeEvidenceId("call_site"),
        kind: "static_search",
        ref: `${site.file}#L${site.line}`,
        excerpt: `Found call site for '${targetPkg}.${site.symbol}' at ${site.file}:${site.line}:${site.column} (${site.importStyle}):\n${site.snippet}`,
        fetchedAt: Date.now(),
        tool: "find_call_sites",
      });
    }
  } else {
    evidence.push({
      id: makeEvidenceId("call_site_search"),
      kind: "static_search",
      ref: `package:${targetPkg}#symbols=${options.symbols.join(",")}`,
      excerpt: `Searched ${fileContents.size} source files: no call sites found for '${targetPkg}' symbols [${options.symbols.join(", ")}].${hasUnknowns ? ` (${dynamicUsages.length} dynamic usages flagged UNKNOWN)` : ""}`,
      fetchedAt: Date.now(),
      tool: "find_call_sites",
    });
  }

  if (hasUnknowns) {
    for (const dyn of dynamicUsages.slice(0, 5)) {
      evidence.push({
        id: makeEvidenceId("dynamic_usage"),
        kind: "static_search",
        ref: `${dyn.file}#L${dyn.line}`,
        excerpt: `Explicit UNKNOWN for dynamic execution at ${dyn.file}:${dyn.line}:\n${dyn.reason}\n${dyn.snippet}`,
        fetchedAt: Date.now(),
        tool: "find_call_sites",
      });
    }
  }

  return {
    targetPackage: targetPkg,
    searchedSymbols: options.symbols,
    found,
    totalCallSites: callSites.length,
    callSites,
    dynamicUsages,
    hasUnknowns,
    filesInspected: fileContents.size,
    truncated,
    timedOut,
    evidence,
  };
}
