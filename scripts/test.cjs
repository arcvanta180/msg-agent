const { spawn } = require("node:child_process");
const child = spawn(
  "pnpm",
  ["exec", "vitest", "run", ...process.argv.slice(2)],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      NO_PROXY: [process.env.NO_PROXY, "localhost", "127.0.0.1"]
        .filter(Boolean)
        .join(","),
    },
  },
);
child.on("exit", (code) => process.exit(code ?? 1));
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
