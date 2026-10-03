// Git helpers for isolated task worktrees and exact change fingerprints.
// Every call uses an argv array (no shell) and disables repository hooks.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { sha256 } from "./util.mjs";

const SAFE_CONFIG = ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "core.fsmonitor=false"];

export function git(cwd, args, { env, input, allowFail = false, maxBuffer = 256 * 1024 * 1024 } = {}) {
  const result = spawnSync("git", [...SAFE_CONFIG, ...args], {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
    encoding: "utf8",
    input,
    maxBuffer,
    shell: false
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFail) {
    throw new Error(`git ${args.join(" ")} failed (exit ${result.status}): ${(result.stderr || result.stdout).trim()}`);
  }
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

export function repoInfo(cwd) {
  const top = git(cwd, ["rev-parse", "--show-toplevel"], { allowFail: true });
  if (top.status !== 0) throw new Error(`Not a Git repository: ${cwd}`);
  const root = fs.realpathSync(top.stdout.trim());
  const slug = path.basename(root).replace(/[^a-zA-Z0-9._-]+/g, "-") || "repo";
  const head = git(root, ["rev-parse", "--verify", "HEAD"], { allowFail: true });
  return {
    root,
    repoKey: `${slug}-${sha256(root).slice(0, 12)}`,
    head: head.status === 0 ? head.stdout.trim() : null,
    branch: git(root, ["branch", "--show-current"], { allowFail: true }).stdout.trim() || null
  };
}

export function dirtyState(root) {
  const out = git(root, ["status", "--porcelain=v1", "--untracked-files=all"]).stdout;
  const files = out.split("\n").filter(Boolean).map((line) => ({ code: line.slice(0, 2), path: line.slice(3) }));
  return { dirty: files.length > 0, files };
}

/**
 * Hash of the complete working-tree content (tracked, modified, new files;
 * deletions included; .gitignore respected) without touching the real index.
 */
export function snapshotTree(dir) {
  const tmpIndex = path.join(os.tmpdir(), `ccd-index-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const env = { GIT_INDEX_FILE: tmpIndex };
  try {
    const head = git(dir, ["rev-parse", "--verify", "HEAD"], { allowFail: true });
    if (head.status === 0) git(dir, ["read-tree", "HEAD"], { env });
    git(dir, ["add", "-A", "--", "."], { env });
    return git(dir, ["write-tree"], { env }).stdout.trim();
  } finally {
    fs.rmSync(tmpIndex, { force: true });
  }
}

const IDENT = ["-c", "user.name=codex-claude-director", "-c", "user.email=codex-claude-director@localhost"];

/** Commit an exact tree on top of a parent without moving any branch. */
export function commitTree(root, tree, parent, message) {
  return git(root, [...IDENT, "commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message]).stdout.trim();
}

export function updateRef(root, ref, commit) {
  git(root, ["update-ref", ref, commit]);
}

export function createWorktree(root, { dir, branch, baseCommit }) {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  git(root, ["worktree", "add", "--quiet", "-b", branch, dir, baseCommit]);
  return dir;
}

export function removeWorktree(root, dir) {
  git(root, ["worktree", "remove", "--force", dir], { allowFail: true });
  git(root, ["worktree", "prune"], { allowFail: true });
}

/** Record the worktree state as a commit on the task branch (checkpoint). */
export function checkpoint(worktree, message) {
  const tree = snapshotTree(worktree);
  const headTree = git(worktree, ["rev-parse", "HEAD^{tree}"]).stdout.trim();
  if (tree === headTree) return { committed: false, tree, commit: git(worktree, ["rev-parse", "HEAD"]).stdout.trim() };
  git(worktree, ["add", "-A", "--", "."]);
  git(worktree, [...IDENT, "commit", "--no-verify", "--quiet", "-m", message]);
  return { committed: true, tree, commit: git(worktree, ["rev-parse", "HEAD"]).stdout.trim() };
}

/** Full diff between the task base and an exact tree, plus file summary. */
export function diffAgainstBase(root, baseCommit, tree) {
  const nameStatus = git(root, ["diff", "--name-status", "--no-renames", baseCommit, tree]).stdout
    .split("\n").filter(Boolean).map((line) => {
      const [status, ...rest] = line.split("\t");
      return { status: status[0], path: rest.join("\t") };
    });
  const numstat = git(root, ["diff", "--numstat", "--no-renames", baseCommit, tree]).stdout
    .split("\n").filter(Boolean).map((line) => {
      const [add, del, ...rest] = line.split("\t");
      return { path: rest.join("\t"), added: add === "-" ? null : Number(add), deleted: del === "-" ? null : Number(del), binary: add === "-" };
    });
  const patch = git(root, ["diff", "--binary", "--no-ext-diff", "--no-renames", "--full-index", baseCommit, tree]).stdout;
  const byPath = new Map(numstat.map((n) => [n.path, n]));
  const files = nameStatus.map((f) => ({
    path: f.path,
    change: { A: "added", M: "modified", D: "deleted", T: "type_changed" }[f.status] ?? f.status,
    added: byPath.get(f.path)?.added ?? null,
    deleted: byPath.get(f.path)?.deleted ?? null,
    binary: byPath.get(f.path)?.binary ?? false
  }));
  return { files, patch };
}

/** Read a file from a commit (used to read trusted project config at the base). */
export function showFile(root, commit, file) {
  const r = git(root, ["show", `${commit}:${file}`], { allowFail: true });
  return r.status === 0 ? r.stdout : null;
}
