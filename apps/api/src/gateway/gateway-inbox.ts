import {
  Account,
  GatewayEvent,
  Group,
  Message,
  terminal,
} from "../../../../packages/contracts/src";
import { Database, id, now } from "../../../../packages/db/src";
import { accountState } from "../accounts/account-state";
import { remote, sleep } from "../common/remote";
import { gateway } from "../gateway/gateway.config";
import { unreachable } from "../groups/group-state";
import { saveMessage } from "../messages/message.persistence";
interface Inbox {
  id: string;
  event: GatewayEvent;
  receivedAt: string;
  done: boolean;
  error?: string;
  attempts: number;
}
export class GatewayInbox {
  constructor(
    private db: Database,
    private signal: AbortSignal,
  ) {}
  async listen() {
    while (!this.signal.aborted) {
      try {
        const response = await fetch(gateway() + "/events?since=0", {
          signal: this.signal,
        });
        if (!response.ok || !response.body)
          throw new Error(`SSE ${response.status}`);
        let buffer = "";
        const decoder = new TextDecoder();
        for await (const chunk of response.body as any) {
          buffer += decoder.decode(chunk, { stream: true }).replace(/\r/g, "");
          let boundary;
          while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const data = frame
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n");
            if (!data) continue;
            const event = JSON.parse(data) as GatewayEvent;
            if (!/^\d+$/.test(String(event.eventId)) || !event.type) continue;
            await this.db.tx(async (s) => {
              const key = String(event.eventId);
              if (!(await s.get("gateway_events", key)))
                await s.put("gateway_events", {
                  id: key,
                  event,
                  receivedAt: now(),
                  done: false,
                  attempts: 0,
                });
            });
          }
        }
      } catch (error) {
        if (!this.signal.aborted)
          console.error("gateway SSE reconnect", String(error));
      }
      if (!this.signal.aborted) await sleep(500);
    }
  }
  async tick() {
    const pending = (await this.db.read().all<Inbox>("gateway_events"))
      .filter((e) => !e.done && Date.parse(e.receivedAt) < Date.now() - 1100)
      .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    for (const row of pending) {
      if (this.signal.aborted) return;
      try {
        const event = row.event;
        let members: { platformUserId: string }[] | undefined;
        if (["member_joined", "member_left"].includes(event.type)) {
          const r = await remote(
            gateway(),
            `/groups/${event.groupId}/members`,
            undefined,
            1000,
            this.signal,
          );
          if (r.status !== 200) continue;
          members = r.body as any;
        }
        await this.db.tx(async (s) => {
          const inbox = await s.get<Inbox>("gateway_events", row.id);
          if (!inbox || inbox.done) return;
          const accounts = await s.all<Account>("accounts");
          const groups = await s.all<Group>("groups");
          const g = groups.find((g) => g.gatewayGroupId === event.groupId);
          const e = event as any;
          if (event.type === "account_status") {
            const a = accounts.find((a) => a.id === e.accountId);
            if (a && ["suspended", "session_expired"].includes(e.status))
              await accountState(s, a, e.status);
          }
          if (g && members && g.status !== "left") {
            const ids = new Set(members.map((m) => m.platformUserId));
            g.members = g.members.filter((m) => ids.has(m.platformUserId));
            for (const member of members) {
              const account = accounts.find(
                (a) => a.platformUserId === member.platformUserId,
              );
              if (account && terminal(account.status)) continue;
              if (
                !g.members.some(
                  (m) => m.platformUserId === member.platformUserId,
                )
              )
                g.members.push({
                  accountId: account?.id || null,
                  platformUserId: member.platformUserId,
                  role:
                    account?.id === g.creatorAccountId ? "creator" : "member",
                });
            }
            await s.put("groups", g);
            await s.event("group_updated", { groupId: g.id, ...g });
          }
          if (["message_sent", "message_failed"].includes(event.type)) {
            const m = (await s.all<Message>("messages")).find(
              (m) => m.clientMsgId === e.clientMsgId,
            );
            if (m) {
              if (
                event.type === "message_sent" &&
                (m.deliveryStatus !== "sent" || !m.confirmedAt)
              ) {
                m.msgId = e.msgId;
                m.sentAt = e.sentAt;
                m.deliveryStatus = "sent";
                m.failCode = null;
                m.phase = "done";
                m.confirmedAt = inbox.receivedAt;
                await saveMessage(s, m);
              } else if (
                event.type === "message_failed" &&
                !["sent", "failed", "cancelled"].includes(m.deliveryStatus!)
              ) {
                m.deliveryStatus = "failed";
                m.failCode = e.code;
                m.phase = "done";
                await saveMessage(s, m);
                const a = accounts.find((a) => a.id === m.accountId);
                if (e.code === "ACCOUNT_SUSPENDED" && a)
                  await accountState(s, a, "suspended");
                const group = groups.find((g) => g.id === m.groupId);
                if (e.code === "GROUP_WRITE_FORBIDDEN" && group)
                  await unreachable(s, group);
              }
            }
          }
          if (event.type === "message" && g) {
            const list = await s.all<Message>("messages");
            if (!list.some((m) => m.groupId === g.id && m.msgId === e.msgId)) {
              const account = accounts.find(
                (a) => a.platformUserId === e.senderPlatformUserId,
              );
              if (
                account &&
                list.some(
                  (m) =>
                    m.accountId === account.id &&
                    m.groupId === g.id &&
                    !m.msgId &&
                    ["queued", "accepted", "unknown"].includes(
                      m.deliveryStatus!,
                    ),
                )
              )
                return;
              const m: Message = {
                id: id(),
                revision: 0,
                groupId: g.id,
                msgId: e.msgId,
                clientMsgId: null,
                accountId: account?.id || null,
                senderPlatformUserId: e.senderPlatformUserId,
                isOwn: !!account,
                text: e.text,
                sentAt: e.sentAt,
                createdAt: now(),
                notBefore: now(),
                deliveryStatus: account ? "sent" : null,
                failCode: null,
                phase: "done",
                ...(e.mediaUrl ? { mediaUrl: e.mediaUrl } : {}),
              };
              await saveMessage(s, m, "message");
              if (
                !m.isOwn &&
                g.agentEnabled &&
                g.status === "active" &&
                !g.closing
              ) {
                const triggerId = `${g.id}:${m.msgId}`;
                if (!(await s.get("agent_triggers", triggerId)))
                  await s.put("agent_triggers", {
                    id: triggerId,
                    groupId: g.id,
                    msgId: m.msgId,
                    message: m,
                    runId: null,
                  });
              }
            }
          }
          if (inbox.error)
            await s.event("inconsistency", {
              kind: "gateway_event_recovered",
              ref: row.id,
              message: inbox.error,
            });
          inbox.done = true;
          await s.put("gateway_events", inbox);
        });
      } catch (error) {
        console.error("inbox retry", row.id, String(error));
        try {
          await this.db.tx(async (s) => {
            const inbox = await s.get<Inbox>("gateway_events", row.id);
            if (inbox) {
              inbox.error = String(error);
              inbox.attempts++;
              await s.put("gateway_events", inbox);
              await s.event("inconsistency", {
                kind: "gateway_event_failed",
                ref: row.id,
                message: String(error),
              });
            }
          });
        } catch {
          /* replay since=0 is the durable recovery source during DB outage */
        }
      }
    }
  }
}
