import { Inject, Injectable } from "@nestjs/common";
import {
  Account,
  AccountStatus,
  canTransition,
} from "../../../../packages/contracts/src";
import { Database, id, now } from "../../../../packages/db/src";
import { fail, required } from "../common/errors";
import { remote, remoteCode } from "../common/remote";
import { gateway } from "../gateway/gateway.config";
import { accountState } from "./account-state";
@Injectable()
export class AccountsService {
  constructor(@Inject(Database) private db: Database) {}
  list() {
    return this.db.read().all<Account>("accounts");
  }
  async change(key: string, to: AccountStatus, expectedFrom?: AccountStatus) {
    const ticket = id();
    const a = await this.db.tx(async (s) => {
      const a = required(
        await s.get<Account>("accounts", key),
        "ACCOUNT_NOT_FOUND",
      );
      const from = expectedFrom ?? a.status;
      if (!canTransition(from, to)) fail(409, "ILLEGAL_TRANSITION");
      if (a.status !== from || a.operation) fail(409, "CAS_CONFLICT");
      a.operation = ticket;
      a.operationTo = to;
      a.operationStartedAt = now();
      a.version++;
      await s.put("accounts", a);
      return a;
    });
    let r: Awaited<ReturnType<typeof remote>> | undefined;
    if (to === "online")
      r = await remote(gateway(), `/accounts/${key}/connect`, {});
    else if (to === "idle" || to === "disconnected")
      r = await remote(gateway(), `/accounts/${key}/disconnect`, {});
    return this.db
      .tx(async (s) => {
        const current = required(
          await s.get<Account>("accounts", key),
          "ACCOUNT_NOT_FOUND",
        );
        if (current.operation !== ticket || current.status !== a.status)
          fail(409, "CAS_CONFLICT");
        if (r && [0, 504].includes(r.status)) {
          await s.event("inconsistency", {
            kind: "account_operation_uncertain",
            ref: key,
            message: "连接操作响应未知，已暂停账号发送并安排安全恢复",
          });
          return { error: remoteCode(r) };
        }
        if (r && r.status !== 200) {
          current.operation = null;
          await s.put("accounts", current);
          const code = remoteCode(r);
          if (code === "ACCOUNT_SUSPENDED" || code === "SESSION_EXPIRED")
            await accountState(
              s,
              current,
              code === "ACCOUNT_SUSPENDED" ? "suspended" : "session_expired",
            );
          return { error: code };
        }
        if (to === "online") current.platformUserId = r!.body.platformUserId;
        await accountState(
          s,
          current,
          to,
          to === "rate_limited"
            ? new Date(Date.now() + 30000).toISOString()
            : null,
        );
        return current;
      })
      .catch(async (error) => {
        await this.db.tx(async (s) => {
          const current = await s.get<Account>("accounts", key);
          if (current?.operation === ticket && (!r || r.status !== 200)) {
            current.operation = null;
            await s.put("accounts", current);
          }
        });
        throw error;
      })
      .then((result) => {
        if ("error" in result) fail(502, "GATEWAY_ERROR", result.error);
        return result;
      });
  }
  async connect(key: string) {
    return this.change(key, "online");
  }
}
