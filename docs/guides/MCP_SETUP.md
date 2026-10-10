# MCP setup

MCP was **disabled when this faac workspace was scaffolded**. The repository does not require a CodeGraph server, and faac's runtime does not consume MCP servers. Agents should use available local search/read tools and report unavailable graph capabilities.

The generated `.codex/config.toml` records this opt-out. No `.mcp.json` or `.vscode/mcp.json` was installed. Do not invent those files or run an index installer merely because a generic skill mentions one.

If a maintainer later opts into a server, review its package, version, permissions, and client schema first. Add only the chosen client's configuration, keep credentials outside Git, and verify the client actually loads the server and queries this repository. Local paths must be updated when a checkout moves. Configuration parsing is not proof that a server is running.

CodeGraph installation or index creation is not a prerequisite for normal application development or CI. The project Makefile intentionally provides no automatic index-setup target.
