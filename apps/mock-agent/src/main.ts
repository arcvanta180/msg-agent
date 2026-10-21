import "reflect-metadata";
import { All, Controller, Module, Req, Res } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Request, Response } from "express";
import { Database, createDataSource } from "../../../packages/db/src";
import { tools } from "../../../packages/contracts/src";
interface Script {
  status?: number;
  raw?: string;
  body?: object;
  delayMs?: number;
}
interface State {
  id: string;
  script: Script[];
  audits: Script[];
  runs: Record<string, number>;
  calls: { runId: string; operation: string; body: any }[];
}
let db: Database;
const initial = (): State => ({
  id: "agent",
  script: [],
  audits: [],
  runs: {},
  calls: [],
});
@Controller()
class AgentController {
  @All("{*path}") async route(@Req() req: Request, @Res() res: Response) {
    const answer = await db.tx(async (store) => {
      const s = (await store.get<State>("mock_state", "agent")) || initial();
      const b = req.body || {};
      let response: Script = { body: { ok: true } };
      if (req.path === "/__state") response = { body: s };
      else if (req.path === "/__control") {
        if (b.script) s.script = b.script;
        if (b.audits) s.audits = b.audits;
        if (b.resetRuns) s.runs = {};
      } else if (req.path === "/agent/audit") {
        s.calls.push({ runId: "audit", operation: "audit", body: b });
        response = s.audits.shift() || {
          body: {
            verdict: String(b.text).includes("[拒绝]") ? "fail" : "pass",
            reason: "演示审计规则",
          },
        };
      } else if (req.path === "/agent/turn") {
        s.calls.push({ runId: b.runId, operation: "turn", body: b });
        const valid =
          Array.isArray(b.tools) &&
          b.tools.length === 4 &&
          tools.every((tool) =>
            b.tools.some(
              (t: any) =>
                t.name === tool.name &&
                Array.isArray(t.input_schema?.required) &&
                tool.input_schema.required.every((k) =>
                  t.input_schema.required.includes(k),
                ) &&
                t.input_schema.type === "object" &&
                tool.input_schema.required.every(
                  (k) => t.input_schema.properties?.[k],
                ),
            ),
          );
        if (!valid) response = { status: 400, body: { code: "TOOLS_INVALID" } };
        else {
          const index = s.runs[b.runId] || 0;
          s.runs[b.runId] = index + 1;
          const block = (name: string, input: object) => ({
            stop_reason: "tool_use",
            content: [{ type: "tool_use", id: `tu_${index + 1}`, name, input }],
          });
          response = s.script[index] || {
            body:
              index === 0
                ? block("get_recent_messages", { limit: 10 })
                : index === 1
                  ? block("send_message", {
                      text: "收到你的消息！活动资料已准备好，有问题可以继续在群内提问。",
                      idempotency_key: "welcome-reply",
                    })
                  : block("finish", {
                      summary: "已读取上下文并回复，等待下一条消息。",
                    }),
          };
        }
      } else if (req.path !== "/health")
        response = { status: 404, body: { code: "NOT_FOUND" } };
      await store.put("mock_state", s);
      return response;
    });
    if (answer.delayMs) await new Promise((r) => setTimeout(r, answer.delayMs));
    res.status(answer.status || 200);
    if (answer.raw !== undefined) res.type("text/plain").send(answer.raw);
    else res.json(answer.body || {});
  }
}
@Module({ controllers: [AgentController] })
class AgentModule {}
async function main() {
  const source = await createDataSource().initialize();
  db = new Database(source);
  await db.check();
  const app = await NestFactory.create(AgentModule, {
    logger: ["error", "warn"],
  });
  await app.listen(Number(process.env.MOCK_AGENT_PORT || 3102), "0.0.0.0");
  const stop = async () => {
    await app.close();
    await source.destroy();
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());
  console.log("Mock Agent :3102");
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
