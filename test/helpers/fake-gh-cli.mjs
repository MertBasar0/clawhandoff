#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";

const statePath = process.env.FAKE_GATEWAY_STATE_FILE;
const state =
  statePath && existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};

const args = process.argv.slice(2);
if (state.ghFailure) {
  process.stderr.write("GitHub request failed\n");
  process.exit(1);
}
if (args[0] === "pr" && args[1] === "view") {
  const prNum = Number(args[2]);
  const fields = args[args.indexOf("--json") + 1].split(",");
  const found = (state.openPrs ?? [])
    .map((p) => ({ isCrossRepository: false, ...p, state: p.state ?? "OPEN" }))
    .find((p) => p.number === prNum);
  if (!found) {
    process.stderr.write("PR not found\n");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(Object.fromEntries(fields.map((key) => [key, found[key]]))));
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "list") {
  const headIdx = args.indexOf("--head");
  const searchIdx = args.indexOf("--search");
  if (searchIdx >= 0) {
    process.stdout.write(JSON.stringify(state.rivalPrs ?? []));
    process.exit(0);
  }
  const head = headIdx >= 0 ? args[headIdx + 1] : undefined;
  const stateIdx = args.indexOf("--state");
  const requestedState = stateIdx >= 0 ? args[stateIdx + 1].toUpperCase() : "OPEN";
  const fields = args[args.indexOf("--json") + 1].split(",");
  const openPrs = (state.openPrs ?? [])
    .map((p) => ({ isCrossRepository: false, ...p, state: p.state ?? "OPEN" }))
    .filter((p) => (!head || p.headRefName === head) && (requestedState === "ALL" || p.state === requestedState))
    .map((p) => Object.fromEntries(fields.map((key) => [key, p[key]])));
  process.stdout.write(JSON.stringify(openPrs));
  process.exit(0);
}

const commitPath = args[0] === "api" ? /^repos\/[^/]+\/[^/]+\/git\/commits\/([0-9a-f]{40})$/.exec(args[1] ?? "") : null;
if (commitPath) {
  const tree = (state.commitTrees ?? {})[commitPath[1]];
  if (!tree) {
    process.stderr.write("Not Found\n");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ sha: commitPath[1], tree: { sha: tree } }));
  process.exit(0);
}

process.stderr.write(`Unsupported fake gh args: ${args.join(" ")}\n`);
process.exit(1);
