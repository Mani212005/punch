import type { GitHubPullResponse } from "../tools/github.js";
import type { GitHubClient } from "../tools/github.js";
import { CompensationRegistry } from "./compensation.js";
import { validatedManifestFiles } from "./proposal.js";
import type { SandboxValidation } from "@punch/shared";

export interface FixPrInput {
  owner: string;
  repo: string;
  /** Base branch the fix starts from, e.g. "main". */
  base: string;
  /** Fix branch to create, e.g. "punch/fix-foo-2.4.0". */
  branch: string;
  title: string;
  body: string;
  sandbox: SandboxValidation;
  /** Contents for exactly the validated manifest/lockfile diff. */
  validatedFiles: Record<string, string>;
  signal?: AbortSignal;
}

export interface FixPrResult {
  pull: GitHubPullResponse;
  branch: string;
  committedFiles: string[];
}

/**
 * Open a fix PR: resolve the base SHA, create the branch, commit exactly the
 * manifest/lockfile diff the E5 sandbox validated, then open the PR.
 *
 * If any step after the branch creation fails, the branch is deleted and the
 * outcome is traced as `compensation.ran` (plan.md 3.6 step 8).
 */
export async function openFixPr(
  github: GitHubClient,
  input: FixPrInput,
  compensation?: CompensationRegistry,
): Promise<FixPrResult> {
  const files = validatedManifestFiles(input.sandbox, input.validatedFiles);
  const committedFiles = Object.keys(files);
  if (committedFiles.length === 0) {
    throw new Error("refusing to open a fix PR with no validated manifest or lockfile changes");
  }

  const base = await github.getRef(input.owner, input.repo, input.base, input.signal);
  const baseSha = base.data.object.sha;

  await github.createRef(input.owner, input.repo, input.branch, baseSha, input.signal);
  const registry = compensation ?? new CompensationRegistry();
  registry.register({
    action: "delete_branch",
    undo: () => github.deleteRef(input.owner, input.repo, input.branch, input.signal),
  });

  try {
    for (const file of committedFiles) {
      let sha: string | undefined;
      try {
        const existing = await github.getContents(
          input.owner,
          input.repo,
          file,
          input.branch,
          input.signal,
        );
        if (!Array.isArray(existing.data)) sha = existing.data.sha;
      } catch {
        sha = undefined;
      }
      await github.upsertFile(
        input.owner,
        input.repo,
        file,
        {
          branch: input.branch,
          content: files[file]!,
          message: `${input.title} (${file})`,
          ...(sha ? { sha } : {}),
        },
        input.signal,
      );
    }

    const pull = await github.createPull(
      input.owner,
      input.repo,
      { title: input.title, body: input.body, head: input.branch, base: input.base },
      input.signal,
    );
    registry.clear();
    return { pull: pull.data, branch: input.branch, committedFiles };
  } catch (error) {
    await registry.compensateAll(
      `fix PR for ${input.owner}/${input.repo} failed after branch ${input.branch} was created`,
    );
    throw error;
  }
}
