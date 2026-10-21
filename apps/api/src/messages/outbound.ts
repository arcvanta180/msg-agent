import { Account, Group, Message } from "../../../../packages/contracts/src";
import { Store, id, now } from "../../../../packages/db/src";
import { fail } from "../common/errors";
import { saveMessage } from "./message.persistence";
export async function outbound(
  s: Store,
  g: Group,
  a: Account,
  text: string,
  source = "operator",
  notBefore = now(),
) {
  if (g.status !== "active" || g.closing) fail(409, "GROUP_UNREACHABLE");
  if (!g.members.some((m) => m.accountId === a.id))
    fail(409, "ACCOUNT_NOT_IN_GROUP");
  if (!["online", "rate_limited"].includes(a.status) || a.operation)
    fail(409, "ACCOUNT_UNAVAILABLE");
  const timestamp = now();
  const m: Message = {
    id: id(),
    revision: 0,
    groupId: g.id,
    msgId: null,
    clientMsgId: id(),
    accountId: a.id,
    senderPlatformUserId: a.platformUserId!,
    isOwn: true,
    text,
    sentAt: timestamp,
    createdAt: timestamp,
    queueOrder: await s.seq(),
    notBefore,
    deliveryStatus: "queued",
    failCode: null,
    phase: "ready",
    source,
  };
  await saveMessage(s, m);
  return m;
}
