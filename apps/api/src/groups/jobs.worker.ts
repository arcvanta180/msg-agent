import {
  Account,
  Group,
  Job,
  terminal,
} from "../../../../packages/contracts/src";
import { Database, id, now } from "../../../../packages/db/src";
import { required } from "../common/errors";
import { remote, remoteCode } from "../common/remote";
import { gateway } from "../gateway/gateway.config";
export class JobWorker {
  busy = new Set<string>();
  constructor(
    private db: Database,
    private signal: AbortSignal,
  ) {}
  async tick() {
    for (const job of await this.db.read().all<Job>("jobs"))
      if (
        job.status === "running" &&
        !job.uncertain &&
        !this.busy.has(job.id)
      ) {
        this.busy.add(job.id);
        void this.step(job)
          .catch((e) => console.error("job worker", String(e)))
          .finally(() => this.busy.delete(job.id));
      }
  }
  async save(job: Job) {
    await this.db.tx(async (s) => {
      await s.put("jobs", job);
      await s.event("job_updated", { jobId: job.id, ...job });
    });
  }
  async error(job: Job, step: string, code: string) {
    job.errors.push({ step, code });
    job.steps.push({ step, status: "failed" });
    job.status = "failed";
    await this.save(job);
  }
  async intent(job: Job, step: string) {
    job.phase = step;
    await this.save(job);
  }
  async step(job: Job) {
    if (this.signal.aborted) return;
    if (job.phase.endsWith(":requesting")) {
      job.uncertain = true;
      await this.save(job);
      await this.db.tx((s) =>
        s.event("inconsistency", {
          kind: "job_response_lost",
          ref: job.id,
          message: "外部操作结果未知，需人工核实；未自动重试",
        }),
      );
      return;
    }
    if (job.kind === "leave") return this.leave(job);
    if (job.phase === "create") {
      await this.intent(job, "create:requesting");
      const r = await remote(
        gateway(),
        "/groups",
        { creatorAccountId: job.creatorAccountId },
        6000,
        this.signal,
      );
      if (this.signal.aborted) return;
      if (r.status === 0 || r.status === 504) return;
      if (r.status === 503) {
        job.phase = "create";
        await this.save(job);
        return;
      }
      if (r.status !== 200) return this.error(job, "create", remoteCode(r));
      const group: Group = {
        id: id(),
        name: `协作群 ${r.body.groupId.slice(-6)}`,
        gatewayGroupId: r.body.groupId,
        status: "active",
        creatorAccountId: job.creatorAccountId,
        agentEnabled: false,
        autoKickEnabled: false,
        members: [],
      };
      await this.db.tx(async (s) => {
        const a = required(
          await s.get<Account>("accounts", job.creatorAccountId),
          "ACCOUNT_NOT_FOUND",
        );
        if (!terminal(a.status))
          group.members.push({
            accountId: a.id,
            platformUserId: a.platformUserId!,
            role: "creator",
          });
        await s.put("groups", group);
        job.groupId = group.id;
        job.phase = "invite";
        job.steps.push({ step: "create", status: "finished" });
        await s.put("jobs", job);
        await s.event("group_updated", { groupId: group.id, ...group });
      });
      return;
    }
    const g = required(
      await this.db.read().get<Group>("groups", job.groupId!),
      "GROUP_NOT_FOUND",
    );
    const path = `/groups/${g.gatewayGroupId}`;
    if (job.phase === "invite") {
      const r = await remote(
        gateway(),
        path + "/invite",
        {},
        6000,
        this.signal,
      );
      if (r.status === 503 || r.status === 0) return;
      if (r.status !== 200) return this.error(job, "invite", remoteCode(r));
      job.inviteLink = r.body.inviteLink;
      job.readyAt = new Date(
        Date.now() + Number(r.body.readyAfterMs || 0),
      ).toISOString();
      job.phase = "join";
      job.steps.push({ step: "invite", status: "finished" });
      await this.save(job);
      return;
    }
    if (job.phase === "join") {
      if (job.readyAt && Date.parse(job.readyAt) > Date.now()) return;
      if (job.cursor >= job.memberAccountIds.length) {
        job.phase = "promote";
        await this.save(job);
        return;
      }
      const accountId = job.memberAccountIds[job.cursor];
      job.pendingAccountId = accountId;
      job.joinStartedAt = now();
      job.phase = "join_wait";
      await this.save(job);
      const r = await remote(
        gateway(),
        path + "/join",
        { accountId, inviteLink: job.inviteLink },
        3000,
        this.signal,
      );
      if (this.signal.aborted) return;
      const code = remoteCode(r);
      if (code === "INVITE_NOT_READY") {
        job.phase = "join";
        job.readyAt = new Date(
          Date.now() + Number(r.body.readyAfterMs || 300),
        ).toISOString();
        await this.save(job);
      } else if (code === "INVITE_EXPIRED" && job.inviteRetries < 1) {
        job.inviteRetries++;
        job.phase = "invite";
        await this.save(job);
      } else if (code === "ALREADY_MEMBER") {
        await this.confirmMember(job, g, accountId);
        job.cursor++;
        job.phase = "join";
        await this.save(job);
      } else if (r.status !== 202 && r.status !== 0) {
        if (r.status === 503) {
          job.phase = "join";
          await this.save(job);
        } else await this.error(job, `join:${accountId}`, code);
      }
      return;
    }
    if (job.phase === "join_wait") {
      const current = required(
        await this.db.read().get<Group>("groups", g.id),
        "GROUP_NOT_FOUND",
      );
      if (current.members.some((m) => m.accountId === job.pendingAccountId)) {
        job.steps.push({
          step: `join:${job.pendingAccountId}`,
          status: "finished",
        });
        job.cursor++;
        job.phase = "join";
        await this.save(job);
        return;
      }
      if (Date.now() - Date.parse(job.joinStartedAt!) >= 10000) {
        const found = await this.confirmMember(job, g, job.pendingAccountId!);
        if (found) {
          job.cursor++;
          job.phase = "join";
          await this.save(job);
        } else
          await this.error(job, `join:${job.pendingAccountId}`, "JOIN_TIMEOUT");
      }
      return;
    }
    if (job.phase === "promote") {
      if (job.promoteAttempts >= 2)
        return this.error(job, "promote", "NOT_MEMBER_YET");
      job.promoteAttempts++;
      await this.intent(job, "promote:requesting");
      const r = await remote(
        gateway(),
        path + "/promote",
        {
          byAccountId: job.creatorAccountId,
          accountId: job.memberAccountIds[0],
        },
        6000,
        this.signal,
      );
      if (this.signal.aborted) return;
      if (r.status === 0 || r.status === 504) return;
      if (r.status !== 200) {
        if (remoteCode(r) === "NOT_MEMBER_YET" && job.promoteAttempts < 2) {
          job.phase = "promote";
          await this.save(job);
        } else await this.error(job, "promote", remoteCode(r));
        return;
      }
      await this.db.tx(async (s) => {
        const current = required(
          await s.get<Group>("groups", g.id),
          "GROUP_NOT_FOUND",
        );
        const member = current.members.find(
          (m) => m.accountId === job.memberAccountIds[0],
        );
        if (member) member.role = "admin";
        await s.put("groups", current);
        job.status = "finished";
        job.phase = "done";
        job.steps.push({ step: "promote", status: "finished" });
        await s.put("jobs", job);
        await s.event("job_updated", { jobId: job.id, ...job });
        await s.event("group_updated", { groupId: g.id, ...current });
      });
    }
  }
  async confirmMember(job: Job, g: Group, accountId: string) {
    const r = await remote(
      gateway(),
      `/groups/${g.gatewayGroupId}/members`,
      undefined,
      1500,
      this.signal,
    );
    const account = await this.db.read().get<Account>("accounts", accountId);
    if (
      r.status !== 200 ||
      !account ||
      terminal(account.status) ||
      !(r.body as any[]).some(
        (m) => m.platformUserId === account.platformUserId,
      )
    )
      return false;
    await this.db.tx(async (s) => {
      const group = required(
        await s.get<Group>("groups", g.id),
        "GROUP_NOT_FOUND",
      );
      if (!group.members.some((m) => m.accountId === accountId)) {
        group.members.push({
          accountId,
          platformUserId: account.platformUserId!,
          role: "member",
        });
        await s.put("groups", group);
      }
    });
    return true;
  }
  async leave(job: Job) {
    const g = required(
      await this.db.read().get<Group>("groups", job.groupId!),
      "GROUP_NOT_FOUND",
    );
    const remaining = [...job.memberAccountIds, job.creatorAccountId];
    if (job.cursor >= remaining.length) {
      await this.db.tx(async (s) => {
        const current = required(
          await s.get<Group>("groups", g.id),
          "GROUP_NOT_FOUND",
        );
        current.closing = false;
        job.errors.push(...(job.pendingErrors || []));
        delete job.pendingErrors;
        if (job.errors.length) {
          job.status = "failed";
        } else {
          job.status = "finished";
          current.status = "left";
          current.members = [];
        }
        await s.put("groups", current);
        await s.put("jobs", job);
        await s.event("group_updated", { groupId: g.id, ...current });
        await s.event("job_updated", { jobId: job.id, ...job });
      });
      return;
    }
    const accountId = remaining[job.cursor];
    if (
      accountId === job.creatorAccountId &&
      (job.errors.length || job.pendingErrors?.length)
    ) {
      job.cursor++;
      await this.save(job);
      return;
    }
    const member = g.members.find((m) => m.accountId === accountId);
    if (!member) {
      job.cursor++;
      await this.save(job);
      return;
    }
    const check = await remote(
      gateway(),
      `/groups/${g.gatewayGroupId}/members`,
      undefined,
      1500,
      this.signal,
    );
    if (check.status !== 200) return;
    if (
      !(check.body as any[]).some(
        (m) => m.platformUserId === member.platformUserId,
      )
    ) {
      await this.removeMember(g.id, accountId);
      job.cursor++;
      await this.save(job);
      return;
    }
    const r = await remote(
      gateway(),
      `/groups/${g.gatewayGroupId}/leave`,
      { accountId },
      6000,
      this.signal,
    );
    if (this.signal.aborted) return;
    if (r.status === 0 || r.status === 504 || r.status === 503) return;
    if (r.status !== 200) {
      (job.pendingErrors ??= []).push({
        step: `leave:${accountId}`,
        code: remoteCode(r),
      });
      job.steps.push({ step: `leave:${accountId}`, status: "failed" });
    } else {
      await this.removeMember(g.id, accountId);
      job.steps.push({ step: `leave:${accountId}`, status: "finished" });
    }
    job.cursor++;
    await this.save(job);
  }
  async removeMember(groupId: string, accountId: string) {
    await this.db.tx(async (s) => {
      const g = required(
        await s.get<Group>("groups", groupId),
        "GROUP_NOT_FOUND",
      );
      g.members = g.members.filter((m) => m.accountId !== accountId);
      await s.put("groups", g);
    });
  }
}
