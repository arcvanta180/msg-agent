import {
  Account,
  AccountStatus,
  Group,
  Message,
  canTransition,
  terminal,
} from "../../../../packages/contracts/src";
import { Store } from "../../../../packages/db/src";
import { saveMessage } from "../messages/message.persistence";
export async function accountState(
  s: Store,
  a: Account,
  to: AccountStatus,
  until: string | null = null,
) {
  if (terminal(a.status)) return;
  const from = a.status;
  if (from !== to && !canTransition(from, to)) return;
  a.status = to;
  a.rateLimitedUntil = to === "rate_limited" ? until : null;
  a.version++;
  a.operation = null;
  await s.put("accounts", a);
  if (from !== to)
    await s.event("account_status_changed", { accountId: a.id, from, to });
  if (terminal(to)) {
    for (const group of await s.all<Group>("groups"))
      if (group.members.some((m) => m.accountId === a.id)) {
        group.members = group.members.filter((m) => m.accountId !== a.id);
        await s.put("groups", group);
      }
    for (const m of await s.all<Message>("messages"))
      if (
        m.accountId === a.id &&
        m.deliveryStatus === "queued" &&
        m.phase === "ready"
      ) {
        m.deliveryStatus = "cancelled";
        m.failCode = "ACCOUNT_TERMINAL";
        m.phase = "done";
        await saveMessage(s, m);
      }
    await s.event("account_terminal", { accountId: a.id, status: to });
  }
}
