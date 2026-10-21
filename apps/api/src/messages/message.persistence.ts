import { Message } from "../../../../packages/contracts/src";
import { Store } from "../../../../packages/db/src";
export async function saveMessage(
  s: Store,
  m: Message,
  type = "message_updated",
) {
  m.revision++;
  await s.put("messages", m);
  await s.event(type, { ...m, message: m });
}
