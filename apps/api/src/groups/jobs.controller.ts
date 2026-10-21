import { Controller, Get, Inject, Param } from "@nestjs/common";
import { Database } from "../../../../packages/db/src";
import { required } from "../common/errors";

@Controller("api")
export class JobsController {
  constructor(@Inject(Database) private db: Database) {}
  @Get("jobs/:id") async job(@Param("id") key: string) {
    return required(await this.db.read().get("jobs", key), "JOB_NOT_FOUND");
  }
  @Get("jobs") jobs() {
    return this.db.read().all("jobs");
  }
}
