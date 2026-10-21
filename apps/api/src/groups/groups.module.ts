import { Module } from "@nestjs/common";
import { GroupsController } from "./groups.controller";
import { GroupsService } from "./groups.service";
import { JobsController } from "./jobs.controller";
@Module({
  imports: [],
  controllers: [GroupsController, JobsController],
  providers: [GroupsService],
  exports: [GroupsService],
})
export class GroupsModule {}
