#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BridgeService } from "./bridge-service.js";
import { loadBridgeConfig } from "./config.js";
import { createBridgeMcpServer } from "./mcp-server.js";

function parseConfigArg(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--config" && typeof argv[i + 1] === "string") {
      return argv[i + 1];
    }
  }
  return undefined;
}

async function main(): Promise<void> {
  const configPath = parseConfigArg(process.argv.slice(2));
  const config = loadBridgeConfig(configPath);
  const service = new BridgeService(config);
  const server = createBridgeMcpServer(service);
  const transport = new StdioServerTransport();

  const shutdown = () => {
    try {
      service.close();
    } catch {
      // Ignore close errors during shutdown.
    }
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  await server.connect(transport);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`agent-bridge-mcp fatal error: ${message}\n`);
  process.exit(1);
});
