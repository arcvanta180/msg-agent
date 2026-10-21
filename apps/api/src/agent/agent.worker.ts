import Ajv from "ajv";
import {
  Account,
  AgentRun,
  AgentStep,
  Group,
  Message,
  tools,
} from "../../../../packages/contracts/src";
import { Database, Store, id, now } from "../../../../packages/db/src";
import { required } from "../common/errors";
import { remote, remoteCode, sleep } from "../common/remote";
import { gateway } from "../gateway/gateway.config";
import { outbound } from "../messages/outbound";
const ajv = new Ajv();
const validators = new Map(
  tools.map((t) => [t.name, ajv.compile(t.input_schema)]),
);
const agentUrl = () => process.env.AGENT_URL || "http://localhost:3102";
function clip(text: string, bytes: number) {
  let result = "";
  for (const char of text) {
    if (Buffer.byteLength(result + char) > bytes) break;
    result += char;
  }
  return result;
}
function bounded(result: Record<string, unknown>) {
  if (Buffer.byteLength(JSON.stringify(result)) <= 8192) return result;
  return { truncated: true, summary: clip(JSON.stringify(result), 7600) };
}
const toolError = (code: string, message = code) => ({ code, message });
export class AgentWorker {
  busy = new Set<string>();
  clocks = new Map<string, number>();
  constructor(
    private db: Database,
    private signal: AbortSignal,
  ) {}
  async tick() {
    await this.db.tx(async (s) => {
      const groups = await s.all<Group>("groups");
      const runs = await s.all<AgentRun>("agent_runs");
      const timestamp = Date.now();
      for (const run of runs.filter((r) => r.status === "running")) {
        const last = this.clocks.get(run.id);
        this.clocks.set(run.id, timestamp);
        if (last) {
          run.elapsedMs += Math.min(timestamp - last, 1000);
          await s.put("agent_runs", run);
        }
      }
      const triggers = await s.all<{
        id: string;
        groupId: string;
        msgId: string;
        message: Message;
        runId: string | null;
      }>("agent_triggers");
      for (const g of groups) {
        if (
          !g.agentEnabled ||
          g.status !== "active" ||
          g.closing ||
          runs.some((r) => r.groupId === g.id && r.status === "running")
        )
          continue;
        const pending = triggers.filter((t) => t.groupId === g.id && !t.runId);
        if (!pending.length) continue;
        const ownPlatformUserIds = (await s.all<Account>("accounts"))
          .map((a) => a.platformUserId)
          .filter(Boolean);
        const run: AgentRun = {
          id: id(),
          groupId: g.id,
          status: "running",
          endReason: null,
          summary: null,
          steps: [],
          history: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    groupId: g.id,
                    triggerMessages: pending
                      .map((t) => t.message)
                      .sort(
                        (a, b) =>
                          a.sentAt.localeCompare(b.sentAt) ||
                          a.msgId!.localeCompare(b.msgId!),
                      )
                      .map((m) => ({
                        msgId: m.msgId,
                        senderPlatformUserId: m.senderPlatformUserId,
                        text: m.text,
                        sentAt: m.sentAt,
                      })),
                    policy: { autoKickEnabled: g.autoKickEnabled },
                    ownPlatformUserIds,
                  }),
                },
              ],
            },
          ],
          protocolErrors: 0,
          elapsedMs: 0,
          createdAt: now(),
          effects: {},
        };
        for (const t of pending) {
          t.runId = run.id;
          await s.put("agent_triggers", t);
        }
        await s.put("agent_runs", run);
        runs.push(run);
        this.clocks.set(run.id, timestamp);
        await s.event("agent_run", {
          runId: run.id,
          groupId: g.id,
          status: run.status,
          endReason: null,
        });
      }
    });
    for (const run of await this.db.read().all<AgentRun>("agent_runs"))
      if (run.status === "running" && !this.busy.has(run.id)) {
        this.busy.add(run.id);
        void this.advance(run.id)
          .catch((e) => console.error("agent worker", run.id, String(e)))
          .finally(() => this.busy.delete(run.id));
      }
  }
  async update(
    runId: string,
    fn: (r: AgentRun, s: Store) => Promise<void> | void,
  ) {
    await this.db.tx(async (s) => {
      const r = required(
        await s.get<AgentRun>("agent_runs", runId),
        "RUN_NOT_FOUND",
      );
      await fn(r, s);
      await s.put("agent_runs", r);
      await s.event("agent_run", {
        runId: r.id,
        groupId: r.groupId,
        status: r.status,
        endReason: r.endReason,
      });
    });
  }
  async finish(runId: string, reason: string, summary?: string) {
    await this.update(runId, (r) => {
      r.status =
        reason === "final"
          ? "finished"
          : reason === "cancelled"
            ? "cancelled"
            : reason === "audit_blocked"
              ? "blocked"
              : "failed";
      r.endReason = reason;
      r.summary = summary ?? r.summary;
    });
    this.clocks.delete(runId);
  }
  async advance(runId: string) {
    let run = required(
      await this.db.read().get<AgentRun>("agent_runs", runId),
      "RUN_NOT_FOUND",
    );
    const g = required(
      await this.db.read().get<Group>("groups", run.groupId),
      "GROUP_NOT_FOUND",
    );
    let step = run.steps.at(-1);
    if (!step || step.phase === "done") {
      if (g.status !== "active" || !g.agentEnabled || g.closing)
        return this.finish(runId, "cancelled");
      if (run.elapsedMs >= 60000) return this.finish(runId, "wall_clock");
      if (run.protocolErrors >= 3) return this.finish(runId, "protocol_errors");
      if (run.steps.length >= 12) return this.finish(runId, "budget_exhausted");
      step = {
        index: run.steps.length + 1,
        kind: "protocol_error",
        toolUseId: null,
        name: null,
        input: null,
        resultSummary: "",
        isError: false,
        errorCode: null,
        auditVerdict: null,
        rawResponse: "",
        phase: "requesting",
        auditAttempts: 0,
      };
      await this.update(runId, (r) => {
        r.steps.push(step!);
      });
      const response = await remote(
        agentUrl(),
        "/agent/turn",
        { runId, tools, messages: run.history },
        Math.max(
          1,
          Math.min(
            Number(process.env.TURN_TIMEOUT_MS || 12000),
            60000 - run.elapsedMs,
          ),
        ),
        this.signal,
      );
      if (this.signal.aborted) return;
      await this.update(runId, (r) => {
        const st = r.steps.at(-1)!;
        st.rawResponse = clip(response.raw, 2048);
        st.responseStatus = response.status;
        st.phase = "received";
        (st as AgentStep & { fullResponse?: string }).fullResponse =
          response.raw;
      });
      run = required(
        await this.db.read().get<AgentRun>("agent_runs", runId),
        "RUN_NOT_FOUND",
      );
      step = run.steps.at(-1)!;
    } else if (step.phase === "requesting") {
      await this.update(runId, async (r, s) => {
        r.steps.at(-1)!.phase = "uncertain";
        await s.event("inconsistency", {
          kind: "agent_turn_response_lost",
          ref: r.id,
          message:
            "Agent turn 响应丢失，原协议无按轮查回能力；保留现场等待核实",
        });
      });
      return;
    }
    if (run.elapsedMs >= 60000) return this.finish(runId, "wall_clock");
    if (step.phase === "uncertain") return;
    if (step.phase === "received") {
      let response: any;
      let code = "";
      try {
        response = JSON.parse(
          (step as AgentStep & { fullResponse?: string }).fullResponse ||
            step.rawResponse,
        );
        if (
          step.responseStatus !== 200 ||
          !response ||
          !Array.isArray(response.content) ||
          response.content.length !== 1
        )
          throw Error();
        const block = response.content[0];
        if (response.stop_reason === "end_turn") {
          if (block.type !== "text" || typeof block.text !== "string")
            throw Error();
        } else if (response.stop_reason === "tool_use") {
          if (
            block.type !== "tool_use" ||
            typeof block.id !== "string" ||
            !block.id ||
            typeof block.name !== "string" ||
            !block.input ||
            typeof block.input !== "object" ||
            Array.isArray(block.input)
          )
            throw Error();
        } else throw Error();
      } catch {
        code = step.responseStatus === 0 ? "TURN_TIMEOUT" : "BAD_JSON";
      }
      if (
        !code &&
        response.stop_reason === "tool_use" &&
        run.steps
          .slice(0, -1)
          .some((s) => s.toolUseId === response.content[0].id)
      )
        code = "DUPLICATE_TOOL_USE_ID";
      if (code) {
        await this.protocol(runId, code);
        return;
      }
      const block = response.content[0];
      if (response.stop_reason === "end_turn") {
        await this.update(runId, (r) => {
          const st = r.steps.at(-1)!;
          st.kind = "final";
          st.phase = "done";
          st.resultSummary = block.text.slice(0, 200);
          r.history.push({ role: "assistant", content: [block] });
          r.protocolErrors = 0;
          delete (st as any).fullResponse;
        });
        return this.finish(runId, "final", block.text);
      }
      await this.update(runId, (r) => {
        const st = r.steps.at(-1)!;
        st.kind = "tool_use";
        st.toolUseId = block.id;
        st.name = block.name;
        st.input = block.input;
        st.phase = "executing";
        r.history.push({ role: "assistant", content: [block] });
        delete (st as any).fullResponse;
      });
      run = required(
        await this.db.read().get<AgentRun>("agent_runs", runId),
        "RUN_NOT_FOUND",
      );
      step = run.steps.at(-1)!;
    }
    if (step.phase === "executing") await this.execute(run, step);
  }
  async protocol(runId: string, code: string) {
    await this.update(runId, (r) => {
      const step = r.steps.at(-1)!;
      step.kind = "protocol_error";
      step.toolUseId = null;
      step.name = null;
      step.input = null;
      step.isError = true;
      step.errorCode = code;
      step.resultSummary = code;
      step.phase = "done";
      delete (step as any).fullResponse;
      r.protocolErrors++;
      r.history.push({
        role: "user",
        content: [
          {
            type: "text",
            text: `PROTOCOL_ERROR ${code}: 本轮响应无法使用，请按协议重试`,
          },
        ],
      });
    });
  }
  async result(
    runId: string,
    result: Record<string, unknown>,
    isError = false,
    protocol = false,
  ) {
    result = bounded(result);
    await this.update(runId, (r) => {
      const step = r.steps.at(-1)!;
      step.result = result;
      step.isError = isError;
      step.errorCode = isError ? String(result.code) : null;
      step.resultSummary = JSON.stringify(result).slice(0, 200);
      step.phase = "done";
      r.protocolErrors = protocol ? r.protocolErrors + 1 : 0;
      r.history.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: step.toolUseId,
            content: JSON.stringify(result),
            ...(isError ? { is_error: true } : {}),
          },
        ],
      });
    });
  }
  async audit(run: AgentRun, step: AgentStep, text: string) {
    if (step.auditVerdict === "pass") return true;
    if (step.auditVerdict === "fail") return false;
    for (let attempt = step.auditAttempts; attempt < 3; attempt++) {
      const current = required(
        await this.db.read().get<AgentRun>("agent_runs", run.id),
        "RUN_NOT_FOUND",
      );
      if (current.elapsedMs >= 60000) {
        await this.finish(run.id, "wall_clock");
        return null;
      }
      await this.update(run.id, (r) => {
        r.steps.at(-1)!.auditAttempts = attempt + 1;
      });
      const response = await remote(
        agentUrl(),
        "/agent/audit",
        { text, groupId: run.groupId },
        Math.max(
          1,
          Math.min(
            Number(process.env.AUDIT_TIMEOUT_MS || 3000),
            60000 - current.elapsedMs,
          ),
        ),
        this.signal,
      );
      if (this.signal.aborted) return null;
      if (
        response.status === 200 &&
        ["pass", "fail"].includes(response.body.verdict)
      ) {
        await this.update(run.id, (r) => {
          r.steps.at(-1)!.auditVerdict = response.body.verdict;
        });
        return response.body.verdict === "pass";
      }
      await sleep(100);
    }
    await this.finish(run.id, "audit_blocked");
    return null;
  }
  async execute(run: AgentRun, step: AgentStep) {
    if (this.signal.aborted) return;
    const validator = validators.get(step.name!);
    if (!validator)
      return this.result(run.id, toolError("UNKNOWN_TOOL"), true, true);
    if (!validator(step.input))
      return this.result(
        run.id,
        toolError("INVALID_INPUT", ajv.errorsText(validator.errors)),
        true,
        true,
      );
    const input = step.input!;
    if (step.name === "finish") {
      await this.result(run.id, { ok: true });
      return this.finish(run.id, "final", String(input.summary));
    }
    if (step.name === "get_recent_messages") {
      const list = (await this.db.read().all<Message>("messages"))
        .filter((m) => m.groupId === run.groupId)
        .sort(
          (a, b) =>
            b.sentAt.localeCompare(a.sentAt) || b.id.localeCompare(a.id),
        );
      const limit = Math.min(Number(input.limit), 50);
      let truncated = list.length > limit;
      const messages = list
        .slice(0, limit)
        .reverse()
        .map((m) => {
          if (m.text.length > 500) truncated = true;
          return {
            msgId: m.msgId,
            senderPlatformUserId: m.senderPlatformUserId,
            isOwn: m.isOwn,
            text: m.text.slice(0, 500),
            sentAt: m.sentAt,
          };
        });
      while (
        Buffer.byteLength(JSON.stringify({ messages, truncated })) > 8192
      ) {
        messages.shift();
        truncated = true;
      }
      return this.result(run.id, { messages, truncated });
    }
    if (
      step.name === "send_message" &&
      Object.hasOwn(run.effects, String(input.idempotency_key))
    )
      return this.observe(
        run.id,
        run.effects[String(input.idempotency_key)],
        step,
      );
    let g = required(
      await this.db.read().get<Group>("groups", run.groupId),
      "GROUP_NOT_FOUND",
    );
    if (g.status !== "active" || g.closing)
      return this.result(run.id, toolError("GROUP_UNREACHABLE"), true);
    if (step.name === "kick_user" && !g.autoKickEnabled)
      return this.result(run.id, toolError("POLICY_DENIED"), true);
    const eligible = async () => {
      const accounts = await this.db.read().all<Account>("accounts");
      return g.members
        .filter(
          (m) =>
            m.accountId &&
            (step.name !== "kick_user" ||
              ["admin", "creator"].includes(m.role)),
        )
        .map((m) => accounts.find((a) => a.id === m.accountId))
        .filter(
          (a): a is Account => !!a && a.status === "online" && !a.operation,
        )
        .sort((a, b) => a.id.localeCompare(b.id))[0];
    };
    let account = await eligible();
    if (!account && !step.effectStartedAt)
      return this.result(run.id, toolError("NO_AVAILABLE_ACCOUNT"), true);
    const audit = await this.audit(
      run,
      step,
      step.name === "kick_user"
        ? JSON.stringify({
            action: "kick",
            platform_user_id: input.platform_user_id,
            reason: input.reason,
          })
        : String(input.text),
    );
    if (audit === null) return;
    if (!audit) return this.result(run.id, toolError("AUDIT_REJECTED"), true);
    g = required(
      await this.db.read().get<Group>("groups", run.groupId),
      "GROUP_NOT_FOUND",
    );
    if (g.status !== "active" || g.closing)
      return this.result(run.id, toolError("GROUP_UNREACHABLE"), true);
    if (step.name === "kick_user" && !g.autoKickEnabled)
      return this.result(run.id, toolError("POLICY_DENIED"), true);
    account = await eligible();
    if (!account && !step.effectStartedAt)
      return this.result(
        run.id,
        toolError("SEND_FAILED", "执行前账号已不可用"),
        true,
      );
    if (step.name === "send_message") {
      let messageId: string;
      try {
        messageId = await this.db.tx(async (s) => {
          const r = required(
            await s.get<AgentRun>("agent_runs", run.id),
            "RUN_NOT_FOUND",
          );
          const key = String(input.idempotency_key);
          if (Object.hasOwn(r.effects, key)) return r.effects[key];
          const currentGroup = required(
            await s.get<Group>("groups", g.id),
            "GROUP_NOT_FOUND",
          );
          const currentAccount = required(
            await s.get<Account>("accounts", account!.id),
            "ACCOUNT_NOT_FOUND",
          );
          if (currentAccount.status !== "online") throw Error("SEND_FAILED");
          const message = await outbound(
            s,
            currentGroup,
            currentAccount,
            String(input.text),
            "agent",
          );
          r.effects = { ...r.effects, [key]: message.clientMsgId! };
          r.steps.at(-1)!.clientMsgId = message.clientMsgId!;
          await s.put("agent_runs", r);
          return message.clientMsgId!;
        });
      } catch {
        return this.result(run.id, toolError("SEND_FAILED"), true);
      }
      return this.observe(run.id, messageId, step);
    }
    if (step.name === "kick_user") {
      if (step.effectStartedAt) {
        const members = await remote(
          gateway(),
          `/groups/${g.gatewayGroupId}/members`,
          undefined,
          1000,
          this.signal,
        );
        if (members.status !== 200) return;
        if (
          !(members.body as any[]).some(
            (m) => m.platformUserId === input.platform_user_id,
          )
        )
          return this.result(run.id, { kicked: true });
        if (
          (step as any).kickTimeoutAt &&
          Date.now() - Date.parse((step as any).kickTimeoutAt) > 2100
        )
          return this.result(
            run.id,
            toolError("SEND_FAILED", "网关确认目标仍在群中"),
            true,
          );
        return;
      }
      await this.update(run.id, (r) => {
        r.steps.at(-1)!.effectStartedAt = now();
        r.steps.at(-1)!.executorId = account!.id;
      });
      const response = await remote(
        gateway(),
        `/groups/${g.gatewayGroupId}/kick`,
        {
          byAccountId: account!.id,
          targetPlatformUserId: input.platform_user_id,
        },
        6500,
        this.signal,
      );
      if (this.signal.aborted) return;
      if (response.status === 200) return this.result(run.id, { kicked: true });
      if (response.status === 504) {
        await this.update(run.id, (r) => {
          (r.steps.at(-1)! as any).kickTimeoutAt = now();
        });
        return;
      }
      if (response.status === 0) return;
      const code = remoteCode(response);
      return this.result(
        run.id,
        toolError(
          ["OWNER_LEFT", "NO_PERMISSION"].includes(code) ? code : "SEND_FAILED",
        ),
        true,
      );
    }
  }
  async observe(runId: string, clientMsgId: string, step: AgentStep) {
    const end = step.waitUntil || new Date(Date.now() + 5000).toISOString();
    if (!step.waitUntil)
      await this.update(runId, (r) => {
        r.steps.at(-1)!.waitUntil = end;
      });
    while (!this.signal.aborted) {
      const run = required(
        await this.db.read().get<AgentRun>("agent_runs", runId),
        "RUN_NOT_FOUND",
      );
      if (run.elapsedMs >= 60000) return this.finish(runId, "wall_clock");
      const m = (await this.db.read().all<Message>("messages")).find(
        (m) => m.clientMsgId === clientMsgId,
      );
      if (m) {
        const a = m.accountId
          ? await this.db.read().get<Account>("accounts", m.accountId)
          : null;
        if (a && ["suspended", "session_expired"].includes(a.status))
          return this.result(
            runId,
            toolError("SEND_FAILED", "执行账号已进入终态"),
            true,
          );
        if (["accepted", "sent"].includes(m.deliveryStatus!))
          return this.result(runId, {
            clientMsgId,
            deliveryStatus: m.deliveryStatus,
          });
        if (["failed", "cancelled"].includes(m.deliveryStatus!))
          return this.result(
            runId,
            toolError(
              ["GROUP_WRITE_FORBIDDEN", "GROUP_UNREACHABLE"].includes(
                m.failCode!,
              )
                ? "GROUP_UNREACHABLE"
                : "SEND_FAILED",
              m.failCode!,
            ),
            true,
          );
      }
      if (Date.now() >= Date.parse(end))
        return this.result(runId, toolError("SEND_TIMEOUT"), true);
      await sleep(80);
    }
  }
}
