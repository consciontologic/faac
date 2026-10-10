export type ProviderId = "openrouter" | "groq";
export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}
export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface Model {
  id: string;
  provider: ProviderId;
  name: string;
  contextWindow: number;
  maxOutput: number;
  supportedParameters: string[];
  inputModalities: string[];
  outputModalities: string[];
  free: {
    eligible: boolean;
    kind: string;
    evidence: string[];
    checkedAt: string;
    reason: string;
  };
  pool: string;
  testedAt?: string;
}
export interface Connection {
  provider: ProviderId;
  enabled: boolean;
  freePlanConfirmed?: boolean;
  connectedAt: string;
}
export interface AdapterSnapshot {
  version: string;
  commit: string;
  createdAt: string;
  endpoints: Record<ProviderId, { models: string; chat: string }>;
  quarantined: Partial<Record<ProviderId, string>>;
  curated: Array<{
    provider: string;
    modelId: string;
    freeType: string;
    poolKey: string;
    [key: string]: unknown;
  }>;
  curatedAt: string;
  fileHashes: Record<string, string>;
}
export interface Config {
  schema: 1;
  connections: Partial<Record<ProviderId, Connection>>;
  route: ProviderId[];
  preferredModel?: string;
  params: Record<string, unknown>;
  essentialParams: string[];
  permissions: {
    read: "allow" | "ask" | "deny";
    edit: "allow" | "ask" | "deny";
    shell: "ask" | "deny";
    outside: "ask" | "deny";
  };
  sync: {
    enabled: boolean;
    intervalMinutes: number;
    remote: string;
    branch?: string;
  };
  maxSteps: number;
}
export interface PendingAction {
  id: string;
  call: ToolCall;
  state: "intent" | "running" | "uncertain" | "completed";
  startedAt: string;
  result?: string;
  beforeHash?: string | null;
  afterHash?: string | null;
  path?: string;
}
export interface EditRecord {
  id: string;
  path: string;
  before: string | null;
  after: string | null;
  beforeHash: string | null;
  afterHash: string | null;
  at: string;
  undone?: boolean;
}
export interface Checkpoint {
  id: string;
  at: string;
  label: string;
  files: Record<string, string | null>;
  git?: string;
}
export interface Session {
  schema: 1;
  id: string;
  workspace: string;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
  objective: string;
  progress: string[];
  remaining: string[];
  state: "idle" | "running" | "cancelled" | "blocked" | "complete";
  params: Record<string, unknown>;
  essentialParams: string[];
  actions: PendingAction[];
  edits: EditRecord[];
  checkpoints: Checkpoint[];
  attempts: Array<{
    at: string;
    provider: ProviderId;
    model: string;
    version: string;
    outcome: string;
    reason?: string;
  }>;
  interrupted?: {
    provider: ProviderId;
    model: string;
    text: string;
    toolCalls: ToolCall[];
  };
  compactions: Array<{
    at: string;
    model: string;
    originalMessages: number;
    summary: string;
    messageIndexes: number[];
  }>;
  activeModel?: string;
  adapterVersion?: string;
  nextRetryAt?: string;
  instructions?: Record<string, string>;
  toolDefinitions?: ToolDefinition[];
  toolPolicy?: {
    permissions: Config["permissions"];
    allowedCommands: string[];
  };
}
export type AgentEvent =
  | { type: "text"; text: string }
  | {
      type: "status" | "fallback" | "warning" | "compaction" | "tool" | "diff";
      text: string;
    }
  | { type: "model"; text: string };
export interface StreamEvent {
  type: "text" | "tool" | "done";
  text?: string;
  call?: ToolCall;
  finishReason?: string;
}
export interface CompletionRequest {
  model: Model;
  messages: Message[];
  tools: ToolDefinition[];
  params: Record<string, unknown>;
  key: string;
  snapshot: AdapterSnapshot;
  signal: AbortSignal;
}
export interface ProviderClient {
  discover(
    provider: ProviderId,
    key: string | undefined,
    snapshot: AdapterSnapshot,
    connection?: Connection,
  ): Promise<Model[]>;
  complete(request: CompletionRequest): AsyncIterable<StreamEvent>;
}
export interface ApprovalRequest {
  kind: "read" | "edit" | "shell" | "outside" | "destructive";
  description: string;
}
export type Approve = (request: ApprovalRequest) => Promise<boolean>;
