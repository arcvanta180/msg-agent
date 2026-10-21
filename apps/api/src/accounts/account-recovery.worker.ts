import { Account } from "../../../../packages/contracts/src";
import { Database } from "../../../../packages/db/src";
import { remote, remoteCode } from "../common/remote";
import { gateway } from "../gateway/gateway.config";
import { accountState } from "./account-state";
// connect/disconnect have stable, repeatable effects; stalled reservations can safely resume.
export class AccountRecovery {
  private busy = new Set<string>();
  constructor(
    private db: Database,
    private signal: AbortSignal,
  ) {}
  async tick() {
    for (const account of await this.db.read().all<Account>("accounts"))
      if (
        account.operation &&
        account.operationTo &&
        account.operationStartedAt &&
        Date.now() - Date.parse(account.operationStartedAt) > 7000 &&
        !this.busy.has(account.id)
      ) {
        this.busy.add(account.id);
        void this.recover(account)
          .catch((error) => console.error("account recovery", String(error)))
          .finally(() => this.busy.delete(account.id));
      }
  }
  async recover(account: Account) {
    const to = account.operationTo!;
    let response: Awaited<ReturnType<typeof remote>> | undefined;
    if (to === "online")
      response = await remote(
        gateway(),
        `/accounts/${account.id}/connect`,
        {},
        3000,
        this.signal,
      );
    else if (["idle", "disconnected"].includes(to))
      response = await remote(
        gateway(),
        `/accounts/${account.id}/disconnect`,
        {},
        3000,
        this.signal,
      );
    if (
      this.signal.aborted ||
      (response && [0, 503, 504].includes(response.status))
    )
      return;
    await this.db.tx(async (s) => {
      const current = await s.get<Account>("accounts", account.id);
      if (!current || current.operation !== account.operation) return;
      if (response && response.status !== 200) {
        const code = remoteCode(response);
        if (["ACCOUNT_SUSPENDED", "SESSION_EXPIRED"].includes(code))
          await accountState(
            s,
            current,
            code === "ACCOUNT_SUSPENDED" ? "suspended" : "session_expired",
          );
        else {
          current.operation = null;
          await s.put("accounts", current);
          await s.event("inconsistency", {
            kind: "account_operation_failed",
            ref: current.id,
            message: code,
          });
        }
        return;
      }
      if (to === "online")
        current.platformUserId = response!.body.platformUserId;
      await accountState(
        s,
        current,
        to,
        to === "rate_limited"
          ? new Date(Date.now() + 30000).toISOString()
          : null,
      );
    });
  }
}
