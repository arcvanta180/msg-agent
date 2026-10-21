import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
} from "@nestjs/common";
import { Database } from "../../../../packages/db/src";
import { fail, required } from "../common/errors";
import { SequenceDto, StartDto, VarsDto } from "./dto/sequence.dto";
import { SequencesService } from "./sequences.service";
import { validateVars as vars } from "./validate-vars";
@Controller("api")
export class SequencesController {
  constructor(
    @Inject(SequencesService) private sequences: SequencesService,
    @Inject(Database) private db: Database,
  ) {}
  @Get("sequences") sequencesList() {
    return this.sequences.list();
  }
  @Post("sequences") createSequence(@Body() body: SequenceDto) {
    if (body.steps.some((s, i) => s.index !== i + 1))
      fail(400, "VALIDATION_ERROR", "步骤 index 必须从 1 开始连续递增");
    return this.sequences.create(body);
  }
  @Post("sequences/:id/preview") @HttpCode(200) preview(
    @Param("id") key: string,
    @Body() body: VarsDto,
  ) {
    vars(body);
    return this.sequences.preview(key, body.vars, body.stepVars);
  }
  @Post("groups/:id/sequence-runs") startSequence(
    @Param("id") key: string,
    @Body() body: StartDto,
  ) {
    vars(body);
    return this.sequences.start(key, body.sequenceId, body.vars, body.stepVars);
  }
  @Get("sequence-runs/:id") async sequenceRun(@Param("id") key: string) {
    return required(
      await this.db.read().get("sequence_runs", key),
      "RUN_NOT_FOUND",
    );
  }
  @Get("groups/:id/sequence-runs") async sequenceRuns(
    @Param("id") key: string,
  ) {
    return (await this.db.read().all<any>("sequence_runs"))
      .filter((r) => r.groupId === key)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
