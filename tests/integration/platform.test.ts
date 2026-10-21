import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { spawn, ChildProcess } from "node:child_process";
import { once } from "node:events";
import { WebSocket } from "ws";
import { createDataSource, Database, seed } from "../../packages/db/src";
import { DataSource } from "typeorm";
const port = 20000 + (process.pid % 3000) * 10,
  gw = port + 1,
  ag = port + 2;
const base = `http://127.0.0.1:${port}`,
  gateway = `http://127.0.0.1:${gw}`,
  agent = `http://127.0.0.1:${ag}`;
let source: DataSource;
let apiProcess: ChildProcess;
const children: ChildProcess[] = [];
let token = "";
let groupId = "",
  gatewayGroupId = "";
let logs = "";
let adminSource: DataSource;
let databaseName = "";
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(
  fn: () => Promise<T>,
  test: (result: T) => boolean,
  timeout = 12000,
): Promise<T> {
  const end = Date.now() + timeout;
  let value: T;
  while (Date.now() < end) {
    value = await fn();
    if (test(value)) return value;
    await delay(80);
  }
  throw new Error(
    `等待超时: ${JSON.stringify(value!).slice(0, 1800)}\n${logs.slice(-3000)}`,
  );
}
async function request(
  path: string,
  body?: object,
  customToken = token,
  method?: string,
) {
  const r = await fetch(base + "/api" + path, {
    method: method || (body ? "POST" : "GET"),
    headers: {
      "content-type": "application/json",
      ...(customToken ? { authorization: `Bearer ${customToken}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return {
    status: r.status,
    body: await r.json(),
    cookie: r.headers.get("set-cookie")?.split(";")[0],
  };
}
async function control(url: string, body: object) {
  const r = await fetch(url + "/__control", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(r.ok).toBe(true);
}
async function gwState() {
  return (await fetch(gateway + "/__state")).json();
}
async function inject(text: string, extra: object = {}) {
  const r = await fetch(gateway + "/__inject", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ groupId: gatewayGroupId, text, ...extra }),
  });
  return r.json();
}
function start(name: string, extraEnv: Record<string, string> = {}) {
  const child = spawn(process.execPath, [`dist/apps/${name}/src/main.js`], {
    env: {
      ...process.env,
      PORT: String(port),
      MOCK_GATEWAY_PORT: String(gw),
      MOCK_AGENT_PORT: String(ag),
      GATEWAY_URL: gateway,
      AGENT_URL: agent,
      TURN_TIMEOUT_MS: "3000",
      AUDIT_TIMEOUT_MS: "500",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  child.stdout?.on("data", (data) => (logs += String(data)));
  child.stderr?.on("data", (data) => (logs += String(data)));
  return child;
}
async function stop(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM") {
  if (child.exitCode !== null || child.signalCode) return;
  const exited = once(child, "exit");
  child.kill(signal);
  const timeout = setTimeout(() => child.kill("SIGKILL"), 1500);
  await exited;
  clearTimeout(timeout);
}
async function ready() {
  await until(async () => {
    try {
      return (await fetch(base + "/api/health")).ok;
    } catch {
      return false;
    }
  }, Boolean);
}
async function restart(signal: NodeJS.Signals = "SIGKILL") {
  await stop(apiProcess, signal);
  apiProcess = start("api");
  await ready();
}
const tool = (id: string, name: string, input: object) => ({
  body: {
    stop_reason: "tool_use",
    content: [{ type: "tool_use", id, name, input }],
  },
});
async function lastRun(previous?: string) {
  return until(
    async () => (await request(`/groups/${groupId}/agent-runs`)).body as any[],
    (runs) => runs.length > 0 && runs[0].id !== previous,
  ).then((r) => r[0]);
}
async function finished(runId: string) {
  return until(
    async () => (await request(`/agent-runs/${runId}`)).body,
    (r) => r.status !== "running",
    15000,
  );
}
async function send(text: string) {
  const r = await request(`/groups/${groupId}/send`, {
    accountId: "acct-1",
    text,
  });
  expect(r.status).toBe(202);
  return r.body.clientMsgId as string;
}
async function message(clientMsgId: string) {
  const rows = await source.query(
    "SELECT data FROM messages WHERE data->>'clientMsgId'=$1",
    [clientMsgId],
  );
  return rows[0]?.data;
}
beforeAll(async () => {
  adminSource = await createDataSource().initialize();
  databaseName = `msg_agent_test_${process.pid}`;
  await adminSource.query(`CREATE DATABASE ${databaseName}`);
  const original =
    process.env.DATABASE_URL || "postgres://msg:msg@localhost:54329/msg_agent";
  const url = new URL(original);
  url.pathname = "/" + databaseName;
  process.env.DATABASE_URL = url.toString();
  source = await createDataSource().initialize();
  await source.runMigrations();
  await seed(new Database(source));
  start("mock-gateway");
  start("mock-agent");
  apiProcess = start("api");
  await ready();
  await until(async () => {
    try {
      return (
        (await fetch(gateway + "/health")).ok &&
        (await fetch(agent + "/health")).ok
      );
    } catch {
      return false;
    }
  }, Boolean);
  token = (
    await request("/auth/login", { username: "admin", password: "admin" }, "")
  ).body.accessToken;
});
afterAll(async () => {
  for (const child of [...children].reverse()) await stop(child);
  if (source?.isInitialized) await source.destroy();
  if (adminSource?.isInitialized) {
    await adminSource.query(
      `DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`,
    );
    await adminSource.destroy();
  }
});
describe.sequential("真实 PostgreSQL、独立进程与协议验收", () => {
  it("超大 WebSocket 帧只关闭该连接，API 保持可用", async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    socket.on("error", () => {});
    await once(socket, "open");
    const closed = once(socket, "close");
    socket.send("x".repeat(5000));
    await closed;
    expect((await request("/health")).status).toBe(200);
  });
  it("A0 migration 可重复执行，health 与统一验证错误", async () => {
    expect(await source.runMigrations()).toEqual([]);
    expect((await request("/health")).body).toEqual({
      ok: true,
      schemaVersion: 1,
    });
    const r = await request("/auth/login", { username: "admin" });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("VALIDATION_ERROR");
    expect(r.body.error.requestId).toBeTruthy();
    const notices = await request("/inconsistencies");
    expect(notices.status).toBe(200);
    expect(Array.isArray(notices.body)).toBe(true);
  });
  it("B3 viewer 不能写，logout 立即撤销 access", async () => {
    const login = await request(
      "/auth/login",
      { username: "viewer", password: "viewer" },
      "",
    );
    expect(login.body.refreshToken).toBeUndefined();
    expect(login.cookie).toMatch(/^refreshToken=/);
    const denied = await request(
      "/accounts/acct-1/connect",
      {},
      login.body.accessToken,
    );
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe("FORBIDDEN");
    expect(
      (await request("/auth/logout", {}, login.body.accessToken)).status,
    ).toBe(200);
    expect(
      (await request("/accounts", undefined, login.body.accessToken)).status,
    ).toBe(401);
  });
  it("B3 refresh 轮换，重放旧 token 撤销整个会话", async () => {
    const login = await request(
      "/auth/login",
      { username: "viewer", password: "viewer" },
      "",
    );
    const refresh = async (cookie: string) => {
      const r = await fetch(base + "/api/auth/refresh", {
        method: "POST",
        headers: { cookie },
      });
      return {
        status: r.status,
        body: await r.json(),
        cookie: r.headers.get("set-cookie")?.split(";")[0],
      };
    };
    const next = await refresh(login.cookie!);
    expect(next.status).toBe(200);
    expect(next.cookie).not.toBe(login.cookie);
    expect((await refresh(login.cookie!)).status).toBe(401);
    expect(
      (await request("/accounts", undefined, next.body.accessToken)).status,
    ).toBe(401);
    expect((await refresh(next.cookie!)).status).toBe(401);
  });
  it("A1 初始状态、连接、非法转移及 CAS", async () => {
    const initial = await request("/accounts");
    expect(
      initial.body.every(
        (a: any) => a.status === "idle" && a.platformUserId === null,
      ),
    ).toBe(true);
    for (let i = 1; i <= 4; i++)
      expect((await request(`/accounts/acct-${i}/connect`, {})).status).toBe(
        200,
      );
    expect(
      (
        await request("/accounts/acct-1/transition", {
          to: "online",
          expectedFrom: "online",
        })
      ).body.error.code,
    ).toBe("ILLEGAL_TRANSITION");
    const outcomes = await Promise.all(
      [1, 2].map(() =>
        request("/accounts/acct-1/transition", {
          to: "disconnected",
          expectedFrom: "online",
        }),
      ),
    );
    expect(outcomes.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(outcomes.find((r) => r.status === 409)?.body.error.code).toBe(
      "CAS_CONFLICT",
    );
    expect((await request("/accounts/acct-1/connect", {})).status).toBe(200);
  });
  it("A3/B2 异步建群、邀请等待及管理员确认", async () => {
    await control(gateway, {
      settings: { inviteReadyMs: 150, duplicateEvents: true },
    });
    const result = await request("/groups", {
      creatorAccountId: "acct-1",
      memberAccountIds: ["acct-2", "acct-3"],
    });
    expect(result.status).toBe(202);
    const job = await until(
      async () => (await request(`/jobs/${result.body.jobId}`)).body,
      (j) => j.status !== "running",
    );
    expect(job.status).toBe("finished");
    groupId = job.groupId;
    const group = (await request(`/groups/${groupId}`)).body;
    gatewayGroupId = group.gatewayGroupId;
    expect(group.members).toHaveLength(3);
    expect(group.members.find((m: any) => m.accountId === "acct-2").role).toBe(
      "admin",
    );
    expect(group.agentEnabled).toBe(false);
    const state = await gwState();
    expect(
      state.calls.filter((c: any) => c.operation === "promote"),
    ).toHaveLength(1);
  });
  it("S1–S3 202/确认分离、重复事件去重、自发回流合并", async () => {
    await control(gateway, { settings: { sendDelayMs: 700 } });
    const key = await send("可靠消息");
    await until(
      () => message(key),
      (m) => m.deliveryStatus === "accepted",
    );
    const m = await until(
      () => message(key),
      (m) => m.deliveryStatus === "sent",
    );
    await delay(1600);
    const timeline = (await request(`/groups/${groupId}/messages`)).body.items;
    expect(timeline.filter((x: any) => x.msgId === m.msgId)).toHaveLength(1);
    expect(timeline.find((x: any) => x.msgId === m.msgId).isOwn).toBe(true);
    expect((await request(`/groups/${groupId}/agent-runs`)).body).toHaveLength(
      0,
    );
  });
  it("S4 限流期间 send 调用数为零，队列保持 FIFO", async () => {
    await control(gateway, {
      faults: [
        {
          operation: "send",
          accountId: "acct-1",
          code: "RATE_LIMITED",
          retryAfterSeconds: 2,
        },
      ],
      settings: { sendDelayMs: 100 },
    });
    const first = await send("限流第一条");
    await until(
      async () => (await request("/accounts")).body,
      (rows: any[]) =>
        rows.find((a) => a.id === "acct-1").status === "rate_limited",
    );
    const second = await send("限流第二条");
    const count = (await gwState()).calls.filter(
      (c: any) => c.operation === "send",
    ).length;
    await delay(800);
    expect(
      (await gwState()).calls.filter((c: any) => c.operation === "send"),
    ).toHaveLength(count);
    await until(
      () => message(second),
      (m) => m.deliveryStatus === "sent",
    );
    const s = await gwState();
    const landed = s.messages.filter((m: any) =>
      [first, second].includes(m.clientMsgId),
    );
    expect(landed.map((m: any) => m.clientMsgId)).toEqual([first, second]);
  });
  it("504 延迟落地只查询，永不重发", async () => {
    await control(gateway, {
      faults: [
        {
          operation: "send",
          code: "NETWORK_TIMEOUT",
          land: true,
          settleMs: 1500,
        },
      ],
    });
    const key = await send("504 最终落地");
    await until(
      () => message(key),
      (m) => m.deliveryStatus === "unknown",
    );
    await until(
      () => message(key),
      (m) => m.deliveryStatus === "sent",
      5000,
    );
    expect(
      (await gwState()).calls.filter(
        (c: any) => c.operation === "send" && c.body.clientMsgId === key,
      ),
    ).toHaveLength(1);
  });
  it("504 未落地在超过两秒的新查询后失败", async () => {
    await control(gateway, {
      faults: [{ operation: "send", code: "NETWORK_TIMEOUT", land: false }],
    });
    const started = Date.now();
    const key = await send("504 没有落地");
    const m = await until(
      () => message(key),
      (m) => m.deliveryStatus === "failed",
      5000,
    );
    expect(Date.now() - started).toBeGreaterThanOrEqual(2000);
    expect(m.failCode).toBe("NETWORK_TIMEOUT");
    expect(
      (await gwState()).calls.filter(
        (c: any) => c.operation === "send" && c.body.clientMsgId === key,
      ),
    ).toHaveLength(1);
  });
  it("查询 503 时保持 unknown，恢复后收敛", async () => {
    await control(gateway, {
      faults: [
        { operation: "send", code: "NETWORK_TIMEOUT", land: false },
        { operation: "query", code: "SERVICE_UNAVAILABLE", times: 18 },
      ],
    });
    const key = await send("查询暂不可用");
    await until(
      () => message(key),
      (m) => m.deliveryStatus === "unknown",
    );
    await delay(2300);
    expect((await message(key)).deliveryStatus).toBe("unknown");
    await until(
      () => message(key),
      (m) => m.deliveryStatus === "failed",
      5000,
    );
  });
  it("确认先于 202 时不能从 sent 回退", async () => {
    await control(gateway, {
      faults: [
        {
          operation: "send",
          code: "PASS",
          responseDelayMs: 1800,
          settleMs: 30,
        },
      ],
    });
    const key = await send("确认事件先到");
    await until(
      () => message(key),
      (m) => m.deliveryStatus === "sent",
    );
    await delay(2000);
    expect((await message(key)).deliveryStatus).toBe("sent");
  });
  it("A4 快照分页允许同毫秒、迟到历史与新插入，不重不漏", async () => {
    for (let i = 0; i < 6; i++)
      await inject(`分页消息${i}`, { sentAt: "2026-01-01T00:00:00.000Z" });
    await delay(1600);
    const original = (await request(`/groups/${groupId}/messages?limit=100`))
      .body.items;
    const first = (await request(`/groups/${groupId}/messages?limit=2`)).body;
    await inject("分页期间的任意早历史", {
      sentAt: "2025-01-01T00:00:00.000Z",
    });
    let cursor = first.nextCursor;
    const all = [...first.items];
    while (cursor) {
      const p = (
        await request(`/groups/${groupId}/messages?before=${cursor}&limit=2`)
      ).body;
      all.push(...p.items);
      cursor = p.nextCursor;
    }
    expect(new Set(all.map((m: any) => m.id)).size).toBe(original.length);
    expect(all.map((m: any) => m.id)).toEqual(original.map((m: any) => m.id));
  });
  it("A2 数据库事件写入失败会重试且发送 inconsistency", async () => {
    await source.query(
      "CREATE FUNCTION reject_test_message() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.data->>'text'='数据库故障消息' THEN RAISE EXCEPTION 'injected DB failure'; END IF; RETURN NEW; END $$",
    );
    await source.query(
      "CREATE TRIGGER reject_test BEFORE INSERT OR UPDATE ON messages FOR EACH ROW EXECUTE FUNCTION reject_test_message()",
    );
    const msg = await inject("数据库故障消息");
    await delay(1800);
    expect(
      (await source.query("SELECT * FROM ui_events WHERE type='inconsistency'"))
        .length,
    ).toBeGreaterThan(0);
    await source.query("DROP TRIGGER reject_test ON messages");
    await source.query("DROP FUNCTION reject_test_message()");
    await until(
      async () =>
        (await request(`/groups/${groupId}/messages?limit=100`)).body.items,
      (items: any[]) => items.some((m) => m.msgId === msg.msgId),
    );
  });
  it("B4 WS 先认证，seq 递增，断线补发不重", async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await once(socket, "open");
    const frames: any[] = [];
    socket.on("message", (raw) => frames.push(JSON.parse(String(raw))));
    await delay(200);
    expect(frames).toHaveLength(0);
    socket.send(
      JSON.stringify({ type: "auth", accessToken: token, sinceSeq: "0" }),
    );
    socket.send(
      JSON.stringify({ type: "auth", accessToken: token, sinceSeq: "0" }),
    );
    await until(
      async () => frames,
      (f) => f.filter((e) => e.seq).length > 0,
    );
    expect(frames.filter((e) => e.type === "auth" && e.success)).toHaveLength(
      1,
    );
    const batch = frames.filter((e) => e.seq);
    expect(
      batch.every(
        (e, i) => i === 0 || BigInt(e.seq) > BigInt(batch[i - 1].seq),
      ),
    ).toBe(true);
    const last = batch.at(-1).seq;
    socket.close();
    await once(socket, "close");
    await inject("断线期间的消息");
    await delay(1500);
    const reconnect = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await once(reconnect, "open");
    const resumed: any[] = [];
    reconnect.on("message", (raw) => resumed.push(JSON.parse(String(raw))));
    reconnect.send(
      JSON.stringify({ type: "auth", accessToken: token, sinceSeq: last }),
    );
    await until(
      async () => resumed,
      (r) => r.some((e) => e.payload?.message?.text === "断线期间的消息"),
      3000,
    );
    expect(
      resumed.filter((e) => e.seq).every((e) => BigInt(e.seq) > BigInt(last)),
    ).toBe(true);
    reconnect.close();
    await once(reconnect, "close");
  });
  it("S6 坏 JSON → 未知工具 → 正常结束，步骤可查", async () => {
    await control(agent, {
      script: [
        { raw: "```json\n{}\n```" },
        tool("u2", "unknown_tool", {}),
        {
          body: {
            stop_reason: "end_turn",
            content: [{ type: "text", text: "协议恢复完成" }],
          },
        },
      ],
    });
    await request(`/groups/${groupId}`, { agentEnabled: true }, token, "PATCH");
    await inject("触发异常协议");
    const run = await lastRun();
    const done = await finished(run.id);
    expect(done.endReason).toBe("final");
    expect(done.steps.map((s: any) => s.kind)).toEqual([
      "protocol_error",
      "tool_use",
      "final",
    ]);
    expect(done.steps[0].errorCode).toBe("BAD_JSON");
    expect(done.steps[1].errorCode).toBe("UNKNOWN_TOOL");
    expect(
      done.steps.every((s: any) => typeof s.rawResponse === "string"),
    ).toBe(true);
  });
  it("S5 相同 key 第二次发送复用消息且不再审计", async () => {
    const previous = (await request(`/groups/${groupId}/agent-runs`)).body[0]
      .id;
    await control(gateway, {
      faults: [
        {
          operation: "send",
          code: "NETWORK_TIMEOUT",
          land: true,
          settleMs: 1500,
        },
      ],
    });
    await control(agent, {
      script: [
        tool("s1", "send_message", {
          text: "Agent 幂等消息",
          idempotency_key: "__proto__",
        }),
        tool("s2", "send_message", {
          text: "另一个文本也不重发",
          idempotency_key: "__proto__",
        }),
        tool("s3", "finish", { summary: "幂等完成" }),
      ],
    });
    const before = (
      await (await fetch(agent + "/__state")).json()
    ).calls.filter((c: any) => c.operation === "audit").length;
    await inject("触发幂等");
    const run = await lastRun(previous);
    const done = await finished(run.id);
    expect(done.endReason).toBe("final");
    expect(done.steps[0].result.clientMsgId).toBe(
      done.steps[1].result.clientMsgId,
    );
    expect(done.steps[1].result.deliveryStatus).toBe("sent");
    expect(
      (await gwState()).messages.filter(
        (m: any) => m.text === "Agent 幂等消息",
      ),
    ).toHaveLength(1);
    expect(
      (await (await fetch(agent + "/__state")).json()).calls.filter(
        (c: any) => c.operation === "audit",
      ),
    ).toHaveLength(before + 1);
  });
  it("审计三次无结论则 blocked，工具无外部效果", async () => {
    const previous = (await request(`/groups/${groupId}/agent-runs`)).body[0]
      .id;
    await control(agent, {
      script: [
        tool("a1", "send_message", {
          text: "不应发出",
          idempotency_key: "audit-blocked",
        }),
      ],
      audits: [
        { raw: "oops" },
        { body: { verdict: "maybe" } },
        { status: 500 },
      ],
    });
    await inject("触发审计阻塞");
    const run = await lastRun(previous);
    const done = await finished(run.id);
    expect(done.status).toBe("blocked");
    expect(done.endReason).toBe("audit_blocked");
    expect(done.steps[0].auditAttempts).toBe(3);
    expect(
      (await gwState()).messages.some((m: any) => m.text === "不应发出"),
    ).toBe(false);
  });
  it("审计 fail 不占 key，后续通过后可发送", async () => {
    const previous = (await request(`/groups/${groupId}/agent-runs`)).body[0]
      .id;
    await control(agent, {
      script: [
        tool("r1", "send_message", {
          text: "拒绝后重试",
          idempotency_key: "reject-key",
        }),
        tool("r2", "send_message", {
          text: "拒绝后重试",
          idempotency_key: "reject-key",
        }),
        tool("r3", "finish", { summary: "完成" }),
      ],
      audits: [{ body: { verdict: "fail" } }, { body: { verdict: "pass" } }],
    });
    await inject("触发审计拒绝");
    const done = await finished((await lastRun(previous)).id);
    expect(done.steps[0].errorCode).toBe("AUDIT_REJECTED");
    expect(done.steps[1].isError).toBe(false);
  });
  it("重复 tool_use.id 不执行工具，连续三次协议错误收敛", async () => {
    const previous = (await request(`/groups/${groupId}/agent-runs`)).body[0]
      .id;
    await control(agent, {
      script: [
        tool("dup", "get_recent_messages", { limit: 100000 }),
        tool("dup", "get_recent_messages", { limit: 1 }),
        { raw: "bad" },
        { raw: "bad" },
      ],
    });
    await inject("重复工具 ID");
    const done = await finished((await lastRun(previous)).id);
    expect(done.endReason).toBe("protocol_errors");
    expect(done.steps[1].errorCode).toBe("DUPLICATE_TOOL_USE_ID");
    expect(done.steps[0].result.messages.length).toBeLessThanOrEqual(50);
  });
  it("工具输入 schema 错误、turn 超时均有步骤记录", async () => {
    const previous = (await request(`/groups/${groupId}/agent-runs`)).body[0]
      .id;
    await control(agent, {
      script: [
        tool("invalid", "send_message", { text: 123, idempotency_key: "x" }),
        {
          delayMs: 3500,
          body: {
            stop_reason: "end_turn",
            content: [{ type: "text", text: "迟到响应" }],
          },
        },
        tool("end", "finish", { summary: "恢复结束" }),
      ],
    });
    await inject("测试输入和超时");
    const done = await finished((await lastRun(previous)).id);
    expect(done.steps[0].errorCode).toBe("INVALID_INPUT");
    expect(done.steps[1].errorCode).toBe("TURN_TIMEOUT");
    expect(done.summary).toBe("恢复结束");
  });
  it("12 步预算终止重复读取，结果不超过 8KB", async () => {
    const previous = (await request(`/groups/${groupId}/agent-runs`)).body[0]
      .id;
    await control(agent, {
      script: Array.from({ length: 13 }, (_, i) =>
        tool(`loop-${i}`, "get_recent_messages", { limit: 100000 }),
      ),
    });
    await inject("重复读取预算");
    const done = await finished((await lastRun(previous)).id);
    expect(done.endReason).toBe("budget_exhausted");
    expect(done.steps).toHaveLength(12);
    expect(
      done.steps.every(
        (s: any) => Buffer.byteLength(JSON.stringify(s.result)) <= 8192,
      ),
    ).toBe(true);
  });
  it("kick 默认策略拒绝，通过开关及审计后移除成员", async () => {
    const previous = (await request(`/groups/${groupId}/agent-runs`)).body[0]
      .id;
    await control(agent, {
      script: [
        tool("k1", "kick_user", {
          platform_user_id: "external-kick",
          reason: "测试",
        }),
        tool("k2", "finish", { summary: "完成" }),
      ],
    });
    await inject("策略拒绝", { senderPlatformUserId: "external-kick" });
    const denied = await finished((await lastRun(previous)).id);
    expect(denied.steps[0].errorCode).toBe("POLICY_DENIED");
    const patched = await request(
      `/groups/${groupId}`,
      { autoKickEnabled: true },
      token,
      "PATCH",
    );
    expect(patched.body.agentEnabled).toBe(true);
    expect(patched.body.autoKickEnabled).toBe(true);
    await control(gateway, {
      faults: [
        {
          operation: "kick",
          code: "NETWORK_TIMEOUT",
          land: true,
          settleMs: 1000,
        },
      ],
    });
    await control(agent, {
      script: [
        tool("kick-ok", "kick_user", {
          platform_user_id: "external-kick",
          reason: "已启用策略",
        }),
        tool("kick-end", "finish", { summary: "完成" }),
      ],
    });
    await inject("核实踢人");
    const done = await finished((await lastRun(denied.id)).id);
    expect(done.steps[0].result.kicked).toBe(true);
    expect(
      (await gwState()).groups[gatewayGroupId].members["external-kick"],
    ).toBeUndefined();
  });
  it("Agent 运行中新增触发消息留给下一次 run", async () => {
    const previous = (await request(`/groups/${groupId}/agent-runs`)).body[0]
      .id;
    await control(agent, {
      script: [
        { ...tool("wait", "get_recent_messages", { limit: 10 }), delayMs: 800 },
        tool("finish", "finish", { summary: "批次结束" }),
      ],
    });
    await inject("批次一");
    const first = await lastRun(previous);
    await inject("批次二");
    const second = await until(
      async () => (await request(`/groups/${groupId}/agent-runs`)).body,
      (runs: any[]) =>
        runs.filter(
          (r) =>
            r.id !== first.id &&
            r.id !== previous &&
            r.createdAt > first.createdAt,
        ).length > 0,
    ).then((r: any[]) => r[0]);
    await finished(second.id);
    expect(second.id).not.toBe(first.id);
    const context = JSON.parse(second.history[0].content[0].text);
    expect(context.triggerMessages.some((m: any) => m.text === "批次二")).toBe(
      true,
    );
  });
  it("多实例同时触发只创建一个 running run", async () => {
    const follower = start("api", { PORT: String(port + 3) });
    await until(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${port + 3}/api/health`)).ok;
      } catch {
        return false;
      }
    }, Boolean);
    const previous = (await request(`/groups/${groupId}/agent-runs`)).body[0]
      .id;
    await control(agent, {
      script: [
        {
          ...tool("multi-read", "get_recent_messages", { limit: 10 }),
          delayMs: 700,
        },
        tool("multi-end", "finish", { summary: "多实例完成" }),
      ],
    });
    await inject("多实例触发", { msgId: "multi-instance-unique" });
    const run = await lastRun(previous);
    await inject("重复的同一条触发", { msgId: "multi-instance-unique" });
    await finished(run.id);
    const rows = await source.query(
      "SELECT data FROM agent_triggers WHERE data->>'msgId'='multi-instance-unique'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].data.runId).toBe(run.id);
    await stop(follower);
  });
  it("群不可达停止序列并取消 Agent，账号保持在线", async () => {
    const created = await request("/groups", {
      creatorAccountId: "acct-1",
      memberAccountIds: ["acct-2", "acct-4"],
    });
    const job = await until(
      async () => (await request(`/jobs/${created.body.jobId}`)).body,
      (j) => j.status !== "running",
    );
    expect(job.status).toBe("finished");
    const other = (await request(`/groups/${job.groupId}`)).body;
    await control(agent, {
      script: [
        {
          ...tool("cancel-read", "get_recent_messages", { limit: 10 }),
          delayMs: 800,
        },
        tool("cancel-finish", "finish", { summary: "不应进入此步" }),
      ],
    });
    await request(
      `/groups/${other.id}`,
      { agentEnabled: true },
      token,
      "PATCH",
    );
    await inject("群不可达期间的 Agent", { groupId: other.gatewayGroupId });
    const run = await until(
      async () => (await request(`/groups/${other.id}/agent-runs`)).body,
      (runs: any[]) => runs.length > 0 && runs[0].steps.length > 0,
    ).then((runs: any[]) => runs[0]);
    const seq = await request("/sequences", {
      name: "等待停止的序列",
      steps: [
        {
          index: 1,
          accountRole: "admin",
          text: "不可达后不能发送",
          delaySeconds: 10,
        },
      ],
    });
    const sequenceRun = (
      await request(`/groups/${other.id}/sequence-runs`, {
        sequenceId: seq.body.id,
        vars: {},
        stepVars: {},
      })
    ).body.runId;
    await control(gateway, {
      faults: [
        {
          operation: "send",
          groupId: other.gatewayGroupId,
          code: "GROUP_WRITE_FORBIDDEN",
        },
      ],
    });
    await request(`/groups/${other.id}/send`, {
      accountId: "acct-4",
      text: "触发群不可达",
    });
    await until(
      async () => (await request(`/groups/${other.id}`)).body,
      (g) => g.status === "unreachable",
    );
    expect((await request(`/sequence-runs/${sequenceRun}`)).body.status).toBe(
      "stopped",
    );
    expect((await finished(run.id)).endReason).toBe("cancelled");
    expect(
      (await request("/accounts")).body
        .filter((a: any) => ["acct-1", "acct-2", "acct-4"].includes(a.id))
        .every((a: any) => a.status === "online"),
    ).toBe(true);
  });
  it("S8 全量预检失败，无运行及外部发送；来源继承正确", async () => {
    await request(
      `/groups/${groupId}`,
      { agentEnabled: false },
      token,
      "PATCH",
    );
    const r = await request(`/groups/${groupId}/sequence-runs`, {
      sequenceId: "welcome",
      vars: { event: "活动", time: "明天" },
      stepVars: {},
    });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatchObject({
      code: "UNRESOLVED_PLACEHOLDER",
      stepIndex: 2,
      key: "location",
    });
    const preview = await request("/sequences/welcome/preview", {
      vars: { event: "活动", time: "明天", location: "默认" },
      stepVars: { "2": { location: "新地点", event: "" } },
    });
    expect(preview.body.steps[2].varSources.location).toBe("step:2");
    expect(preview.body.steps[2].resolvedVars.event).toBe("活动");
  });
  it("S7 并发启动只有一个 201，排期按确认时间推进", async () => {
    const def = await request("/sequences", {
      name: "快速序列",
      steps: [
        { index: 1, accountRole: "admin", text: "序列一", delaySeconds: 0 },
        { index: 2, accountRole: "member", text: "序列二", delaySeconds: 1 },
      ],
    });
    const body = { sequenceId: def.body.id, vars: {}, stepVars: {} };
    const results = await Promise.all([
      request(`/groups/${groupId}/sequence-runs`, body),
      request(`/groups/${groupId}/sequence-runs`, body),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const runId = results.find((r) => r.status === 201)!.body.runId;
    const done = await until(
      async () => (await request(`/sequence-runs/${runId}`)).body,
      (r) => r.status !== "running",
    );
    expect(done.status).toBe("finished");
    expect(done.steps.map((s: any) => s.status)).toEqual(["sent", "sent"]);
    expect(
      Date.parse(done.steps[1].scheduledAt) - Date.parse(done.steps[0].sentAt),
    ).toBeGreaterThanOrEqual(1000);
    const [confirmation] = await source.query(
      "SELECT data FROM gateway_events WHERE data->'event'->>'type'='message_sent' AND data->'event'->>'clientMsgId'=$1",
      [done.steps[0].clientMsgId],
    );
    expect(Date.parse(done.steps[1].scheduledAt)).toBe(
      Date.parse(confirmation.data.receivedAt) + 1000,
    );
  });
  it("真实 SIGKILL 后恢复 accepted 消息，不重复发送", async () => {
    await control(gateway, { settings: { sendDelayMs: 2500 } });
    const key = await send("重启恢复消息");
    await until(
      () => message(key),
      (m) => m.deliveryStatus === "accepted",
    );
    await restart();
    await until(
      () => message(key),
      (m) => m.deliveryStatus === "sent",
    );
    expect(
      (await gwState()).calls.filter(
        (c: any) => c.operation === "send" && c.body.clientMsgId === key,
      ),
    ).toHaveLength(1);
  });
  it("真实 SIGKILL 后继续同一 Agent run 和已持久化工具效果", async () => {
    await control(gateway, {
      settings: { sendDelayMs: 100 },
      faults: [
        {
          operation: "send",
          code: "NETWORK_TIMEOUT",
          land: true,
          settleMs: 1500,
        },
      ],
    });
    await request(`/groups/${groupId}`, { agentEnabled: true }, token, "PATCH");
    const previous = (await request(`/groups/${groupId}/agent-runs`)).body[0]
      .id;
    await control(agent, {
      script: [
        tool("recover-send", "send_message", {
          text: "恢复不重复效果",
          idempotency_key: "recover",
        }),
        tool("recover-same", "send_message", {
          text: "恢复不重复效果",
          idempotency_key: "recover",
        }),
        tool("recover-end", "finish", { summary: "恢复完成" }),
      ],
      audits: [{ delayMs: 250, body: { verdict: "pass" } }],
    });
    await inject("Agent 恢复");
    const run = await lastRun(previous);
    await until(
      async () =>
        source.query("SELECT data FROM agent_runs WHERE id=$1", [run.id]),
      (rows) => !!rows[0].data.effects.recover,
    );
    await restart();
    const done = await finished(run.id);
    expect(done.id).toBe(run.id);
    expect(done.endReason).toBe("final");
    expect(
      (await gwState()).messages.filter(
        (m: any) => m.text === "恢复不重复效果",
      ),
    ).toHaveLength(1);
    await request(
      `/groups/${groupId}`,
      { agentEnabled: false },
      token,
      "PATCH",
    );
  });
  it("429 后停机限流过期，序列重排且公共发送管线不能提前发", async () => {
    const def = await request("/sequences", {
      name: "恢复排期",
      steps: [
        {
          index: 1,
          accountRole: "admin",
          text: "恢复排期步骤",
          delaySeconds: 2,
        },
      ],
    });
    await control(gateway, {
      faults: [
        {
          operation: "send",
          accountId: "acct-2",
          code: "RATE_LIMITED",
          retryAfterSeconds: 1,
        },
      ],
    });
    const runId = (
      await request(`/groups/${groupId}/sequence-runs`, {
        sequenceId: def.body.id,
        vars: {},
        stepVars: {},
      })
    ).body.runId;
    await until(
      async () => (await request("/accounts")).body,
      (rows: any[]) =>
        rows.find((a) => a.id === "acct-2").status === "rate_limited",
    );
    await stop(apiProcess, "SIGKILL");
    await delay(1300);
    const count = (await gwState()).calls.filter(
      (c: any) => c.operation === "send" && c.body.text === "恢复排期步骤",
    ).length;
    apiProcess = start("api");
    await ready();
    await delay(900);
    expect(
      (await gwState()).calls.filter(
        (c: any) => c.operation === "send" && c.body.text === "恢复排期步骤",
      ),
    ).toHaveLength(count);
    const run = await until(
      async () => (await request(`/sequence-runs/${runId}`)).body,
      (r) => r.status !== "running",
    );
    expect(run.status).toBe("finished");
  });
  it("SSE 断线和离线身份的旧消息补投不会再次触发 Agent", async () => {
    await stop(apiProcess, "SIGKILL");
    const msg = await inject("停机期间入站");
    apiProcess = start("api");
    await ready();
    await until(
      async () =>
        (await request(`/groups/${groupId}/messages?limit=100`)).body.items,
      (rows: any[]) => rows.some((m) => m.msgId === msg.msgId),
    );
    await request("/accounts/acct-1/transition", {
      to: "disconnected",
      expectedFrom: "online",
    });
    const own = await inject("离线账号旧消息", {
      senderPlatformUserId: "platform-acct-1",
      sentAt: "2020-01-01T00:00:00.000Z",
    });
    try {
      const timeline = await until(
        async () =>
          (await request(`/groups/${groupId}/messages?limit=100`)).body.items,
        (rows: any[]) => rows.some((m) => m.msgId === own.msgId),
      );
      expect(timeline.find((m: any) => m.msgId === own.msgId).isOwn).toBe(true);
    } finally {
      await request("/accounts/acct-1/connect", {});
    }
  });
  it("终态连带事务失败会整体回滚且释放 CAS 预留", async () => {
    await request("/accounts/acct-3/transition", {
      to: "rate_limited",
      expectedFrom: "online",
    });
    const key = (
      await request(`/groups/${groupId}/send`, {
        accountId: "acct-3",
        text: "终态事务回滚验证",
      })
    ).body.clientMsgId;
    await source.query(
      "CREATE FUNCTION reject_cancel() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.data->>'text'='终态事务回滚验证' AND NEW.data->>'deliveryStatus'='cancelled' THEN RAISE EXCEPTION 'rollback cancellation'; END IF; RETURN NEW; END $$",
    );
    await source.query(
      "CREATE TRIGGER reject_cancel_test BEFORE UPDATE ON messages FOR EACH ROW EXECUTE FUNCTION reject_cancel()",
    );
    try {
      expect(
        (
          await request("/accounts/acct-3/transition", {
            to: "suspended",
            expectedFrom: "rate_limited",
          })
        ).status,
      ).toBe(500);
      const account = (await request("/accounts")).body.find(
        (a: any) => a.id === "acct-3",
      );
      expect(account.status).toBe("rate_limited");
      expect(account.operation).toBeNull();
      expect((await message(key)).deliveryStatus).toBe("queued");
      expect(
        (await request(`/groups/${groupId}`)).body.members.some(
          (m: any) => m.accountId === "acct-3",
        ),
      ).toBe(true);
    } finally {
      await source.query("DROP TRIGGER reject_cancel_test ON messages");
      await source.query("DROP FUNCTION reject_cancel()");
    }
    await request("/accounts/acct-3/transition", {
      to: "online",
      expectedFrom: "rate_limited",
    });
    await until(
      () => message(key),
      (m) => m.deliveryStatus === "sent",
    );
  });
  it("终态取消排队消息、移除成员、不能重连", async () => {
    await request("/accounts/acct-3/transition", {
      to: "rate_limited",
      expectedFrom: "online",
    });
    const key = (
      await request(`/groups/${groupId}/send`, {
        accountId: "acct-3",
        text: "终态前排队",
      })
    ).body.clientMsgId;
    await fetch(gateway + "/__event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "account_status",
        accountId: "acct-3",
        status: "suspended",
      }),
    });
    await until(
      () => message(key),
      (m) => m.deliveryStatus === "cancelled",
    );
    expect((await message(key)).failCode).toBe("ACCOUNT_TERMINAL");
    expect(
      (await request(`/groups/${groupId}`)).body.members.some(
        (m: any) => m.accountId === "acct-3",
      ),
    ).toBe(false);
    expect(
      (await request("/accounts/acct-3/connect", {})).body.error.code,
    ).toBe("ILLEGAL_TRANSITION");
  });
  it("非群主退群失败时保留群主，其他账号继续退", async () => {
    await control(gateway, {
      faults: [
        { operation: "leave", accountId: "acct-2", code: "LEAVE_FAILED" },
      ],
    });
    const r = await request(`/groups/${groupId}/leave-all`, {});
    const job = await until(
      async () => (await request(`/jobs/${r.body.jobId}`)).body,
      (j) => j.status !== "running",
    );
    expect(job.status).toBe("failed");
    expect(job.errors[0].step).toBe("leave:acct-2");
    const state = await gwState();
    expect(
      state.groups[gatewayGroupId].members["platform-acct-1"],
    ).toBeTruthy();
    expect(
      state.groups[gatewayGroupId].members["platform-acct-2"],
    ).toBeTruthy();
  });
  it("再次 leave-all 成功，群主最后退出且公开成员为空", async () => {
    const r = await request(`/groups/${groupId}/leave-all`, {});
    const job = await until(
      async () => (await request(`/jobs/${r.body.jobId}`)).body,
      (j) => j.status !== "running",
    );
    expect(job.status).toBe("finished");
    const group = (await request(`/groups/${groupId}`)).body;
    expect(group.status).toBe("left");
    expect(group.members).toEqual([]);
    const leaves = (await gwState()).calls.filter(
      (c: any) => c.operation === "leave" && c.groupId === gatewayGroupId,
    );
    expect(leaves.at(-1).accountId).toBe("acct-1");
  });
  it("schema 落后时新进程拒绝启动", async () => {
    await source.query("UPDATE schema_meta SET version=0");
    const bad = start("api", { PORT: String(port + 9) });
    await once(bad, "exit");
    expect(bad.exitCode).toBe(1);
    await source.query("UPDATE schema_meta SET version=1");
  });
});
