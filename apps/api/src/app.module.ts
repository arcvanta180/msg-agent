import { Module } from "@nestjs/common";
import { AccountsModule } from "./accounts/accounts.module";
import { AgentModule } from "./agent/agent.module";
import { AuthModule } from "./auth/auth.module";
import { DatabaseModule } from "./database/database.module";
import { GroupsModule } from "./groups/groups.module";
import { HealthModule } from "./health/health.module";
import { MessagesModule } from "./messages/messages.module";
import { SequencesModule } from "./sequences/sequences.module";
@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    AccountsModule,
    GroupsModule,
    MessagesModule,
    AgentModule,
    SequencesModule,
    HealthModule,
  ],
})
export class AppModule {}
