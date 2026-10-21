const { spawn } = require("node:child_process");
const processes = [
  ["node", ["dist/apps/mock-gateway/src/main.js"]],
  ["node", ["dist/apps/mock-agent/src/main.js"]],
  ["node", ["dist/apps/api/src/main.js"]],
  ["pnpm", ["exec", "vite", "--config", "apps/web/vite.config.ts"]],
].map(([cmd, args]) =>
  spawn(cmd, args, {
    stdio: "inherit",
    env: {
      ...process.env,
      NO_PROXY: [process.env.NO_PROXY, "localhost", "127.0.0.1"]
        .filter(Boolean)
        .join(","),
    },
  }),
);
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const p of processes) p.kill("SIGTERM");
  setTimeout(() => process.exit(code), 500).unref();
}
for (const p of processes) p.on("exit", (code) => stop(code || 0));
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
