/** Slash commands shared by the terminal menu and the command dispatcher. */
export interface Command {
  name: string;
  description: string;
  usage: string;
}

export const COMMANDS: Command[] = [
  {
    name: "help",
    description: "Commands, arguments, and keyboard shortcuts",
    usage: "/help [command]",
  },
  {
    name: "init",
    description:
      "Create workspace guidance without replacing existing instructions",
    usage: "/init",
  },
  {
    name: "cd",
    description: "Choose the workspace for a new session",
    usage: "/cd <directory>",
  },
  {
    name: "status",
    description: "Workspace, session, routing attempts, and quota pools",
    usage: "/status",
  },
  {
    name: "models",
    description: "Discover, browse, or select eligible hosted free models",
    usage: "/models [refresh|auto|provider/model]",
  },
  {
    name: "providers",
    description: "Provider connections, availability, and capabilities",
    usage: "/providers",
  },
  {
    name: "connect",
    description: "Securely connect a provider using its API key",
    usage: "/connect <openrouter|groq>",
  },
  {
    name: "disconnect",
    description: "Remove a saved provider connection and credential",
    usage: "/disconnect <openrouter|groq>",
  },
  {
    name: "route",
    description: "View or set the free-only provider priority",
    usage: "/route [openrouter groq|groq openrouter]",
  },
  {
    name: "params",
    description: "Inspect capabilities or set validated generation parameters",
    usage:
      "/params [set <name> <JSON>|reset <name>|default <name> <JSON>|essential <name> <true|false>]",
  },
  {
    name: "tools",
    description: "Available file, search, patch, and shell tools",
    usage: "/tools",
  },
  {
    name: "permissions",
    description: "Inspect or change workspace tool permissions",
    usage: "/permissions [read|edit|shell|outside] [allow|ask|deny]",
  },
  {
    name: "sessions",
    description: "List durable sessions and their resumable state",
    usage: "/sessions",
  },
  {
    name: "resume",
    description: "Resume a saved session, including interrupted work",
    usage: "/resume [session-id]",
  },
  {
    name: "checkpoint",
    description: "Save or list file hashes and workspace checkpoints",
    usage: "/checkpoint [list|label|resolve <action-id>]",
  },
  {
    name: "diff",
    description: "Review reversible edits made by faac",
    usage: "/diff",
  },
  {
    name: "undo",
    description: "Undo the latest faac file edit after checking for conflicts",
    usage: "/undo",
  },
  {
    name: "sync",
    description:
      "Fetch upstream, validate updates, inspect status, or roll back",
    usage: "/sync [check|status|rollback]",
  },
  {
    name: "doctor",
    description: "Diagnose runtime, credentials, adapters, and connectivity",
    usage: "/doctor [live]",
  },
  {
    name: "config",
    description: "Inspect or update persistent application settings",
    usage: "/config [set <maxSteps|sync.enabled|sync.intervalMinutes> <JSON>]",
  },
  { name: "exit", description: "Save state and close faac", usage: "/exit" },
];

/** A small shell-like tokenizer. Values are never executed as shell code. */
export function parseCommand(
  input: string,
): { name: string; args: string[] } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let started = false;
  for (const char of trimmed.slice(1)) {
    if (escaped) {
      token += char;
      escaped = false;
      started = true;
    } else if (char === "\\" && quote !== "'") {
      escaped = true;
      started = true;
    } else if (quote) {
      if (char === quote) quote = null;
      else token += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) tokens.push(token);
      token = "";
      started = false;
    } else {
      token += char;
      started = true;
    }
  }
  if (quote)
    throw new SyntaxError(
      `Unclosed ${quote} quote. Quote paths containing spaces.`,
    );
  if (escaped) token += "\\";
  if (started) tokens.push(token);
  return { name: (tokens.shift() || "help").toLowerCase(), args: tokens };
}

export function completions(input: string): Command[] {
  const prefix = input.trimStart();
  if (!prefix.startsWith("/") || /\s/.test(prefix.slice(1))) return [];
  return COMMANDS.filter((command) =>
    command.name.startsWith(prefix.slice(1).toLowerCase()),
  );
}

export function commandHelp(name?: string): string {
  if (name) {
    const command = COMMANDS.find(
      (item) => item.name === name.replace(/^\//, ""),
    );
    if (!command)
      return `Unknown command /${name}. Type /help to see available commands.`;
    return `${command.usage}\n${command.description}`;
  }
  return [
    "Commands",
    ...COMMANDS.map(
      (command) =>
        `/${command.name.padEnd(12)} ${command.description}\n  ${command.usage}`,
    ),
    "",
    "Keyboard",
    "Enter send · Ctrl-J or Alt-Enter newline · Tab complete command",
    "Up/Down move between lines or history · Ctrl-P/Ctrl-N history",
    "Left/Right move · Ctrl-A/Ctrl-E line start/end · Ctrl-W delete word",
    "Ctrl-U clear line · Ctrl-L redraw · Ctrl-C cancel work or clear input",
    "Ctrl-D exit on empty input · pasted multiline text stays editable",
    "",
    "/undo only reverses faac-owned file edits; shell commands and external effects cannot be undone.",
  ].join("\n");
}
