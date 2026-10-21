// What does wrapping writeFile in a transaction cost? Writes per second for a few file sizes.
const { AgentFS } = await import(process.env.AGENTFS_SDK ?? "agentfs-sdk");
import fs from "node:fs";

const dir = "results/cost";
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

async function bench(mode, sizeKiB, iterations) {
  const agent = await AgentFS.open({ path: `${dir}/${mode}-${sizeKiB}.db` });
  const db = agent.getDatabase();
  const data = Buffer.alloc(sizeKiB * 1024, 120);
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) {
    if (mode === "transaction") await db.exec("BEGIN");
    await agent.fs.writeFile(`/f/${i % 50}.bin`, data);
    if (mode === "transaction") await db.exec("COMMIT");
  }
  const ms = performance.now() - t0;
  await agent.close();
  return Math.round((iterations / ms) * 1000);
}

const rows = [];
for (const [sizeKiB, iterations] of [[1, 500], [64, 200], [256, 50], [1024, 20]]) {
  rows.push({
    sizeKiB,
    "writes/s (autocommit)": await bench("autocommit", sizeKiB, iterations),
    "writes/s (transaction)": await bench("transaction", sizeKiB, iterations),
  });
}
console.table(rows);
fs.writeFileSync(process.env.OUT ?? "results/04-write-cost.json", JSON.stringify(rows, null, 2));
