import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, extname, isAbsolute, join } from "node:path";

export function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already exited.
      }
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already exited.
    }
  }
}

export async function terminateProcessTree(child: ChildProcess, timeoutMs = 2_000): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => {
    const onDone = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(onDone, timeoutMs);
    timer.unref?.();
    child.once("close", onDone);
    child.once("exit", onDone);
  });
  killProcessTree(child);
  await exited;
}

function resolveWindowsExecutable(command: string, env: NodeJS.ProcessEnv): string {
  if (extname(command)) return command;
  const pathExts = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((ext) => ext.trim())
    .filter(Boolean);
  if (isAbsolute(command) || command.includes("\\") || command.includes("/")) {
    for (const ext of pathExts) {
      const candidate = `${command}${ext}`;
      if (existsSync(candidate)) return candidate;
    }
    return command;
  }
  const pathDirs = (env.PATH ?? env.Path ?? "")
    .split(delimiter)
    .map((dir) => dir.trim())
    .filter(Boolean);
  for (const dir of pathDirs) {
    for (const ext of pathExts) {
      const candidate = join(dir, `${command}${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  try {
    const out = execFileSync("where.exe", [command], {
      env,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const first = out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (first) return first;
  } catch {
    // Fall back to raw command so spawn reports ENOENT cleanly.
  }
  return command;
}

function quoteCmdArg(arg: string): string {
  if (arg.length === 0) return '""';
  if (!/[\s"&()<>^|%]/.test(arg)) return arg;
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1").replace(/%/g, "%%")}"`;
}

export function resolveStdioSpawnPlan(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[]; windowsVerbatimArguments?: boolean } {
  if (process.platform !== "win32") {
    return { command, args: [...args] };
  }
  // If invoking npx/npm on Windows alongside a Node binary that ships npm-cli.js, invoke node directly without cmd.exe.
  const lowerBase = command.trim().toLowerCase();
  if (lowerBase === "npx" || lowerBase === "npx.cmd") {
    const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js");
    const unixNpmCli = join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npx-cli.js");
    const cliScript = existsSync(npmCli) ? npmCli : existsSync(unixNpmCli) ? unixNpmCli : undefined;
    if (cliScript) {
      return { command: process.execPath, args: [cliScript, ...args] };
    }
  }
  const resolved = resolveWindowsExecutable(command, env);
  if (/\.(cmd|bat)$/i.test(resolved)) {
    const comspec = env.ComSpec ?? "cmd.exe";
    const commandLine = [quoteCmdArg(resolved), ...args.map(quoteCmdArg)].join(" ");
    return {
      command: comspec,
      args: ["/d", "/s", "/c", `"${commandLine}"`],
      windowsVerbatimArguments: true,
    };
  }
  return { command: resolved, args: [...args] };
}

export function spawnStdioProcess(params: {
  command: string;
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): ChildProcess {
  const env = params.env ?? process.env;
  const plan = resolveStdioSpawnPlan(params.command, params.args, env);
  return spawn(plan.command, plan.args, {
    cwd: params.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
    windowsVerbatimArguments: plan.windowsVerbatimArguments,
  });
}
