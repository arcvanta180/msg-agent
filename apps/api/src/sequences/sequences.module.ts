import { Module } from "@nestjs/common";
import { SequencesController } from "./sequences.controller";
import { SequencesService } from "./sequences.service";
@Module({
  imports: [],
  controllers: [SequencesController],
  providers: [SequencesService],
  exports: [SequencesService],
})
export class SequencesModule {}
