import { Controller, Get, Inject } from "@nestjs/common";
import { Database, schemaVersion } from "../../../../packages/db/src";

@Controller("api")
export class HealthController {
  constructor(@Inject(Database) private db: Database) {}
  @Get("health") async health() {
    await this.db.check();
    return { ok: true, schemaVersion };
  }
  @Get("inconsistencies")
  async inconsistencies() {
    return this.db.source.query(
      "SELECT seq::text,type,payload,created_at FROM ui_events WHERE type='inconsistency' ORDER BY ui_events.seq DESC LIMIT 20",
    );
  }
}
