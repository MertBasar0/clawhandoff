export interface OpenClawPluginDefinition {
  id: string;
  name: string;
  description: string;
  register(): void;
}

const clawHandoffPlugin: OpenClawPluginDefinition = {
  id: "clawhandoff",
  name: "ClawHandoff",
  description:
    "Universal local-first MCP bridge for verified multi-agent handoffs across OpenClaw (Gateway & Browser), Agent2Agent (A2A), Codex app-server, and Agent Client Protocol (ACP).",
  register(): void {
    // Static stdio MCP server (./dist/cli.js) and skills (./skills) are registered via openclaw.plugin.json.
  },
};

export default clawHandoffPlugin;
