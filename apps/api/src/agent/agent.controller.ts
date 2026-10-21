import { Controller, Get, Inject, Param } from "@nestjs/common";
import { Database } from "../../../../packages/db/src";
import { required } from "../common/errors";
import { GroupsService } from "../groups/groups.service";
@Controller("api")
export class AgentController {
  constructor(
    @Inject(GroupsService) private groups: GroupsService,
    @Inject(Database) private db: Database,
  ) {}
  @Get("agent-runs/:id") async agentRun(@Param("id") key: string) {
    return required(
      await this.db.read().get("agent_runs", key),
      "RUN_NOT_FOUND",
    );
  }
  @Get("groups/:id/agent-runs") async agentRuns(@Param("id") key: string) {
    await this.groups.one(key);
    return (await this.db.read().all<any>("agent_runs"))
      .filter((r) => r.groupId === key)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 50);
  }
}
