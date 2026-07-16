import { execFile } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { captureRepositoryProfile } from "./code-context.mjs";

const execFileAsync = promisify(execFile);

export async function captureRepositorySnapshot(inputPath) {
  const resolvedPath = path.resolve(inputPath || process.cwd());
  const info = await stat(resolvedPath).catch(() => null);
  if (!info?.isDirectory()) {
    throw new Error(`Repository path is not a directory: ${resolvedPath}`);
  }

  const repoPath = await realpath(resolvedPath);
  const packageJson = await readPackageJson(repoPath);
  const [git, context] = await Promise.all([
    gitSnapshot(repoPath),
    captureRepositoryProfile(repoPath),
  ]);
  return {
    repo_path: repoPath,
    repository: {
      name: packageJson?.name || path.basename(repoPath),
      git,
      context,
    },
  };
}

async function readPackageJson(repoPath) {
  try {
    return JSON.parse(await readFile(path.join(repoPath, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

async function gitSnapshot(repoPath) {
  try {
    const [{ stdout: branch }, { stdout: commit }, { stdout: statusOutput }] = await Promise.all([
      execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoPath }),
      execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoPath }),
      execFileAsync("git", ["status", "--porcelain"], { cwd: repoPath }),
    ]);
    return {
      branch: branch.trim(),
      commit: commit.trim(),
      dirty: statusOutput.trim().length > 0,
    };
  } catch {
    return null;
  }
}
