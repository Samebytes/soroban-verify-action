import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COMMENT_MARKER, RELEASE_MARKER_END, RELEASE_MARKER_START, run, withReleaseBlock,
  type CliResult, type Comment, type Deps,
} from "../src/run.js";

const H = "a".repeat(64);
const verified: CliResult = {
  status: "verified", contract_id: "C" + "A".repeat(55), onchain_hash: H,
  built_hash: H, repo: "https://github.com/a/b", commit: "abcdef1", toolchain_image: "img",
};
const mismatch: CliResult = { ...verified, status: "mismatch", built_hash: "b".repeat(64) };

function mock(opts: { cli?: CliResult | Error; comments?: Comment[]; release?: { id: number; body: string }; registryError?: Error }) {
  const calls = { args: [] as string[], commentPrs: [] as number[], created: [] as string[], updated: [] as [number, string][], artifacts: [] as string[], failed: [] as string[], warned: [] as string[], releaseUpdates: [] as [number, string][], registryPosts: [] as CliResult[] };
  const deps: Deps = {
    runCli: async (a) => {
      calls.args = a;
      if (opts.cli instanceof Error) throw opts.cli;
      return opts.cli ?? verified;
    },
    listComments: async (pr) => {
      calls.commentPrs.push(pr);
      return opts.comments ?? [];
    },
    createComment: async (pr, b) => {
      calls.commentPrs.push(pr);
      calls.created.push(b);
    },
    updateComment: async (id, b) => void calls.updated.push([id, b]),
    uploadArtifact: async (_n, f, c) => void calls.artifacts.push(`${f}:${c}`),
    getRelease: async () => opts.release ?? null,
    updateReleaseBody: async (id, b) => void calls.releaseUpdates.push([id, b]),
    postToRegistry: async (r) => {
      if (opts.registryError) throw opts.registryError;
      calls.registryPosts.push(r);
    },
    warn: (m) => void calls.warned.push(m),
    fail: (m) => void calls.failed.push(m),
  };
  return { deps, calls };
}

const inputs = { contractId: verified.contract_id, repo: "https://github.com/a/b", commit: "abcdef1", pullRequest: 5 };

test("creates a comment when none exists and uploads the hash", async () => {
  const { deps, calls } = mock({});
  await run(inputs, deps);
  assert.equal(calls.created.length, 1);
  assert.equal(calls.updated.length, 0);
  assert.deepEqual(calls.commentPrs, [5, 5], "lists and comments on the run's PR");
  assert.match(calls.created[0]!, /verified/);
  assert.match(calls.artifacts[0]!, new RegExp(H));
  assert.deepEqual(calls.failed, []);
  assert.ok(calls.args.includes("--json"));
});

test("a run without a PR (release, push) skips the comment but does everything else", async () => {
  const { deps, calls } = mock({ cli: mismatch, release: { id: 9, body: "notes" } });
  await run({ ...inputs, pullRequest: undefined }, deps);
  assert.deepEqual(calls.commentPrs, [], "the comments API is never called");
  assert.equal(calls.created.length + calls.updated.length, 0);
  assert.equal(calls.artifacts.length, 1);
  assert.equal(calls.releaseUpdates.length, 1);
  assert.match(calls.failed[0]!, /mismatch/i);
});

test("updates the existing marked comment instead of creating another", async () => {
  const { deps, calls } = mock({
    comments: [{ id: 1, body: "unrelated" }, { id: 7, body: `${COMMENT_MARKER} old` }],
  });
  await run(inputs, deps);
  assert.equal(calls.created.length, 0);
  assert.equal(calls.updated[0]![0], 7);
});

test("mismatch fails the check but still comments and uploads", async () => {
  const { deps, calls } = mock({ cli: mismatch });
  await run(inputs, deps);
  assert.equal(calls.failed.length, 1);
  assert.match(calls.failed[0]!, /mismatch/i);
  assert.equal(calls.created.length, 1);
  assert.equal(calls.artifacts.length, 1);
});

test("CLI error fails the check and posts nothing", async () => {
  const { deps, calls } = mock({ cli: new Error("repo_unreachable") });
  await run(inputs, deps);
  assert.match(calls.failed[0]!, /repo_unreachable/);
  assert.equal(calls.created.length, 0);
});

test("image input is forwarded to the CLI", async () => {
  const { deps, calls } = mock({});
  await run({ ...inputs, image: "my/img:1" }, deps);
  assert.deepEqual(calls.args.slice(-2), ["--image", "my/img:1"]);
});

// ---- action-1: release notes ----------------------------------------------------------

test("on a release event the hash is appended to the release notes", async () => {
  const { deps, calls } = mock({ release: { id: 42, body: "## Changes\n- stuff" } });
  await run(inputs, deps);
  assert.equal(calls.releaseUpdates.length, 1);
  const [id, body] = calls.releaseUpdates[0]!;
  assert.equal(id, 42);
  assert.ok(body.startsWith("## Changes\n- stuff"), "existing notes are preserved");
  assert.match(body, new RegExp(H));
  assert.ok(body.includes(RELEASE_MARKER_START) && body.includes(RELEASE_MARKER_END));
});

test("re-running replaces the block instead of duplicating it", () => {
  const once = withReleaseBlock("notes", `${RELEASE_MARKER_START}\nold\n${RELEASE_MARKER_END}`);
  const twice = withReleaseBlock(once, `${RELEASE_MARKER_START}\nnew\n${RELEASE_MARKER_END}`);
  assert.equal(twice.split(RELEASE_MARKER_START).length - 1, 1);
  assert.ok(twice.includes("new") && !twice.includes("old"));
  assert.ok(twice.startsWith("notes"));
});

test("no release payload means no release edit", async () => {
  const { deps, calls } = mock({});
  await run(inputs, deps);
  assert.equal(calls.releaseUpdates.length, 0);
});

// ---- action-2: registry -----------------------------------------------------------------

test("a verified result is posted to the registry when configured", async () => {
  const { deps, calls } = mock({});
  await run({ ...inputs, registryUrl: "https://registry.example" }, deps);
  assert.equal(calls.registryPosts.length, 1);
  assert.equal(calls.registryPosts[0]!.status, "verified");
});

test("a mismatch is never posted to the registry", async () => {
  const { deps, calls } = mock({ cli: mismatch });
  await run({ ...inputs, registryUrl: "https://registry.example" }, deps);
  assert.equal(calls.registryPosts.length, 0);
});

test("without a registry URL nothing is posted", async () => {
  const { deps, calls } = mock({});
  await run(inputs, deps);
  assert.equal(calls.registryPosts.length, 0);
});

test("a registry outage warns but does not fail a verified build", async () => {
  const { deps, calls } = mock({ registryError: new Error("registry responded 503") });
  await run({ ...inputs, registryUrl: "https://registry.example" }, deps);
  assert.deepEqual(calls.failed, []);
  assert.match(calls.warned[0]!, /503/);
});
