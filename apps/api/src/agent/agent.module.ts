import { Module } from "@nestjs/common";
import { GroupsModule } from "../groups/groups.module";
import { AgentController } from "./agent.controller";
@Module({
  imports: [GroupsModule],
  controllers: [AgentController],
  providers: [],
  exports: [],
})
export class AgentModule {}
