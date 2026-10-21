import { Inject, Injectable } from "@nestjs/common";
import { Account, Group, Job } from "../../../../packages/contracts/src";
import { Database, id, now } from "../../../../packages/db/src";
import { fail, required } from "../common/errors";
@Injectable()
export class GroupsService {
  constructor(@Inject(Database) private db: Database) {}
  async list() {
    const s = this.db.read();
    const [groups, agentRuns, sequenceRuns] = await Promise.all([
      s.all<Group>("groups"),
      s.all<any>("agent_runs"),
      s.all<any>("sequence_runs"),
    ]);
    return groups.map((g) => ({
      ...g,
      members: g.status === "left" ? [] : g.members,
      activeAgentRunId:
        agentRuns.find((r) => r.groupId === g.id && r.status === "running")
          ?.id || null,
      activeSequenceRunId:
        sequenceRuns.find((r) => r.groupId === g.id && r.status === "running")
          ?.id || null,
    }));
  }
  async one(key: string) {
    return required(
      (await this.list()).find((g) => g.id === key),
      "GROUP_NOT_FOUND",
    );
  }
  async patch(
    key: string,
    body: Partial<Pick<Group, "agentEnabled" | "autoKickEnabled">>,
  ) {
    return this.db.tx(async (s) => {
      const g = required(await s.get<Group>("groups", key), "GROUP_NOT_FOUND");
      if (body.agentEnabled !== undefined) g.agentEnabled = body.agentEnabled;
      if (body.autoKickEnabled !== undefined)
        g.autoKickEnabled = body.autoKickEnabled;
      await s.put("groups", g);
      await s.event("group_updated", { groupId: g.id, ...g });
      return g;
    });
  }
  async create(creatorAccountId: string, memberAccountIds: string[]) {
    return this.db.tx(async (s) => {
      for (const key of [creatorAccountId, ...memberAccountIds]) {
        const a = await s.get<Account>("accounts", key);
        if (!a || a.status !== "online" || a.operation)
          fail(422, "ACCOUNT_NOT_ONLINE", `账号 ${key} 未在线`);
      }
      const job: Job = {
        id: id(),
        kind: "create",
        status: "running",
        errors: [],
        steps: [],
        phase: "create",
        creatorAccountId,
        memberAccountIds,
        inviteRetries: 0,
        promoteAttempts: 0,
        cursor: 0,
        createdAt: now(),
      };
      await s.put("jobs", job);
      return { jobId: job.id };
    });
  }
  async leave(key: string) {
    return this.db.tx(async (s) => {
      const g = required(await s.get<Group>("groups", key), "GROUP_NOT_FOUND");
      if (g.closing || g.status === "left") fail(409, "GROUP_UNAVAILABLE");
      g.closing = true;
      g.agentEnabled = false;
      await s.put("groups", g);
      const job: Job = {
        id: id(),
        kind: "leave",
        status: "running",
        errors: [],
        steps: [],
        phase: "leave",
        groupId: g.id,
        creatorAccountId: g.creatorAccountId,
        memberAccountIds: g.members
          .filter((m) => m.accountId && m.accountId !== g.creatorAccountId)
          .map((m) => m.accountId!)
          .sort(),
        inviteRetries: 0,
        promoteAttempts: 0,
        cursor: 0,
        createdAt: now(),
      };
      await s.put("jobs", job);
      return { jobId: job.id };
    });
  }
}
