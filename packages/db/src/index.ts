import "reflect-metadata";
import { DataSource, EntityManager, EntitySchema } from "typeorm";
import { randomUUID, scryptSync, randomBytes } from "node:crypto";
import { Initial1792454400000, tables, Table } from "./migration";
export const schemaVersion = 1;
export const entities = tables.map(
  (table) =>
    new EntitySchema<{ id: string; data: object }>({
      name: table,
      tableName: table,
      columns: { id: { type: String, primary: true }, data: { type: "jsonb" } },
    }),
);
export function createDataSource() {
  return new DataSource({
    type: "postgres",
    url:
      process.env.DATABASE_URL ||
      "postgres://msg:msg@localhost:54329/msg_agent",
    entities,
    migrations: [Initial1792454400000],
    synchronize: false,
    logging: false,
    extra: { max: 20 },
  });
}
export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export class Store {
  constructor(public manager: EntityManager) {}
  async get<T>(table: Table, key: string): Promise<T | undefined> {
    return (await this.manager.getRepository(table).findOneBy({ id: key }))
      ?.data as T | undefined;
  }
  async all<T>(table: Table): Promise<T[]> {
    return (await this.manager.getRepository(table).find()).map(
      (row) => row.data as T,
    );
  }
  async put<T extends { id: string }>(table: Table, value: T) {
    await this.manager
      .getRepository(table)
      .upsert({ id: value.id, data: value }, ["id"]);
    return value;
  }
  async remove(table: Table, key: string) {
    await this.manager.getRepository(table).delete({ id: key });
  }
  async event(type: string, payload: object) {
    await this.manager.query(
      "UPDATE event_counter SET value=value+1 WHERE id=1",
    );
    const [row] = await this.manager.query(
      "SELECT value FROM event_counter WHERE id=1",
    );
    await this.manager.query(
      "INSERT INTO ui_events(seq,type,payload) VALUES($1,$2,$3)",
      [row.value, type, JSON.stringify(payload)],
    );
  }
  async seq(): Promise<string> {
    return (
      await this.manager.query("SELECT value FROM event_counter WHERE id=1")
    )[0].value;
  }
}
export class Database {
  constructor(public source: DataSource) {}
  async tx<T>(fn: (s: Store) => Promise<T>): Promise<T> {
    return this.source.transaction(async (manager) => {
      await manager.query("SELECT pg_advisory_xact_lock(724101)");
      return fn(new Store(manager));
    });
  }
  read() {
    return new Store(this.source.manager);
  }
  async check() {
    const version = await this.source.query("SELECT version FROM schema_meta");
    if (
      version[0]?.version !== schemaVersion ||
      (await this.source.showMigrations())
    )
      throw new Error("数据库 schema 落后，请先执行 pnpm db:migrate");
  }
}
export async function seed(db: Database) {
  await db.tx(async (s) => {
    for (const username of ["admin", "viewer"])
      if (!(await s.get("users", username))) {
        const salt = randomBytes(16).toString("hex");
        await s.put("users", {
          id: username,
          username,
          role: username,
          salt,
          passwordHash: scryptSync(username, salt, 64).toString("hex"),
        });
      }
    for (let i = 1; i <= 4; i++) {
      const key = `acct-${i}`;
      if (!(await s.get("accounts", key)))
        await s.put("accounts", {
          id: key,
          status: "idle",
          platformUserId: null,
          rateLimitedUntil: null,
          version: 0,
          operation: null,
        });
    }
    if (!(await s.get("sequences", "welcome")))
      await s.put("sequences", {
        id: "welcome",
        name: "活动提醒 · 双角色协作",
        steps: [
          {
            index: 1,
            accountRole: "admin",
            text: "{event} 将于 {time} 开始，请提前准备",
            delaySeconds: 2,
          },
          {
            index: 2,
            accountRole: "member",
            text: "提醒：{event} 的资料已上传到 {location}",
            delaySeconds: 2,
          },
          {
            index: 3,
            accountRole: "admin",
            text: "{event} 即将开始，请查看 {location}",
            delaySeconds: 2,
          },
        ],
      });
  });
}
