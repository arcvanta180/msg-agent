import "reflect-metadata";
import { All, Controller, Module, Req, Res } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Request, Response } from "express";
import { Database, createDataSource, id, now } from "../../../packages/db/src";
interface Fault {
  operation: string;
  code: string;
  accountId?: string;
  groupId?: string;
  times?: number;
  land?: boolean;
  settleMs?: number;
  responseDelayMs?: number;
  retryAfterSeconds?: number;
}
interface GatewayState {
  id: string;
  accounts: Record<
    string,
    { online: boolean; terminal?: string; limitedUntil?: number }
  >;
  groups: Record<
    string,
    {
      creator: string;
      members: Record<string, { accountId: string | null; role: string }>;
      invite?: { link: string; readyAt: number; expiresAt: number };
      ownerLeft: boolean;
      unreachable?: boolean;
    }
  >;
  events: any[];
  nextEvent: string;
  messages: any[];
  pending: { due: number; kind: string; data: any }[];
  faults: Fault[];
  settings: {
    sendDelayMs: number;
    joinDelayMs: number;
    inviteReadyMs: number;
    inviteTtlMs: number;
    duplicateEvents: boolean;
    reverseEvents: boolean;
  };
  calls: {
    operation: string;
    at: string;
    body: any;
    groupId?: string;
    accountId?: string;
  }[];
}
const initial = (): GatewayState => ({
  id: "gateway",
  accounts: {},
  groups: {},
  events: [],
  nextEvent: "0",
  messages: [],
  pending: [],
  faults: [],
  settings: {
    sendDelayMs: 300,
    joinDelayMs: 250,
    inviteReadyMs: 0,
    inviteTtlMs: 60000,
    duplicateEvents: false,
    reverseEvents: false,
  },
  calls: [],
});
const platform = (accountId: string) => `platform-${accountId}`;
function emit(s: GatewayState, type: string, data: any) {
  s.nextEvent = (BigInt(s.nextEvent) + 1n).toString();
  s.events.push({ ...data, eventId: s.nextEvent, type });
}
function apply(s: GatewayState, kind: string, data: any) {
  if (kind === "join") {
    const g = s.groups[data.groupId];
    const a = s.accounts[data.accountId];
    if (g && a?.online && !a.terminal) {
      g.members[platform(data.accountId)] = {
        accountId: data.accountId,
        role: "member",
      };
      emit(s, "member_joined", {
        groupId: data.groupId,
        platformUserId: platform(data.accountId),
      });
    }
  }
  if (kind === "send") {
    const g = s.groups[data.groupId];
    if (!g) return;
    if (data.failCode) {
      emit(s, "message_failed", {
        clientMsgId: data.clientMsgId,
        code: data.failCode,
      });
      return;
    }
    const message = {
      groupId: data.groupId,
      clientMsgId: data.clientMsgId,
      msgId: id(),
      sentAt: now(),
      senderPlatformUserId: platform(data.accountId),
      text: data.text,
    };
    s.messages.push(message);
    emit(s, "message_sent", {
      clientMsgId: message.clientMsgId,
      msgId: message.msgId,
      sentAt: message.sentAt,
    });
    emit(s, "message", message);
  }
  if (kind === "kick") {
    const g = s.groups[data.groupId];
    if (g) {
      delete g.members[data.platformUserId];
      emit(s, "member_left", data);
    }
  }
}
let db: Database;
@Controller()
class GatewayController {
  @All("{*path}") async route(@Req() req: Request, @Res() res: Response) {
    if (req.path === "/events" && req.method === "GET")
      return this.stream(req, res);
    const answer = await db.tx(async (store) => {
      let s =
        (await store.get<GatewayState>("mock_state", "gateway")) || initial();
      const result = this.handle(s, req);
      await store.put("mock_state", s);
      return result;
    });
    if (answer.delay) await new Promise((r) => setTimeout(r, answer.delay));
    res.status(answer.status).json(answer.body);
  }
  handle(
    s: GatewayState,
    req: Request,
  ): { status: number; body: any; delay?: number } {
    const p = req.path;
    const b = req.body || {};
    const ok = (body: any = {}, status = 200, delay = 0) => ({
      status,
      body,
      delay,
    });
    const error = (status: number, code: string, extra = {}) => ({
      status,
      body: { code, ...extra },
    });
    if (p === "/health") return ok({ ok: true });
    if (p === "/__state") return ok(s);
    if (p === "/__control" && req.method === "POST") {
      if (Array.isArray(b.faults)) s.faults.push(...b.faults);
      if (b.settings) Object.assign(s.settings, b.settings);
      return ok({ ok: true });
    }
    if (p === "/__inject" && req.method === "POST") {
      const g = s.groups[b.groupId];
      if (!g) return error(404, "GROUP_NOT_FOUND");
      const sender = b.senderPlatformUserId || "external-visitor";
      if (!g.members[sender]) {
        g.members[sender] = { accountId: null, role: "member" };
        emit(s, "member_joined", {
          groupId: b.groupId,
          platformUserId: sender,
        });
      }
      const data = {
        groupId: b.groupId,
        msgId: b.msgId || id(),
        senderPlatformUserId: sender,
        text: b.text || "你好，请介绍一下活动",
        sentAt: b.sentAt || now(),
        ...(b.mediaUrl ? { mediaUrl: b.mediaUrl } : {}),
      };
      s.messages.push(data);
      emit(s, "message", data);
      return ok(data);
    }
    if (p === "/__event" && req.method === "POST") {
      if (b.type === "account_status") {
        const a = s.accounts[b.accountId] || { online: false };
        a.terminal =
          b.status === "suspended" ? "ACCOUNT_SUSPENDED" : "SESSION_EXPIRED";
        a.online = false;
        s.accounts[b.accountId] = a;
        for (const [groupId, g] of Object.entries(s.groups))
          if (g.members[platform(b.accountId)]) {
            delete g.members[platform(b.accountId)];
            emit(s, "member_left", {
              groupId,
              platformUserId: platform(b.accountId),
            });
          }
      }
      emit(s, b.type, b.data || b);
      return ok({ ok: true });
    }
    const accountMatch = /^\/accounts\/([^/]+)\/(connect|disconnect)$/.exec(p);
    const groupMatch =
      /^\/groups\/([^/]+)\/(invite|join|promote|kick|leave|send|members)$/.exec(
        p,
      );
    const queryMatch =
      /^\/groups\/([^/]+)\/messages\/by-client-id\/([^/]+)$/.exec(p);
    const operation =
      accountMatch?.[2] ||
      groupMatch?.[2] ||
      (queryMatch ? "query" : p === "/groups" ? "create" : "unknown");
    const accountId =
      accountMatch?.[1] || b.byAccountId || b.accountId || b.creatorAccountId;
    const groupId = groupMatch?.[1] || queryMatch?.[1];
    s.calls.push({ operation, at: now(), body: b, groupId, accountId });
    const faultIndex = s.faults.findIndex(
      (f) =>
        f.operation === operation &&
        (!f.accountId || f.accountId === accountId) &&
        (!f.groupId || f.groupId === groupId),
    );
    let fault: Fault | undefined;
    if (faultIndex >= 0) {
      fault = { ...s.faults[faultIndex] };
      s.faults[faultIndex].times = (s.faults[faultIndex].times ?? 1) - 1;
      if (s.faults[faultIndex].times! <= 0) s.faults.splice(faultIndex, 1);
    }
    if (
      fault &&
      fault.code !== "PASS" &&
      !(
        operation === "send" &&
        ["NETWORK_TIMEOUT", "MESSAGE_FAILED"].includes(fault.code)
      ) &&
      !(operation === "kick" && fault.code === "NETWORK_TIMEOUT")
    ) {
      const codes: Record<string, number> = {
        RATE_LIMITED: 429,
        ACCOUNT_SUSPENDED: 403,
        SESSION_EXPIRED: 401,
        GROUP_WRITE_FORBIDDEN: 403,
        SENDER_NOT_IN_GROUP: 403,
        ACCOUNT_OFFLINE: 409,
        INVITE_NOT_READY: 409,
        INVITE_EXPIRED: 410,
        ALREADY_MEMBER: 409,
        NOT_MEMBER_YET: 409,
        OWNER_LEFT: 409,
        NO_PERMISSION: 403,
        SERVICE_UNAVAILABLE: 503,
        LEAVE_FAILED: 500,
      };
      if (fault.code === "RATE_LIMITED" && accountId) {
        s.accounts[accountId] ??= { online: true };
        s.accounts[accountId].limitedUntil =
          Date.now() + (fault.retryAfterSeconds || 1) * 1000;
      }
      if (
        ["ACCOUNT_SUSPENDED", "SESSION_EXPIRED"].includes(fault.code) &&
        accountId
      ) {
        s.accounts[accountId] ??= { online: false };
        s.accounts[accountId].terminal = fault.code;
        s.accounts[accountId].online = false;
        for (const [gid, g] of Object.entries(s.groups))
          if (g.members[platform(accountId)]) {
            delete g.members[platform(accountId)];
            emit(s, "member_left", {
              groupId: gid,
              platformUserId: platform(accountId),
            });
          }
      }
      return error(codes[fault.code] || 503, fault.code, {
        retryAfterSeconds: fault.retryAfterSeconds || 1,
        readyAfterMs: fault.settleMs || 300,
      });
    }
    if (accountMatch) {
      const a = (s.accounts[accountId] ??= { online: false });
      if (a.terminal)
        return error(a.terminal === "SESSION_EXPIRED" ? 401 : 403, a.terminal);
      a.online = operation === "connect";
      return ok(
        operation === "connect" ? { platformUserId: platform(accountId) } : {},
      );
    }
    if (operation === "create") {
      const a = s.accounts[accountId];
      if (!a?.online) return error(409, "ACCOUNT_OFFLINE");
      const key = id();
      s.groups[key] = {
        creator: accountId,
        members: { [platform(accountId)]: { accountId, role: "creator" } },
        ownerLeft: false,
      };
      return ok({ groupId: key });
    }
    const g = groupId ? s.groups[groupId] : undefined;
    if (!g) return error(404, "GROUP_NOT_FOUND");
    if (queryMatch) {
      const found = s.messages.find(
        (m) => m.groupId === groupId && m.clientMsgId === queryMatch[2],
      );
      return found
        ? ok({ msgId: found.msgId, sentAt: found.sentAt })
        : error(404, "NOT_FOUND");
    }
    if (operation === "members")
      return ok(
        Object.keys(g.members).map((platformUserId) => ({ platformUserId })),
      );
    if (operation === "invite") {
      g.invite = {
        link: `mock://${groupId}/${id()}`,
        readyAt: Date.now() + s.settings.inviteReadyMs,
        expiresAt: Date.now() + s.settings.inviteTtlMs,
      };
      return ok({
        inviteLink: g.invite.link,
        readyAfterMs: s.settings.inviteReadyMs,
      });
    }
    const a = s.accounts[accountId];
    if (a?.terminal)
      return error(a.terminal === "SESSION_EXPIRED" ? 401 : 403, a.terminal);
    if (!a?.online) return error(409, "ACCOUNT_OFFLINE");
    if (operation === "join") {
      if (g.members[platform(accountId)]) return error(409, "ALREADY_MEMBER");
      if (
        !g.invite ||
        g.invite.link !== b.inviteLink ||
        g.invite.expiresAt < Date.now()
      )
        return error(410, "INVITE_EXPIRED");
      if (g.invite.readyAt > Date.now())
        return error(409, "INVITE_NOT_READY", {
          readyAfterMs: g.invite.readyAt - Date.now(),
        });
      s.pending.push({
        due: Date.now() + s.settings.joinDelayMs,
        kind: "join",
        data: { groupId, accountId },
      });
      return ok({ accepted: true }, 202);
    }
    if (operation === "promote") {
      if (accountId !== g.creator) return error(403, "NO_PERMISSION");
      const target = g.members[platform(b.accountId)];
      if (!target) return error(409, "NOT_MEMBER_YET");
      target.role = "admin";
      return ok();
    }
    if (operation === "leave") {
      if (accountId === g.creator) g.ownerLeft = true;
      delete g.members[platform(accountId)];
      emit(s, "member_left", { groupId, platformUserId: platform(accountId) });
      return ok();
    }
    if (operation === "kick") {
      if (g.ownerLeft) return error(409, "OWNER_LEFT");
      if (!["admin", "creator"].includes(g.members[platform(accountId)]?.role))
        return error(403, "NO_PERMISSION");
      if (fault?.code === "NETWORK_TIMEOUT") {
        if (fault.land !== false)
          s.pending.push({
            due: Date.now() + (fault.settleMs ?? 1000),
            kind: "kick",
            data: { groupId, platformUserId: b.targetPlatformUserId },
          });
        return error(504, "NETWORK_TIMEOUT");
      }
      delete g.members[b.targetPlatformUserId];
      emit(s, "member_left", {
        groupId,
        platformUserId: b.targetPlatformUserId,
      });
      return ok({ kicked: true }, 200, fault?.responseDelayMs || 0);
    }
    if (operation === "send") {
      if (g.unreachable) return error(403, "GROUP_WRITE_FORBIDDEN");
      if (!g.members[platform(accountId)])
        return error(403, "SENDER_NOT_IN_GROUP");
      if (a.limitedUntil && a.limitedUntil > Date.now()) {
        a.limitedUntil = Date.now() + 1000;
        return error(429, "RATE_LIMITED", { retryAfterSeconds: 1 });
      }
      if (fault?.land !== false)
        s.pending.push({
          due: Date.now() + (fault?.settleMs ?? s.settings.sendDelayMs),
          kind: "send",
          data: {
            groupId,
            accountId,
            clientMsgId: b.clientMsgId,
            text: b.text,
            ...(fault?.code === "MESSAGE_FAILED"
              ? { failCode: "GROUP_WRITE_FORBIDDEN" }
              : {}),
          },
        });
      if (fault?.code === "NETWORK_TIMEOUT")
        return error(504, "NETWORK_TIMEOUT");
      return ok({ accepted: true }, 202, fault?.responseDelayMs || 0);
    }
    return error(404, "NOT_FOUND");
  }
  async stream(req: Request, res: Response) {
    let since = String(req.query.since ?? "0");
    if (!/^\d+$/.test(since)) {
      res.status(400).end();
      return;
    }
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    let busy = false;
    const interval = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const s = await db.read().get<GatewayState>("mock_state", "gateway");
        let events =
          s?.events
            .filter((e) => BigInt(e.eventId) > BigInt(since))
            .slice(0, 200) || [];
        if (s?.settings.reverseEvents) events = events.reverse();
        let maximum = BigInt(since);
        for (const event of events) {
          const frame = `id: ${event.eventId}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
          res.write(frame);
          if (s?.settings.duplicateEvents) res.write(frame);
          if (BigInt(event.eventId) > maximum) maximum = BigInt(event.eventId);
        }
        since = String(maximum);
        if (!events.length) res.write(": heartbeat\n\n");
      } catch {
      } finally {
        busy = false;
      }
    }, 100);
    req.on("close", () => clearInterval(interval));
  }
}
@Module({ controllers: [GatewayController] })
class GatewayModule {}
async function main() {
  const source = await createDataSource().initialize();
  db = new Database(source);
  await db.check();
  const app = await NestFactory.create(GatewayModule, {
    logger: ["error", "warn"],
  });
  await app.listen(Number(process.env.MOCK_GATEWAY_PORT || 3101), "0.0.0.0");
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await db.tx(async (store) => {
        const s = await store.get<GatewayState>("mock_state", "gateway");
        if (!s) return;
        const due = s.pending.filter((p) => p.due <= Date.now());
        if (!due.length) return;
        s.pending = s.pending.filter((p) => p.due > Date.now());
        for (const p of due) apply(s, p.kind, p.data);
        await store.put("mock_state", s);
      });
    } catch (e) {
      console.error("mock pending", String(e));
    } finally {
      busy = false;
    }
  }, 50);
  const stop = async () => {
    clearInterval(timer);
    await app.close();
    await source.destroy();
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());
  console.log("Mock Gateway :3101");
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
