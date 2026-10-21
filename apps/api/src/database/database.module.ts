import { Global, Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { Database, createDataSource } from "../../../../packages/db/src";
@Global()
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      useFactory: () => createDataSource().options,
    }),
  ],
  providers: [
    {
      provide: Database,
      inject: [DataSource],
      useFactory: async (source: DataSource) => {
        const db = new Database(source);
        await db.check();
        return db;
      },
    },
  ],
  exports: [Database],
})
export class DatabaseModule {}
