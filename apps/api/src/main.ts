import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import cookieParser from "cookie-parser";
import "reflect-metadata";
import { Database } from "../../../packages/db/src";
import { AppModule } from "./app.module";
import { AuthService } from "./auth/auth.service";
import { Errors } from "./common/errors";
import { realtime } from "./realtime/realtime";
import { workers } from "./runtime/workers";
async function main() {
  const app = await NestFactory.create(AppModule, {
    logger: ["error", "warn", "log"],
  });
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new Errors());
  app.enableCors({
    origin: process.env.WEB_ORIGIN || "http://localhost:5173",
    credentials: true,
  });
  // Only browser-origin requests need CSRF origin validation; CLI clients send no Origin.
  app.use((req: any, res: any, next: any) => {
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.headers.origin &&
      req.headers.origin !== (process.env.WEB_ORIGIN || "http://localhost:5173")
    )
      return res.status(403).json({
        error: {
          code: "FORBIDDEN",
          message: "请求来源不受信任",
          requestId: crypto.randomUUID(),
        },
      });
    next();
  });
  await app.listen(Number(process.env.PORT || 3000), "0.0.0.0");
  const db = app.get(Database);
  const wss = realtime(app.getHttpServer(), db, app.get(AuthService));
  const stop = await workers(db);
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await stop();
    for (const client of wss.clients) client.close(1001, "server shutdown");
    wss.close();
    await app.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
  console.log(`API http://localhost:${process.env.PORT || 3000}`);
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
