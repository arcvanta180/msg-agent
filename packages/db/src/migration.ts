import { MigrationInterface, QueryRunner } from "typeorm";
export const tables = [
  "users",
  "sessions",
  "refresh_tokens",
  "accounts",
  "groups",
  "messages",
  "gateway_events",
  "jobs",
  "agent_runs",
  "agent_triggers",
  "sequence_runs",
  "sequences",
  "timeline_snapshots",
  "mock_state",
] as const;
export type Table = (typeof tables)[number];
export class Initial1792454400000 implements MigrationInterface {
  async up(q: QueryRunner) {
    for (const table of tables)
      await q.query(
        `CREATE TABLE ${table} (id text PRIMARY KEY, data jsonb NOT NULL)`,
      );
    for (const table of [
      "messages",
      "agent_runs",
      "agent_triggers",
      "sequence_runs",
    ])
      await q.query(
        `ALTER TABLE ${table} ADD COLUMN group_id text GENERATED ALWAYS AS (data->>'groupId') STORED`,
      );
    for (const table of ["messages", "agent_runs", "sequence_runs"])
      await q.query(
        `ALTER TABLE ${table} ADD COLUMN status text GENERATED ALWAYS AS (data->>'${table === "messages" ? "deliveryStatus" : "status"}') STORED`,
      );
    await q.query(
      `CREATE UNIQUE INDEX messages_client_id ON messages ((data->>'clientMsgId')) WHERE data->>'clientMsgId' IS NOT NULL`,
    );
    await q.query(
      `CREATE UNIQUE INDEX messages_gateway_id ON messages (group_id,(data->>'msgId')) WHERE data->>'msgId' IS NOT NULL`,
    );
    await q.query(
      `CREATE INDEX messages_timeline ON messages (group_id,(data->>'sentAt') DESC,id DESC)`,
    );
    for (const table of ["agent_runs", "sequence_runs"])
      await q.query(
        `CREATE UNIQUE INDEX ${table}_one_running ON ${table}(group_id) WHERE status='running'`,
      );
    await q.query(
      `CREATE UNIQUE INDEX triggers_message ON agent_triggers(group_id,(data->>'msgId'))`,
    );
    await q.query(
      `CREATE TABLE event_counter (id integer PRIMARY KEY CHECK (id=1), value bigint NOT NULL); INSERT INTO event_counter VALUES(1,0)`,
    );
    await q.query(
      `CREATE TABLE ui_events (seq bigint PRIMARY KEY, type text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`,
    );
    await q.query(
      `CREATE TABLE schema_meta (version integer PRIMARY KEY); INSERT INTO schema_meta VALUES(1)`,
    );
  }
  async down(q: QueryRunner) {
    for (const table of [
      ...tables,
      "ui_events",
      "event_counter",
      "schema_meta",
    ].reverse())
      await q.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
  }
}
