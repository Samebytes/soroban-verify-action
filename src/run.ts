/** Core action logic. All side effects are injected so tests can mock them. */

export const COMMENT_MARKER = "<!-- soroban-verify-action -->";
export const RELEASE_MARKER_START = "<!-- soroban-verify-release:start -->";
export const RELEASE_MARKER_END = "<!-- soroban-verify-release:end -->";

export interface CliResult {
  status: "verified" | "mismatch";
  contract_id: string;
  onchain_hash: string;
  built_hash: string;
  repo: string;
  commit: string;
  toolchain_image: string;
}

export interface Comment {
  id: number;
  body: string;
}

export interface Deps {
  /** Runs `soroban-verify verify ... --json`. Rejects with a message on exit code 2. */
  runCli(args: string[]): Promise<CliResult>;
  listComments(pr: number): Promise<Comment[]>;
  createComment(pr: number, body: string): Promise<void>;
  updateComment(id: number, body: string): Promise<void>;
  uploadArtifact(name: string, fileName: string, content: string): Promise<void>;
  /** The release being built, when the workflow runs on a release event (wave: action-1). */
  getRelease(): Promise<{ id: number; body: string } | null>;
  updateReleaseBody(id: number, body: string): Promise<void>;
  /** Submits a verified result to the registry (wave: action-2). */
  postToRegistry(result: CliResult): Promise<void>;
  warn(message: string): void;
  fail(message: string): void;
}

export interface Inputs {
  contractId: string;
  repo: string;
  commit: string;
  image?: string;
  /** Registry base URL. When set, verified results are posted there. */
  registryUrl?: string;
  /**
   * Pull request (or issue) to comment on. Unset on release, push and other runs without one:
   * those skip the comment but still upload the result, edit the release and fail on a mismatch.
   */
  pullRequest?: number;
}

export function formatComment(r: CliResult): string {
  const icon = r.status === "verified" ? "✅" : "❌";
  return [
    COMMENT_MARKER,
    `### ${icon} Soroban build verification: ${r.status}`,
    "",
    "| | |",
    "|---|---|",
    `| Contract | \`${r.contract_id}\` |`,
    `| Commit | \`${r.commit}\` |`,
    `| Toolchain image | \`${r.toolchain_image}\` |`,
    `| On-chain WASM hash | \`${r.onchain_hash}\` |`,
    `| Rebuilt WASM hash | \`${r.built_hash}\` |`,
    "",
    "_Verified means this commit rebuilds to the deployed bytes with the pinned toolchain. " +
      "It does not mean the code is safe or audited._",
  ].join("\n");
}

/** Release-notes block with the hash; replaced in place on re-runs. */
export function formatReleaseBlock(r: CliResult): string {
  return [
    RELEASE_MARKER_START,
    `**Soroban build verification:** ${r.status}`,
    "",
    `- Contract: \`${r.contract_id}\``,
    `- Commit: \`${r.commit}\``,
    `- WASM SHA-256: \`${r.built_hash}\``,
    RELEASE_MARKER_END,
  ].join("\n");
}

/** Inserts or replaces the verification block in release notes, leaving the rest untouched. */
export function withReleaseBlock(body: string, block: string): string {
  const start = body.indexOf(RELEASE_MARKER_START);
  const end = body.indexOf(RELEASE_MARKER_END);
  if (start !== -1 && end > start) {
    return body.slice(0, start) + block + body.slice(end + RELEASE_MARKER_END.length);
  }
  return body.trim() ? `${body.trimEnd()}\n\n${block}\n` : `${block}\n`;
}

export async function run(inputs: Inputs, deps: Deps): Promise<void> {
  const args = ["verify", inputs.contractId, "--repo", inputs.repo, "--commit", inputs.commit, "--json"];
  if (inputs.image) args.push("--image", inputs.image);

  let result: CliResult;
  try {
    result = await deps.runCli(args);
  } catch (e) {
    deps.fail(`soroban-verify failed: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  if (inputs.pullRequest !== undefined) {
    const body = formatComment(result);
    const existing = (await deps.listComments(inputs.pullRequest)).find((c) =>
      c.body.includes(COMMENT_MARKER),
    );
    if (existing) await deps.updateComment(existing.id, body);
    else await deps.createComment(inputs.pullRequest, body);
  }

  await deps.uploadArtifact(
    "soroban-verify-hash",
    "soroban-verify-result.json",
    JSON.stringify(result, null, 2),
  );

  const release = await deps.getRelease();
  if (release) {
    await deps.updateReleaseBody(release.id, withReleaseBlock(release.body, formatReleaseBlock(result)));
  }

  if (result.status === "verified" && inputs.registryUrl) {
    try {
      await deps.postToRegistry(result);
    } catch (e) {
      // A registry outage must not fail an otherwise verified build.
      deps.warn(`could not post to registry: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (result.status !== "verified") {
    deps.fail(`Hash mismatch: on-chain ${result.onchain_hash} != rebuilt ${result.built_hash}`);
  }
}
