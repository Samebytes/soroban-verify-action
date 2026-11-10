import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DefaultArtifactClient } from "@actions/artifact";
import * as core from "@actions/core";
import * as github from "@actions/github";
import { run, type CliResult, type Deps } from "./run.js";

function runCli(args: string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    execFile("soroban-verify", args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      // Exit code 1 (mismatch) still prints a valid JSON result on stdout.
      try {
        const parsed = JSON.parse(stdout) as CliResult & { status: string; message?: string };
        if (parsed.status === "verified" || parsed.status === "mismatch") return resolve(parsed);
        return reject(new Error(parsed.message ?? "unknown CLI error"));
      } catch {
        reject(new Error(String(stderr || err?.message || "CLI produced no JSON")));
      }
    });
  });
}

async function main(): Promise<void> {
  const token = core.getInput("github-token", { required: true });
  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;
  // Release, push and dispatch payloads carry no PR or issue: those runs post no comment.
  const pullRequest: number | undefined =
    github.context.payload.pull_request?.number ?? github.context.payload.issue?.number;

  const deps: Deps = {
    runCli,
    listComments: async (issue_number) =>
      // Paginate: the marker comment may be past the first page on a busy PR.
      (
        await octokit.paginate(octokit.rest.issues.listComments, {
          owner,
          repo,
          issue_number,
          per_page: 100,
        })
      ).map((c) => ({ id: c.id, body: c.body ?? "" })),
    createComment: async (issue_number, body) => {
      await octokit.rest.issues.createComment({ owner, repo, issue_number, body });
    },
    updateComment: async (comment_id, body) => {
      await octokit.rest.issues.updateComment({ owner, repo, comment_id, body });
    },
    uploadArtifact: async (name, fileName, content) => {
      const dir = process.env.RUNNER_TEMP ?? ".";
      const file = path.join(dir, fileName);
      await fs.writeFile(file, content);
      await new DefaultArtifactClient().uploadArtifact(name, [file], dir);
    },
    getRelease: async () => {
      const r = github.context.payload.release as { id: number; body?: string | null } | undefined;
      return github.context.eventName === "release" && r ? { id: r.id, body: r.body ?? "" } : null;
    },
    updateReleaseBody: async (release_id, body) => {
      await octokit.rest.repos.updateRelease({ owner, repo, release_id, body });
    },
    postToRegistry: async (result) => {
      const base = core.getInput("registry-url").replace(/\/+$/, "");
      const key = core.getInput("registry-api-key");
      if (key) core.setSecret(key);
      const res = await fetch(`${base}/verifications`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(key ? { "x-api-key": key } : {}) },
        body: JSON.stringify({
          contract_id: result.contract_id,
          repo: result.repo,
          commit: result.commit,
          onchain_hash: result.onchain_hash,
          built_hash: result.built_hash,
          status: result.status,
          source: "action",
        }),
      });
      if (!res.ok) throw new Error(`registry responded ${res.status}`);
    },
    warn: (m) => core.warning(m),
    fail: (m) => core.setFailed(m),
  };

  await run(
    {
      contractId: core.getInput("contract-id", { required: true }),
      repo: core.getInput("repo") || `https://github.com/${owner}/${repo}`,
      commit: core.getInput("commit") || github.context.sha,
      image: core.getInput("image") || undefined,
      registryUrl: core.getInput("registry-url") || undefined,
      pullRequest,
    },
    deps,
  );
}

main().catch((e) => core.setFailed(e instanceof Error ? e.message : String(e)));
