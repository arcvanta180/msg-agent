import { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { Database } from "../../../../packages/db/src";
import { AuthService } from "../auth/auth.service";
export function realtime(server: Server, db: Database, auth: AuthService) {
  const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 4096 });
  wss.on("connection", (socket) => {
    let token: string | null = null,
      seq = "0",
      busy = false;
    let authenticating = false;
    const deadline = setTimeout(() => {
      if (!token) socket.close(4001, "auth required");
    }, 5000);
    const drain = async () => {
      if (!token || busy || socket.readyState !== WebSocket.OPEN) return;
      busy = true;
      try {
        await auth.validate(token);
        const rows = await db.source.query(
          "SELECT seq::text,type,payload FROM ui_events WHERE seq>$1 ORDER BY ui_events.seq LIMIT 200",
          [seq],
        );
        for (const row of rows) {
          socket.send(JSON.stringify(row));
          seq = row.seq;
        }
      } catch {
        socket.close(4001, "session expired");
      } finally {
        busy = false;
      }
    };
    socket.on("message", async (raw) => {
      try {
        if (token || authenticating) return;
        authenticating = true;
        const frame = JSON.parse(String(raw));
        if (
          frame.type !== "auth" ||
          typeof frame.accessToken !== "string" ||
          (frame.sinceSeq !== undefined &&
            !/^\d+$/.test(String(frame.sinceSeq)))
        )
          throw Error();
        await auth.validate(frame.accessToken);
        seq = String(frame.sinceSeq ?? 0);
        const latest = await db.read().seq();
        if (BigInt(seq) > BigInt(latest)) throw Error();
        token = frame.accessToken;
        clearTimeout(deadline);
        socket.send(JSON.stringify({ type: "auth", success: true }));
        await drain();
      } catch {
        socket.send(JSON.stringify({ type: "auth", success: false }));
        socket.close(4001, "unauthorized");
      }
    });
    const interval = setInterval(() => void drain(), 150);
    socket.on("error", () => socket.terminate());
    socket.on("close", () => {
      clearInterval(interval);
      clearTimeout(deadline);
    });
  });
  return wss;
}
