import {
  Account,
  Group,
  Message,
  terminal,
} from "../../../../packages/contracts/src";
import { Database, now } from "../../../../packages/db/src";
import { accountState } from "../accounts/account-state";
import { remote, remoteCode } from "../common/remote";
import { gateway } from "../gateway/gateway.config";
import { unreachable } from "../groups/group-state";
import { saveMessage } from "./message.persistence";
export class SendWorker {
  busy = new Set<string>();
  constructor(
    private db: Database,
    private signal: AbortSignal,
  ) {}
  async tick() {
    const accounts = await this.db.read().all<Account>("accounts");
    for (const a of accounts)
      if (!this.busy.has(a.id)) {
        this.busy.add(a.id);
        void this.channel(a.id)
          .catch((e) => console.error("send worker", String(e)))
          .finally(() => this.busy.delete(a.id));
      }
  }
  async channel(accountId: string) {
    if (this.signal.aborted) return;
    const m = await this.db.tx(async (s) => {
      const a = await s.get<Account>("accounts", accountId);
      if (!a || a.operation) return null;
      if (
        a.status === "rate_limited" &&
        Date.parse(a.rateLimitedUntil!) <= Date.now()
      )
        await accountState(s, a, "online");
      const queue = (await s.all<Message>("messages"))
        .filter(
          (m) =>
            m.accountId === accountId &&
            ["queued", "accepted", "unknown"].includes(m.deliveryStatus || ""),
        )
        .sort((x, y) => {
          if (x.queueOrder && y.queueOrder) {
            const left = BigInt(x.queueOrder),
              right = BigInt(y.queueOrder);
            return left < right ? -1 : left > right ? 1 : 0;
          }
          return (
            x.createdAt.localeCompare(y.createdAt) || x.id.localeCompare(y.id)
          );
        });
      const next = queue[0];
      if (!next) return null;
      if (next.phase === "requesting") {
        next.deliveryStatus = "unknown";
        next.phase = "confirming";
        await saveMessage(s, next);
        await s.event("inconsistency", {
          kind: "send_response_lost",
          ref: next.id,
          message: "请求响应丢失，持续核实，禁止盲目重发",
        });
        return next;
      }
      if (
        next.phase === "confirming" ||
        next.deliveryStatus === "accepted" ||
        next.deliveryStatus === "unknown"
      )
        return next;
      if (a.status !== "online" || Date.parse(next.notBefore) > Date.now())
        return null;
      const g = await s.get<Group>("groups", next.groupId);
      if (!g || g.status !== "active" || g.closing) {
        next.deliveryStatus = "cancelled";
        next.failCode = "GROUP_UNREACHABLE";
        next.phase = "done";
        await saveMessage(s, next);
        return null;
      }
      next.phase = "requesting";
      next.requestedAt = now();
      await s.put("messages", next);
      return next;
    });
    if (!m || this.signal.aborted) return;
    const group = await this.db.read().get<Group>("groups", m.groupId);
    if (!group) return;
    if (
      m.phase === "confirming" ||
      m.deliveryStatus === "accepted" ||
      m.deliveryStatus === "unknown"
    ) {
      const started = Date.now();
      const r = await remote(
        gateway(),
        `/groups/${group.gatewayGroupId}/messages/by-client-id/${m.clientMsgId}`,
        undefined,
        700,
        this.signal,
      );
      if (this.signal.aborted) return;
      await this.db.tx(async (s) => {
        const current = await s.get<Message>("messages", m.id);
        if (
          !current ||
          ["sent", "failed", "cancelled"].includes(current.deliveryStatus!)
        )
          return;
        if (r.status === 200) {
          current.msgId = r.body.msgId;
          current.sentAt = r.body.sentAt;
          current.deliveryStatus = "sent";
          current.phase = "done";
          await saveMessage(s, current);
        } else if (
          r.status === 404 &&
          current.timeoutAt &&
          started > Date.parse(current.timeoutAt) + 2000
        ) {
          current.deliveryStatus = "failed";
          current.failCode = "NETWORK_TIMEOUT";
          current.phase = "done";
          await saveMessage(s, current);
        }
      });
      return;
    }
    const r = await remote(
      gateway(),
      `/groups/${group.gatewayGroupId}/send`,
      { accountId, clientMsgId: m.clientMsgId, text: m.text },
      6000,
      this.signal,
    );
    if (this.signal.aborted) return;
    await this.db.tx(async (s) => {
      const current = await s.get<Message>("messages", m.id);
      if (
        !current ||
        ["sent", "failed", "cancelled"].includes(current.deliveryStatus!)
      )
        return;
      const a = await s.get<Account>("accounts", accountId);
      const g = await s.get<Group>("groups", m.groupId);
      const code = remoteCode(r);
      if (r.status === 202) {
        current.deliveryStatus = "accepted";
        current.phase = "confirming";
      } else if (r.status === 504 || r.status === 0) {
        current.deliveryStatus = "unknown";
        current.phase = "confirming";
        current.timeoutAt = r.status === 504 ? now() : null;
        if (r.status === 0)
          await s.event("inconsistency", {
            kind: "send_response_lost",
            ref: m.id,
            message: "请求结果未知，正在核实",
          });
      } else if (code === "RATE_LIMITED") {
        if (a && !terminal(a.status))
          await accountState(
            s,
            a,
            "rate_limited",
            new Date(
              Date.now() +
                Number(
                  r.body.retryAfterSeconds ||
                    r.body.error?.retryAfterSeconds ||
                    1,
                ) *
                  1000,
            ).toISOString(),
          );
        current.deliveryStatus = "queued";
        current.phase = "ready";
      } else if (r.status === 503) {
        current.phase = "ready";
        current.notBefore = new Date(Date.now() + 1000).toISOString();
      } else {
        current.deliveryStatus = "failed";
        current.failCode = code;
        current.phase = "done";
        if (a && (code === "ACCOUNT_SUSPENDED" || code === "SESSION_EXPIRED"))
          await accountState(
            s,
            a,
            code === "ACCOUNT_SUSPENDED" ? "suspended" : "session_expired",
          );
        if (g && code === "GROUP_WRITE_FORBIDDEN") await unreachable(s, g);
      }
      await saveMessage(s, current);
    });
  }
}
