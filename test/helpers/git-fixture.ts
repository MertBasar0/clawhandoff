import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface TempGitFixture {
  rootDir: string;
  originBareDir: string;
  workRepoDir: string;
  cleanup: () => void;
  git: (args: string[], cwd?: string) => string;
  commitFile: (relPath: string, content: string, message: string, cwd?: string) => string;
  revParse: (ref: string, cwd?: string) => string;
}

export function createTempGitFixture(): TempGitFixture {
  const rootDir = mkdtempSync(join(tmpdir(), "agent-bridge-git-"));
  const originBareDir = join(rootDir, "origin.git");
  const workRepoDir = join(rootDir, "work");
  mkdirSync(originBareDir, { recursive: true });
  mkdirSync(workRepoDir, { recursive: true });

  const git = (args: string[], cwd = workRepoDir): string =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test Author",
        GIT_AUTHOR_EMAIL: "test@example.invalid",
        GIT_COMMITTER_NAME: "Test Author",
        GIT_COMMITTER_EMAIL: "test@example.invalid",
      },
    }).trim();

  git(["init", "--bare", "--initial-branch=main"], originBareDir);
  git(["init", "--initial-branch=main"], workRepoDir);
  git(["remote", "add", "origin", originBareDir], workRepoDir);

  const commitFile = (
    relPath: string,
    content: string,
    message: string,
    cwd = workRepoDir,
  ): string => {
    const abs = join(cwd, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
    git(["add", relPath], cwd);
    git(["commit", "-m", message], cwd);
    return git(["rev-parse", "HEAD"], cwd);
  };

  const revParse = (ref: string, cwd = workRepoDir): string => git(["rev-parse", ref], cwd);

  const cleanup = () => {
    rmSync(rootDir, { recursive: true, force: true });
  };

  return {
    rootDir,
    originBareDir,
    workRepoDir,
    cleanup,
    git,
    commitFile,
    revParse,
  };
}
