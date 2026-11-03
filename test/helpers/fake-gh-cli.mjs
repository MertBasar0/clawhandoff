#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";

const statePath = process.env.FAKE_GATEWAY_STATE_FILE;
const state =
  statePath && existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};

const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "list") {
  const headIdx = args.indexOf("--head");
  const searchIdx = args.indexOf("--search");
  if (searchIdx >= 0) {
    process.stdout.write(JSON.stringify(state.rivalPrs ?? []));
    process.exit(0);
  }
  const head = headIdx >= 0 ? args[headIdx + 1] : undefined;
  const openPrs = (state.openPrs ?? []).filter((p) => !head || p.headRefName === head);
  process.stdout.write(JSON.stringify(openPrs));
  process.exit(0);
}

process.stderr.write(`Unsupported fake gh args: ${args.join(" ")}\n`);
process.exit(1);
