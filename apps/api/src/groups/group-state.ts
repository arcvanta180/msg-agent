import {
  Group,
  Message,
  SequenceRun,
} from "../../../../packages/contracts/src";
import { Store } from "../../../../packages/db/src";
import { saveMessage } from "../messages/message.persistence";
export async function unreachable(s: Store, g: Group) {
  if (g.status !== "active") return;
  g.status = "unreachable";
  await s.put("groups", g);
  for (const m of await s.all<Message>("messages"))
    if (
      m.groupId === g.id &&
      m.deliveryStatus === "queued" &&
      m.phase === "ready"
    ) {
      m.deliveryStatus = "cancelled";
      m.failCode = "GROUP_UNREACHABLE";
      m.phase = "done";
      await saveMessage(s, m);
    }
  for (const run of await s.all<SequenceRun>("sequence_runs"))
    if (run.groupId === g.id && run.status === "running") {
      run.status = "stopped";
      await s.put("sequence_runs", run);
      await s.event("sequence_run", { runId: run.id, ...run });
    }
  await s.event("group_updated", { groupId: g.id, ...g });
}
