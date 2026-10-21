import { Database } from "../../../../packages/db/src";
import { AccountRecovery } from "../accounts/account-recovery.worker";
import { AgentWorker } from "../agent/agent.worker";
import { GatewayInbox } from "../gateway/gateway-inbox";
import { JobWorker } from "../groups/jobs.worker";
import { SendWorker } from "../messages/send.worker";
import { SequenceWorker } from "../sequences/sequences.worker";
export async function workers(db: Database) {
  const control = new AbortController();
  const runner = db.source.createQueryRunner();
  await runner.connect();
  let timer: NodeJS.Timeout | undefined;
  let leadership: NodeJS.Timeout | undefined;
  let active = false,
    busy = false;
  let lastCleanup = 0;
  const elect = async () => {
    if (control.signal.aborted || active) return;
    const [row] = await runner.query(
      "SELECT pg_try_advisory_lock(724103) AS acquired",
    );
    if (!row.acquired) return;
    active = true;
    const sequences = new SequenceWorker(db);
    await sequences.recover();
    const accounts = new AccountRecovery(db, control.signal);
    const sends = new SendWorker(db, control.signal);
    const inbox = new GatewayInbox(db, control.signal);
    const jobs = new JobWorker(db, control.signal);
    const agent = new AgentWorker(db, control.signal);
    void inbox.listen();
    timer = setInterval(async () => {
      if (busy || control.signal.aborted) return;
      busy = true;
      try {
        await runner.query("SELECT 1");
        await inbox.tick();
        await accounts.tick();
        await sequences.tick();
        await agent.tick();
        await sends.tick();
        await jobs.tick();
        if (Date.now() - lastCleanup > 60000) {
          lastCleanup = Date.now();
          await db.source.query(
            "DELETE FROM timeline_snapshots WHERE data->>'expiresAt'<$1",
            [new Date().toISOString()],
          );
        }
      } catch (error) {
        console.error("coordinator", String(error));
      } finally {
        busy = false;
      }
    }, 150);
    console.log("worker: PostgreSQL leader acquired");
  };
  // A lost advisory-lock connection must fence the process before it can perform another effect.
  (runner as any).databaseConnection.on("error", () => {
    control.abort();
    console.error("worker lock connection lost; exiting for fencing");
    process.exit(1);
  });
  await elect();
  leadership = setInterval(
    () =>
      void elect().catch((e) => console.error("worker election", String(e))),
    1000,
  );
  return async () => {
    control.abort();
    if (timer) clearInterval(timer);
    if (leadership) clearInterval(leadership);
    await runner.query("SELECT pg_advisory_unlock(724103)").catch(() => {});
    await runner.release();
  };
}
