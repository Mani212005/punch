import { z } from "zod";

export const DependencyItemSchema = z.object({
  name: z.string(),
  specifier: z.string(),
  resolvedVersion: z.string().optional(),
  isDev: z.boolean().default(false),
  type: z.enum(["prod", "dev", "peer", "optional"]).default("prod"),
});
export type DependencyItem = z.infer<typeof DependencyItemSchema>;

export const DependencyInventorySchema = z.object({
  direct: z.array(DependencyItemSchema),
  allResolved: z.record(z.string(), z.string()), // name -> exact resolved version
  manifestFound: z.boolean(),
  lockfileType: z.enum(["npm", "pnpm", "none"]),
});
export type DependencyInventory = z.infer<typeof DependencyInventorySchema>;

/**
 * Parses package.json content and extracts declared dependencies.
 */
export function parsePackageJson(content: string): DependencyItem[] {
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(content);
  } catch (err) {
    throw new Error(
      `Failed to parse package.json: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const items: DependencyItem[] = [];

  if (pkg.dependencies && typeof pkg.dependencies === "object") {
    for (const [name, spec] of Object.entries(pkg.dependencies as Record<string, unknown>)) {
      if (typeof spec === "string") {
        items.push({ name, specifier: spec, isDev: false, type: "prod" });
      }
    }
  }

  if (pkg.devDependencies && typeof pkg.devDependencies === "object") {
    for (const [name, spec] of Object.entries(pkg.devDependencies as Record<string, unknown>)) {
      if (typeof spec === "string") {
        items.push({ name, specifier: spec, isDev: true, type: "dev" });
      }
    }
  }

  if (pkg.peerDependencies && typeof pkg.peerDependencies === "object") {
    for (const [name, spec] of Object.entries(pkg.peerDependencies as Record<string, unknown>)) {
      if (typeof spec === "string") {
        items.push({ name, specifier: spec, isDev: false, type: "peer" });
      }
    }
  }

  if (pkg.optionalDependencies && typeof pkg.optionalDependencies === "object") {
    for (const [name, spec] of Object.entries(
      pkg.optionalDependencies as Record<string, unknown>,
    )) {
      if (typeof spec === "string") {
        items.push({ name, specifier: spec, isDev: false, type: "optional" });
      }
    }
  }

  return items;
}

/**
 * Parses package-lock.json content (supporting formats v1, v2, v3).
 */
export function parsePackageLock(content: string): Map<string, string> {
  let lock: Record<string, unknown>;
  try {
    lock = JSON.parse(content);
  } catch (err) {
    throw new Error(
      `Failed to parse package-lock.json: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const resolved = new Map<string, string>();

  // Format v2/v3: "packages"
  if (lock.packages && typeof lock.packages === "object") {
    for (const [pkgPath, info] of Object.entries(lock.packages as Record<string, unknown>)) {
      if (pkgPath === "" || !info || typeof info !== "object") continue;
      const version = (info as { version?: unknown }).version;
      if (typeof version !== "string") continue;

      // Extract package name from node_modules/foo or node_modules/@scope/pkg or nested
      const lastNmIdx = pkgPath.lastIndexOf("node_modules/");
      if (lastNmIdx !== -1) {
        const pkgName = pkgPath.slice(lastNmIdx + "node_modules/".length);
        if (!resolved.has(pkgName)) {
          resolved.set(pkgName, version);
        }
      }
    }
  }

  // Format v1: "dependencies"
  function walkV1(deps: Record<string, unknown>) {
    for (const [name, info] of Object.entries(deps)) {
      if (!info || typeof info !== "object") continue;
      const version = (info as { version?: unknown }).version;
      if (typeof version === "string" && !resolved.has(name)) {
        resolved.set(name, version);
      }
      const childDeps = (info as { dependencies?: unknown }).dependencies;
      if (childDeps && typeof childDeps === "object") {
        walkV1(childDeps as Record<string, unknown>);
      }
    }
  }

  if (lock.dependencies && typeof lock.dependencies === "object") {
    walkV1(lock.dependencies as Record<string, unknown>);
  }

  return resolved;
}

/**
 * Parses pnpm-lock.yaml content.
 */
export function parsePnpmLock(content: string): Map<string, string> {
  const resolved = new Map<string, string>();
  const lines = content.split(/\r?\n/);

  let inPackagesOrSnapshots = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    if (
      line.startsWith("packages:") ||
      line.startsWith("snapshots:") ||
      line.startsWith("dependencies:") ||
      line.startsWith("devDependencies:")
    ) {
      inPackagesOrSnapshots = true;
      continue;
    }

    if (
      inPackagesOrSnapshots &&
      line.length > 0 &&
      !line.startsWith(" ") &&
      !line.startsWith("\t")
    ) {
      // Exited block
      inPackagesOrSnapshots = false;
    }

    if (inPackagesOrSnapshots) {
      // Match patterns like:
      //   '/qs@6.5.2':
      //   'qs@6.5.2':
      //   /@scope/pkg@1.2.3:
      //   /express@4.18.2(debug@2.6.9):
      const match = line.match(/^\s+['"]?\/?(@?[^@\s:]+)@([^(\s:'"]+)/);
      if (match) {
        const name = match[1];
        const version = match[2];
        if (name && version && !resolved.has(name)) {
          // Clean up hash/peers if attached to version
          const cleanVersion = version.split("_")[0]?.split("(")[0]?.trim();
          if (cleanVersion) {
            resolved.set(name, cleanVersion);
          }
        }
      }
    }
  }

  return resolved;
}

/**
 * Builds a unified dependency inventory by merging package.json and available lockfile data.
 */
export function buildDependencyInventory(options: {
  packageJson: string;
  packageLock?: string;
  pnpmLock?: string;
}): DependencyInventory {
  const directItems = parsePackageJson(options.packageJson);
  let lockMap = new Map<string, string>();
  let lockfileType: "npm" | "pnpm" | "none" = "none";

  if (options.packageLock) {
    try {
      lockMap = parsePackageLock(options.packageLock);
      lockfileType = "npm";
    } catch {
      // Continue with empty lock map if unparseable
    }
  } else if (options.pnpmLock) {
    try {
      lockMap = parsePnpmLock(options.pnpmLock);
      lockfileType = "pnpm";
    } catch {
      // Continue with empty lock map if unparseable
    }
  }

  const allResolved: Record<string, string> = {};
  for (const [k, v] of lockMap.entries()) {
    allResolved[k] = v;
  }

  const enrichedDirect: DependencyItem[] = directItems.map((item) => {
    const resolvedVersion = lockMap.get(item.name);
    return {
      ...item,
      resolvedVersion: resolvedVersion ?? undefined,
    };
  });

  return {
    direct: enrichedDirect,
    allResolved,
    manifestFound: true,
    lockfileType,
  };
}
