export const transitions = {
  idle: ["online", "suspended", "session_expired"],
  online: [
    "idle",
    "rate_limited",
    "disconnected",
    "suspended",
    "session_expired",
  ],
  rate_limited: ["online", "disconnected", "suspended", "session_expired"],
  disconnected: ["idle", "online", "suspended", "session_expired"],
  suspended: [],
  session_expired: [],
} as const;
export type AccountStatus = keyof typeof transitions;
export const terminal = (s: string) =>
  s === "suspended" || s === "session_expired";
export const canTransition = (from: AccountStatus, to: string) =>
  (transitions[from] as readonly string[]).includes(to);
export interface Account {
  id: string;
  status: AccountStatus;
  platformUserId: string | null;
  rateLimitedUntil: string | null;
  version: number;
  operation?: string | null;
  operationTo?: AccountStatus;
  operationStartedAt?: string;
}
export interface Member {
  accountId: string | null;
  platformUserId: string;
  role: "creator" | "admin" | "member";
}
export interface Group {
  id: string;
  name: string;
  gatewayGroupId: string;
  status: "active" | "unreachable" | "left";
  creatorAccountId: string;
  agentEnabled: boolean;
  autoKickEnabled: boolean;
  members: Member[];
  closing?: boolean;
}
export type Delivery =
  | "queued"
  | "accepted"
  | "sent"
  | "failed"
  | "unknown"
  | "cancelled";
export interface Message {
  id: string;
  revision: number;
  groupId: string;
  msgId: string | null;
  clientMsgId: string | null;
  accountId: string | null;
  senderPlatformUserId: string;
  isOwn: boolean;
  text: string;
  sentAt: string;
  deliveryStatus: Delivery | null;
  failCode: string | null;
  createdAt: string;
  queueOrder?: string;
  notBefore: string;
  phase: "ready" | "requesting" | "confirming" | "done";
  timeoutAt?: string | null;
  requestedAt?: string;
  confirmedAt?: string;
  source?: string;
  mediaUrl?: string;
}
export interface SequenceDefinition {
  id: string;
  name: string;
  steps: {
    index: number;
    accountRole: "admin" | "member";
    text: string;
    delaySeconds: number;
  }[];
}
export interface SequenceStep {
  index: number;
  accountRole: "admin" | "member";
  text: string;
  delaySeconds: number;
  resolvedVars: Record<string, string>;
  varSources: Record<string, string>;
  status: "pending" | "accepted" | "sent" | "skipped" | "failed";
  scheduledAt: string | null;
  sentAt: string | null;
  clientMsgId: string | null;
  skippedAt?: string;
  errorCode?: string;
}
export interface SequenceRun {
  id: string;
  groupId: string;
  sequenceId: string;
  status: "running" | "finished" | "failed" | "stopped";
  currentStepIndex: number;
  steps: SequenceStep[];
  createdAt: string;
}
export interface AgentStep {
  index: number;
  kind: "tool_use" | "final" | "protocol_error";
  toolUseId: string | null;
  name: string | null;
  input: Record<string, unknown> | null;
  resultSummary: string;
  isError: boolean;
  errorCode: string | null;
  auditVerdict: string | null;
  rawResponse: string;
  phase: "requesting" | "received" | "executing" | "done" | "uncertain";
  responseStatus?: number;
  auditAttempts: number;
  result?: Record<string, unknown>;
  clientMsgId?: string;
  waitUntil?: string;
  effectStartedAt?: string;
  executorId?: string;
}
export type AgentHistory = {
  role: "user" | "assistant";
  content: Record<string, unknown>[];
}[];
export interface AgentRun {
  id: string;
  groupId: string;
  status: "running" | "finished" | "failed" | "blocked" | "cancelled";
  endReason: string | null;
  summary: string | null;
  steps: AgentStep[];
  history: AgentHistory;
  protocolErrors: number;
  elapsedMs: number;
  createdAt: string;
  effects: Record<string, string>;
}
export interface Job {
  id: string;
  kind: "create" | "leave";
  status: "running" | "finished" | "failed";
  errors: { step: string; code: string }[];
  pendingErrors?: { step: string; code: string }[];
  steps: { step: string; status: string }[];
  phase: string;
  creatorAccountId: string;
  memberAccountIds: string[];
  groupId?: string;
  inviteLink?: string;
  readyAt?: string;
  joinStartedAt?: string;
  pendingAccountId?: string;
  inviteRetries: number;
  promoteAttempts: number;
  cursor: number;
  createdAt: string;
  uncertain?: boolean;
}
export interface GatewayEvent {
  eventId: string | number;
  type: string;
  [key: string]: unknown;
}
export interface UiEvent {
  seq: string;
  type: string;
  payload: Record<string, unknown>;
}
export const tools = [
  {
    name: "get_recent_messages",
    description: "读取当前群最近消息",
    input_schema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1 } },
      required: ["limit"],
      additionalProperties: false,
    },
  },
  {
    name: "send_message",
    description: "审计后发送群消息，相同 key 复用原发送",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", minLength: 1, maxLength: 10000 },
        idempotency_key: { type: "string", minLength: 1, maxLength: 200 },
      },
      required: ["text", "idempotency_key"],
      additionalProperties: false,
    },
  },
  {
    name: "kick_user",
    description: "审计后移除成员",
    input_schema: {
      type: "object",
      properties: {
        platform_user_id: { type: "string", minLength: 1, maxLength: 200 },
        reason: { type: "string", maxLength: 2000 },
      },
      required: ["platform_user_id", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "finish",
    description: "结束运行",
    input_schema: {
      type: "object",
      properties: { summary: { type: "string", maxLength: 10000 } },
      required: ["summary"],
      additionalProperties: false,
    },
  },
];
export function mergeMessages(current: Message[], incoming: Message[]) {
  const map = new Map(current.map((m) => [m.id, m]));
  for (const m of incoming) {
    const old = map.get(m.id);
    if (!old || m.revision > old.revision) map.set(m.id, m);
  }
  return [...map.values()].sort(
    (a, b) => b.sentAt.localeCompare(a.sentAt) || b.id.localeCompare(a.id),
  );
}
export function resolveSteps(
  def: SequenceDefinition,
  vars: Record<string, string>,
  stepVars: Record<string, Record<string, string>>,
): SequenceStep[] {
  const values: Record<string, string> = Object.create(null);
  const sources: Record<string, string> = Object.create(null);
  for (const [k, v] of Object.entries(vars))
    if (v !== "") {
      values[k] = v;
      sources[k] = "default";
    }
  return def.steps.map((step) => {
    for (const [k, v] of Object.entries(stepVars[String(step.index)] || {}))
      if (v !== "") {
        values[k] = v;
        sources[k] = `step:${step.index}`;
      }
    const text = step.text.replace(/\{([A-Za-z0-9_]+)\}/g, (_, key: string) => {
      if (values[key] === undefined)
        throw Object.assign(new Error(`第 ${step.index} 步缺少变量 ${key}`), {
          code: "UNRESOLVED_PLACEHOLDER",
          stepIndex: step.index,
          key,
        });
      return values[key];
    });
    return {
      ...step,
      text,
      resolvedVars: { ...values },
      varSources: { ...sources },
      status: "pending",
      scheduledAt: null,
      sentAt: null,
      clientMsgId: null,
    };
  });
}
