import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import { fail } from "../common/errors";
import { GroupDto, PatchGroupDto } from "./dto/group.dto";
import { GroupsService } from "./groups.service";
@Controller("api")
export class GroupsController {
  constructor(@Inject(GroupsService) private groups: GroupsService) {}
  @Get("groups") listGroups() {
    return this.groups.list();
  }
  @Get("groups/:id") group(@Param("id") key: string) {
    return this.groups.one(key);
  }
  @Post("groups") @HttpCode(202) createGroup(@Body() body: GroupDto) {
    if (body.memberAccountIds.includes(body.creatorAccountId))
      fail(400, "VALIDATION_ERROR", "成员不能包含群主");
    return this.groups.create(body.creatorAccountId, body.memberAccountIds);
  }
  @Patch("groups/:id") patchGroup(
    @Param("id") key: string,
    @Body() body: PatchGroupDto,
  ) {
    return this.groups.patch(key, body);
  }
  @Post("groups/:id/leave-all") @HttpCode(202) leave(@Param("id") key: string) {
    return this.groups.leave(key);
  }
}
