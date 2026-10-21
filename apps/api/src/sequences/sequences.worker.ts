import {
  Account,
  Group,
  Message,
  SequenceRun,
} from "../../../../packages/contracts/src";
import { Database, now } from "../../../../packages/db/src";
import { outbound } from "../messages/outbound";
export class SequenceWorker {
  constructor(private db: Database) {}
  async recover() {
    await this.db.tx(async (s) => {
      const timestamp = Date.now();
      for (const run of await s.all<SequenceRun>("sequence_runs"))
        if (run.status === "running") {
          const step = run.steps[run.currentStepIndex - 1];
          if (!step) continue;
          const m = step.clientMsgId
            ? (await s.all<Message>("messages")).find(
                (m) => m.clientMsgId === step.clientMsgId,
              )
            : null;
          const unattempted =
            !m || (m.deliveryStatus === "queued" && m.phase === "ready");
          if (
            unattempted &&
            step.scheduledAt &&
            Date.parse(step.scheduledAt) <= timestamp
          ) {
            step.scheduledAt = new Date(
              timestamp + step.delaySeconds * 1000,
            ).toISOString();
            if (m) {
              m.notBefore = step.scheduledAt;
              await s.put("messages", m);
            }
            await s.put("sequence_runs", run);
          }
        }
    });
  }
  async tick() {
    await this.db.tx(async (s) => {
      for (const run of await s.all<SequenceRun>("sequence_runs")) {
        if (run.status !== "running") continue;
        const g = await s.get<Group>("groups", run.groupId);
        if (!g || g.status !== "active" || g.closing) {
          run.status = "stopped";
          await s.put("sequence_runs", run);
          await s.event("sequence_run", { runId: run.id, ...run });
          continue;
        }
        const step = run.steps[run.currentStepIndex - 1];
        let advanceAt: string | null = null;
        let changed = false;
        if (step.clientMsgId) {
          const m = (await s.all<Message>("messages")).find(
            (m) => m.clientMsgId === step.clientMsgId,
          );
          if (!m) continue;
          if (m.deliveryStatus === "sent" && m.confirmedAt) {
            step.status = "sent";
            step.sentAt = m.sentAt;
            advanceAt = m.confirmedAt;
            changed = true;
          } else if (
            m.deliveryStatus === "cancelled" &&
            m.failCode === "ACCOUNT_TERMINAL"
          ) {
            step.status = "skipped";
            step.skippedAt = now();
            step.sentAt = step.skippedAt;
            step.errorCode = m.failCode;
            advanceAt = step.skippedAt;
            changed = true;
          } else if (["failed", "cancelled"].includes(m.deliveryStatus!)) {
            step.status = "failed";
            step.errorCode = m.failCode!;
            run.status =
              m.failCode === "GROUP_UNREACHABLE" ||
              m.failCode === "GROUP_WRITE_FORBIDDEN"
                ? "stopped"
                : "failed";
            changed = true;
          } else if (
            m.deliveryStatus === "accepted" &&
            step.status !== "accepted"
          ) {
            step.status = "accepted";
            changed = true;
          }
        } else if (
          step.scheduledAt &&
          Date.parse(step.scheduledAt) <= Date.now()
        ) {
          const accounts = await s.all<Account>("accounts");
          const candidates = g.members
            .filter(
              (m) =>
                m.accountId &&
                (step.accountRole === "admin"
                  ? ["creator", "admin"].includes(m.role)
                  : m.role === "member"),
            )
            .map((m) => ({
              member: m,
              account: accounts.find((a) => a.id === m.accountId)!,
            }))
            .filter(
              (x) =>
                x.account &&
                ["online", "rate_limited"].includes(x.account.status) &&
                !x.account.operation,
            )
            .sort(
              (a, b) =>
                (step.accountRole === "admin"
                  ? (a.member.role === "admin" ? 0 : 1) -
                    (b.member.role === "admin" ? 0 : 1)
                  : 0) || a.account.id.localeCompare(b.account.id),
            );
          const chosen = candidates.find((x) => x.account.status === "online");
          if (chosen) {
            const m = await outbound(
              s,
              g,
              chosen.account,
              step.text,
              "sequence",
              step.scheduledAt,
            );
            step.clientMsgId = m.clientMsgId;
            changed = true;
          } else if (candidates.length === 0) {
            step.status = "skipped";
            step.skippedAt = now();
            step.sentAt = step.skippedAt;
            advanceAt = step.skippedAt;
            changed = true;
          }
        }
        if (advanceAt) {
          if (run.currentStepIndex >= run.steps.length) run.status = "finished";
          else {
            run.currentStepIndex++;
            const next = run.steps[run.currentStepIndex - 1];
            next.scheduledAt = new Date(
              Date.parse(advanceAt) + next.delaySeconds * 1000,
            ).toISOString();
          }
        }
        if (changed) {
          await s.put("sequence_runs", run);
          await s.event("sequence_run", { runId: run.id, ...run });
        }
      }
    });
  }
}
