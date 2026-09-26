import type { SupplyChainSignal } from "@punch/shared";
import { NpmVersionMetadataSchema, type NpmPackageMetadata } from "../tools/npm.js";

type VersionMeta = ReturnType<typeof NpmVersionMetadataSchema.parse>;

const INSTALL_HOOKS = ["preinstall", "install", "postinstall"] as const;
/** Commands that fetch or execute remote or encoded code from an install hook. */
const SUSPICIOUS_SCRIPT =
  /\b(curl|wget|eval|base64|powershell|nc|bash\s+-c)\b|https?:\/\/|node\s+-e/i;

const SIZE_JUMP_RATIO = 3;
const SIZE_JUMP_MIN_BYTES = 50_000;
const FILE_JUMP_RATIO = 3;
const FILE_JUMP_MIN_FILES = 20;
const DORMANT_MS = 730 * 24 * 60 * 60 * 1000;

export interface AnalyzeOptions {
  /** Version to analyze. */
  version: string;
  /** Version to compare against; defaults to the release published just before `version`. */
  previousVersion?: string;
}

function parseVersion(meta: NpmPackageMetadata, version: string): VersionMeta | undefined {
  const raw = meta.versions[version];
  const parsed = NpmVersionMetadataSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/** The release published immediately before `version`, by registry publish time. */
export function findPreviousVersion(meta: NpmPackageMetadata, version: string): string | undefined {
  const at = meta.time[version];
  if (!at) return undefined;
  const cutoff = Date.parse(at);
  let best: { v: string; t: number } | undefined;
  for (const v of Object.keys(meta.versions)) {
    if (v === version || v.includes("-")) continue;
    const t = Date.parse(meta.time[v] ?? "");
    if (Number.isNaN(t) || t >= cutoff) continue;
    if (!best || t > best.t) best = { v, t };
  }
  return best?.v;
}

function maintainerNames(v: VersionMeta): Set<string> {
  return new Set((v.maintainers ?? []).flatMap((m) => (m.name ? [m.name] : [])));
}

function hasAttestations(v: VersionMeta): boolean {
  return v.dist?.attestations !== undefined;
}

function installScripts(v: VersionMeta): Record<string, string> {
  const out: Record<string, string> = {};
  for (const hook of INSTALL_HOOKS) {
    const cmd = v.scripts?.[hook];
    if (cmd) out[hook] = cmd;
  }
  return out;
}

function major(version: string): number | undefined {
  const n = Number.parseInt(version.split(".")[0] ?? "", 10);
  return Number.isNaN(n) ? undefined : n;
}

/**
 * Pure anomaly pass over npm registry metadata for one release. Only anomalies are
 * returned: a clean release yields an empty list, and comparison signals need a
 * previous release to compare against.
 */
export function analyzeSupplyChain(
  meta: NpmPackageMetadata,
  options: AnalyzeOptions,
): SupplyChainSignal[] {
  const version = options.version;
  const cur = parseVersion(meta, version);
  if (!cur) return [];
  const prevVersion = options.previousVersion ?? findPreviousVersion(meta, version);
  const prev = prevVersion ? parseVersion(meta, prevVersion) : undefined;
  const signals: SupplyChainSignal[] = [];
  const push = (
    kind: SupplyChainSignal["kind"],
    severity: SupplyChainSignal["severity"],
    detail: string,
  ) =>
    signals.push({ kind, severity, detail, version, comparedTo: prev ? prevVersion : undefined });

  // Install scripts: new ones, or any that fetch or execute remote code.
  const scripts = installScripts(cur);
  const prevScripts = prev ? installScripts(prev) : {};
  for (const [hook, cmd] of Object.entries(scripts)) {
    const suspicious = SUSPICIOUS_SCRIPT.test(cmd);
    const isNew = prev !== undefined && prevScripts[hook] === undefined;
    const changed =
      prev !== undefined && prevScripts[hook] !== undefined && prevScripts[hook] !== cmd;
    if (suspicious) {
      push(
        "install_script",
        "HIGH",
        `${hook} runs \`${cmd}\`, which fetches or executes remote or encoded code`,
      );
    } else if (isNew) {
      push("install_script", "MEDIUM", `${hook} script \`${cmd}\` is new in this release`);
    } else if (changed) {
      push("install_script", "MEDIUM", `${hook} script changed to \`${cmd}\``);
    }
  }

  if (prev) {
    // Maintainers: new publisher or changed maintainer set.
    const before = maintainerNames(prev);
    const after = maintainerNames(cur);
    const added = [...after].filter((n) => !before.has(n));
    const removed = [...before].filter((n) => !after.has(n));
    const publisher = cur._npmUser?.name;
    if (publisher && before.size > 0 && !before.has(publisher)) {
      push(
        "maintainer_change",
        "HIGH",
        `published by ${publisher}, who was not a maintainer of ${prevVersion}`,
      );
    } else if (added.length > 0) {
      push(
        "maintainer_change",
        "MEDIUM",
        `new maintainer${added.length > 1 ? "s" : ""}: ${added.join(", ")}`,
      );
    } else if (removed.length > 0) {
      push(
        "maintainer_change",
        "LOW",
        `maintainer${removed.length > 1 ? "s" : ""} removed: ${removed.join(", ")}`,
      );
    }

    // Runtime dependencies added.
    const prevDeps = new Set(Object.keys(prev.dependencies ?? {}));
    const newDeps = Object.keys(cur.dependencies ?? {}).filter((d) => !prevDeps.has(d));
    if (newDeps.length > 0) {
      push(
        "new_dependency",
        newDeps.length >= 3 ? "HIGH" : "MEDIUM",
        `adds runtime dependenc${newDeps.length > 1 ? "ies" : "y"}: ${newDeps.join(", ")}`,
      );
    }

    // Unusual release shape: size, file count, version gap, dormancy.
    const size = cur.dist?.unpackedSize;
    const prevSize = prev.dist?.unpackedSize;
    if (size !== undefined && prevSize !== undefined && prevSize > 0) {
      if (size >= prevSize * SIZE_JUMP_RATIO && size - prevSize >= SIZE_JUMP_MIN_BYTES) {
        push("release_change", "MEDIUM", `unpacked size grew ${prevSize} -> ${size} bytes`);
      }
    }
    const files = cur.dist?.fileCount;
    const prevFiles = prev.dist?.fileCount;
    if (files !== undefined && prevFiles !== undefined && prevFiles > 0) {
      if (files >= prevFiles * FILE_JUMP_RATIO && files - prevFiles >= FILE_JUMP_MIN_FILES) {
        push("release_change", "MEDIUM", `file count grew ${prevFiles} -> ${files}`);
      }
    }
    const [curMajor, prevMajor] = [major(version), major(prevVersion!)];
    if (curMajor !== undefined && prevMajor !== undefined && curMajor - prevMajor >= 2) {
      push(
        "release_change",
        "LOW",
        `version jumped from ${prevVersion} to ${version}, skipping majors`,
      );
    }
    const t = Date.parse(meta.time[version] ?? "");
    const pt = Date.parse(meta.time[prevVersion!] ?? "");
    if (!Number.isNaN(t) && !Number.isNaN(pt) && t - pt >= DORMANT_MS) {
      push(
        "release_change",
        "MEDIUM",
        `first release after ${Math.round((t - pt) / 86_400_000)} days of no releases`,
      );
    }

    // Provenance lost.
    if (hasAttestations(prev) && !hasAttestations(cur)) {
      push(
        "provenance_regression",
        "HIGH",
        `${prevVersion} had npm provenance attestations, this release has none`,
      );
    }
  }

  if (!cur.dist?.integrity && !cur.dist?.shasum) {
    push(
      "integrity_missing",
      "MEDIUM",
      "registry metadata has no integrity hash or shasum for this release",
    );
  }

  return signals;
}
