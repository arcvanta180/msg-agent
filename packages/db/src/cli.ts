import { createDataSource, Database, seed } from "./index";
async function main() {
  const source = await createDataSource().initialize();
  try {
    if (process.argv[2] === "migrate") {
      const q = source.createQueryRunner();
      await q.connect();
      try {
        await q.query("SELECT pg_advisory_lock(724102)");
        const result = await source.runMigrations({ transaction: "all" });
        console.log(`migration: ${result.length} applied`);
      } finally {
        await q.query("SELECT pg_advisory_unlock(724102)");
        await q.release();
      }
    } else if (process.argv[2] === "seed") {
      await new Database(source).check();
      await seed(new Database(source));
      console.log("seed: ready");
    } else throw new Error("use migrate | seed");
  } finally {
    await source.destroy();
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
