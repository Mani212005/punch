import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { type EvidenceRecord, type TraceEvent } from "@punch/shared";
import { GitHubClient } from "../tools/github.js";

export interface SourceWorkdirOptions {
  runId?: string;
  baseDir?: string;
  maxFiles?: number;
  maxFileSize?: number;
  maxTotalBytes?: number;
  timeoutMs?: number;
  traceSink?: (event: TraceEvent) => unknown;
}

export interface FetchSourceResult {
  workdir: string;
  fileCount: number;
  totalBytes: number;
  files: string[];
  truncated: boolean;
  evidence?: EvidenceRecord;
  sourceType: "local" | "github";
}

export interface ReadFileResult {
  filePath: string;
  content: string;
  totalLines: number;
  startLine?: number;
  endLine?: number;
  truncated: boolean;
  evidence: EvidenceRecord;
}

const DEFAULT_MAX_FILES = 1000;
const DEFAULT_MAX_FILE_SIZE = 1 * 1024 * 1024; // 1 MB
const DEFAULT_MAX_TOTAL_BYTES = 50 * 1024 * 1024; // 50 MB
const DEFAULT_TIMEOUT_MS = 30000;

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  ".turbo",
  ".next",
  "dist",
  "build",
  "coverage",
  ".cache",
]);

function makeEvidenceId(kind: string): string {
  return `ev_${kind}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export class SourceWorkdir {
  readonly runId: string;
  readonly workdirPath: string;
  readonly isEphemeral: boolean;
  private readonly maxFiles: number;
  private readonly maxFileSize: number;
  private readonly maxTotalBytes: number;
  private readonly timeoutMs: number;
  private readonly traceSink?: (event: TraceEvent) => unknown;

  private filesInspectedSet = new Set<string>();
  private recordedEvidence: EvidenceRecord[] = [];

  constructor(options: SourceWorkdirOptions = {}) {
    this.runId = options.runId ?? `run_${Date.now()}`;
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    this.maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
    this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.traceSink = options.traceSink;

    if (options.baseDir) {
      this.workdirPath = path.resolve(options.baseDir);
      this.isEphemeral = false;
      if (!fs.existsSync(this.workdirPath)) {
        fs.mkdirSync(this.workdirPath, { recursive: true });
      }
    } else {
      const tmpDir = path.join(
        os.tmpdir(),
        `punch_workdir_${this.runId}_${Math.random().toString(36).slice(2, 7)}`,
      );
      fs.mkdirSync(tmpDir, { recursive: true });
      this.workdirPath = tmpDir;
      this.isEphemeral = true;
    }
  }

  get isReadOnly(): boolean {
    return true;
  }

  getFilesInspected(): string[] {
    return Array.from(this.filesInspectedSet).sort();
  }

  getRecordedEvidence(): EvidenceRecord[] {
    return [...this.recordedEvidence];
  }

  /**
   * Safely resolves a relative path within the workdir, preventing directory traversal.
   */
  resolvePath(relativePath: string): string {
    const cleanRel = relativePath.replace(/^[/\\]+/, "");
    const resolved = path.resolve(this.workdirPath, cleanRel);
    if (!resolved.startsWith(this.workdirPath)) {
      throw new Error(`Path traversal denied: '${relativePath}' escapes workdir.`);
    }
    return resolved;
  }

  /**
   * Relative path from workdir.
   */
  relativeOf(absolutePath: string): string {
    return path.relative(this.workdirPath, absolutePath).replace(/\\/g, "/");
  }

  /**
   * Recursively copies files from a local source directory into this workdir.
   */
  async populateFromLocal(sourceDir: string, signal?: AbortSignal): Promise<FetchSourceResult> {
    const resolvedSource = path.resolve(sourceDir);
    if (!fs.existsSync(resolvedSource)) {
      throw new Error(`Source directory not found: ${resolvedSource}`);
    }

    const files: string[] = [];
    let fileCount = 0;
    let totalBytes = 0;
    let truncated = false;

    const copyDir = (currentSrc: string, currentDst: string) => {
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }
      if (fileCount >= this.maxFiles || totalBytes >= this.maxTotalBytes) {
        truncated = true;
        return;
      }

      const entries = fs.readdirSync(currentSrc, { withFileTypes: true });
      for (const entry of entries) {
        if (signal?.aborted) throw new Error("Operation aborted");
        if (IGNORED_DIRS.has(entry.name)) continue;

        const srcPath = path.join(currentSrc, entry.name);
        const dstPath = path.join(currentDst, entry.name);

        if (entry.isDirectory()) {
          if (!fs.existsSync(dstPath)) {
            fs.mkdirSync(dstPath, { recursive: true });
          }
          copyDir(srcPath, dstPath);
        } else if (entry.isFile()) {
          if (fileCount >= this.maxFiles || totalBytes >= this.maxTotalBytes) {
            truncated = true;
            return;
          }

          const stats = fs.statSync(srcPath);
          if (stats.size > this.maxFileSize) {
            // Copy truncated content or skip
            const buffer = Buffer.alloc(this.maxFileSize);
            const fd = fs.openSync(srcPath, "r");
            fs.readSync(fd, buffer, 0, this.maxFileSize, 0);
            fs.closeSync(fd);
            fs.writeFileSync(dstPath, buffer);
            totalBytes += this.maxFileSize;
            truncated = true;
          } else {
            fs.copyFileSync(srcPath, dstPath);
            totalBytes += stats.size;
          }

          fileCount++;
          const rel = this.relativeOf(dstPath);
          files.push(rel);
        }
      }
    };

    copyDir(resolvedSource, this.workdirPath);

    const evidence: EvidenceRecord = {
      id: makeEvidenceId("source_fetch"),
      kind: "file",
      ref: `local://${resolvedSource}`,
      excerpt: `Fetched ${fileCount} files (${totalBytes} bytes) into workdir${truncated ? " [TRUNCATED]" : ""}`,
      fetchedAt: Date.now(),
      tool: "fetch_repo_source",
    };
    this.recordEvidenceItem(evidence);

    return {
      workdir: this.workdirPath,
      fileCount,
      totalBytes,
      files,
      truncated,
      evidence,
      sourceType: "local",
    };
  }

  /**
   * Fetches files from GitHub via contents API or client.
   */
  async populateFromGitHub(options: {
    owner: string;
    repo: string;
    ref?: string;
    client?: GitHubClient;
    signal?: AbortSignal;
  }): Promise<FetchSourceResult> {
    const client = options.client ?? new GitHubClient({ traceSink: this.traceSink });
    const files: string[] = [];
    let fileCount = 0;
    let totalBytes = 0;
    let truncated = false;

    const fetchPath = async (ghPath: string) => {
      if (options.signal?.aborted) throw new Error("Operation aborted");
      if (fileCount >= this.maxFiles || totalBytes >= this.maxTotalBytes) {
        truncated = true;
        return;
      }

      const res = await client.getContents(
        options.owner,
        options.repo,
        ghPath,
        options.ref,
        options.signal,
      );

      if (Array.isArray(res.data)) {
        // Directory listing
        for (const item of res.data) {
          if (IGNORED_DIRS.has(item.name)) continue;
          if (item.type === "dir") {
            await fetchPath(item.path);
          } else if (item.type === "file") {
            if (fileCount >= this.maxFiles || totalBytes >= this.maxTotalBytes) {
              truncated = true;
              return;
            }
            // Fetch individual file
            await fetchPath(item.path);
          }
        }
      } else {
        // Single file
        const fileData = res.data;
        const targetPath = this.resolvePath(fileData.path);
        const parentDir = path.dirname(targetPath);
        if (!fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true });
        }

        const content = fileData.decodedContent ?? "";
        const byteLen = Buffer.byteLength(content, "utf8");

        if (byteLen > this.maxFileSize) {
          const truncatedContent = content.slice(0, this.maxFileSize);
          fs.writeFileSync(targetPath, truncatedContent, "utf8");
          totalBytes += this.maxFileSize;
          truncated = true;
        } else {
          fs.writeFileSync(targetPath, content, "utf8");
          totalBytes += byteLen;
        }

        fileCount++;
        const rel = this.relativeOf(targetPath);
        files.push(rel);
      }
    };

    try {
      await fetchPath("");
    } catch (err) {
      if (fileCount === 0) {
        throw err;
      }
      truncated = true;
    }

    const evidence: EvidenceRecord = {
      id: makeEvidenceId("source_fetch"),
      kind: "file",
      ref: `github://${options.owner}/${options.repo}${options.ref ? `@${options.ref}` : ""}`,
      excerpt: `Fetched ${fileCount} files from GitHub (${totalBytes} bytes)${truncated ? " [TRUNCATED]" : ""}`,
      fetchedAt: Date.now(),
      tool: "fetch_repo_source",
    };
    this.recordEvidenceItem(evidence);

    return {
      workdir: this.workdirPath,
      fileCount,
      totalBytes,
      files,
      truncated,
      evidence,
      sourceType: "github",
    };
  }

  /**
   * Reads a file from the workdir, recording inspection and evidence.
   */
  readFile(
    relativePath: string,
    options: { startLine?: number; endLine?: number; maxBytes?: number } = {},
  ): ReadFileResult {
    const fullPath = this.resolvePath(relativePath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`File not found in workdir: ${relativePath}`);
    }

    const cleanRel = this.relativeOf(fullPath);
    this.filesInspectedSet.add(cleanRel);

    const stats = fs.statSync(fullPath);
    const maxBytes = options.maxBytes ?? this.maxFileSize;
    let rawContent: string;
    let truncated = false;

    if (stats.size > maxBytes) {
      const buffer = Buffer.alloc(maxBytes);
      const fd = fs.openSync(fullPath, "r");
      fs.readSync(fd, buffer, 0, maxBytes, 0);
      fs.closeSync(fd);
      rawContent = buffer.toString("utf8");
      truncated = true;
    } else {
      rawContent = fs.readFileSync(fullPath, "utf8");
    }

    const lines = rawContent.split(/\r?\n/);
    const totalLines = lines.length;

    let selectedContent = rawContent;
    let excerpt = rawContent;

    if (options.startLine !== undefined || options.endLine !== undefined) {
      const start = Math.max(1, options.startLine ?? 1);
      const end = Math.min(totalLines, options.endLine ?? totalLines);
      const slice = lines.slice(start - 1, end);
      selectedContent = slice.join("\n");
      excerpt = `Lines ${start}-${end} of ${cleanRel}:\n${selectedContent.slice(0, 1000)}`;
    } else {
      excerpt = `Content of ${cleanRel} (${totalLines} lines):\n${rawContent.slice(0, 1000)}`;
    }

    const evidence: EvidenceRecord = {
      id: makeEvidenceId("file_read"),
      kind: "file",
      ref: cleanRel,
      excerpt,
      fetchedAt: Date.now(),
      tool: "read_repo_file",
    };
    this.recordEvidenceItem(evidence);

    return {
      filePath: cleanRel,
      content: selectedContent,
      totalLines,
      startLine: options.startLine,
      endLine: options.endLine,
      truncated,
      evidence,
    };
  }

  /**
   * Lists all files in the workdir.
   */
  listFiles(options: { extensions?: string[] } = {}): string[] {
    const result: string[] = [];
    const extSet = options.extensions ? new Set(options.extensions) : null;

    const walk = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          const rel = this.relativeOf(full);
          if (extSet) {
            const ext = path.extname(entry.name).toLowerCase();
            if (extSet.has(ext)) {
              result.push(rel);
            }
          } else {
            result.push(rel);
          }
        }
      }
    };

    walk(this.workdirPath);
    return result.sort();
  }

  /**
   * Reads all JS/TS source files into a map of relative path -> content.
   */
  readAllSourceFiles(
    options: {
      extensions?: string[];
      maxFiles?: number;
      timeoutMs?: number;
      signal?: AbortSignal;
    } = {},
  ): {
    files: Map<string, string>;
    truncated: boolean;
    timedOut: boolean;
  } {
    const extensions = options.extensions ?? [
      ".ts",
      ".tsx",
      ".js",
      ".jsx",
      ".mjs",
      ".cjs",
      ".json",
    ];
    const maxFiles = options.maxFiles ?? this.maxFiles;
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const startTime = Date.now();

    const fileList = this.listFiles({ extensions });
    const files = new Map<string, string>();
    let truncated = false;
    let timedOut = false;

    for (const rel of fileList) {
      if (options.signal?.aborted || Date.now() - startTime > timeoutMs) {
        timedOut = true;
        truncated = true;
        break;
      }
      if (files.size >= maxFiles) {
        truncated = true;
        break;
      }

      try {
        const full = this.resolvePath(rel);
        const stats = fs.statSync(full);
        if (stats.size > this.maxFileSize) {
          const buffer = Buffer.alloc(this.maxFileSize);
          const fd = fs.openSync(full, "r");
          fs.readSync(fd, buffer, 0, this.maxFileSize, 0);
          fs.closeSync(fd);
          files.set(rel, buffer.toString("utf8"));
          truncated = true;
        } else {
          files.set(rel, fs.readFileSync(full, "utf8"));
        }
      } catch {
        // Skip unreadable files
      }
    }

    return { files, truncated, timedOut };
  }

  cleanup(): void {
    if (this.isEphemeral && fs.existsSync(this.workdirPath)) {
      try {
        fs.rmSync(this.workdirPath, { recursive: true, force: true });
      } catch {
        // Ignore cleanup failure
      }
    }
  }

  private recordEvidenceItem(evidence: EvidenceRecord): void {
    this.recordedEvidence.push(evidence);
    if (this.traceSink) {
      try {
        this.traceSink({
          runId: this.runId,
          seq: 0,
          ts: Date.now(),
          kind: "evidence.recorded",
          role: "reachability",
          agentId: "source-fetcher",
          evidence,
        });
      } catch {
        // Ignore trace sink error
      }
    }
  }
}
