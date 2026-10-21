// Does `cp agent.db snapshot.db` (the README's snapshot recipe) capture the agent's state?
import { AgentFS } from "agentfs-sdk";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";

const dir = "results/snapshot";
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
const sizes = () => Object.fromEntries(fs.readdirSync(dir).map((f) => [f, fs.statSync(`${dir}/${f}`).size]));

async function populate(path) {
  const agent = await AgentFS.open({ path });
  for (let i = 0; i < 20; i++) await agent.fs.writeFile(`/work/file-${i}.txt`, `content ${i}\n`.repeat(50));
  await agent.kv.set("progress", { step: 20 });
  const id = await agent.tools.start("search", { q: "agentfs" });
  await agent.tools.success(id, { hits: 3 });
  return agent;
}

async function inspect(path) {
  const agent = await AgentFS.open({ path });
  const files = await agent.fs.readdir("/work").catch((e) => `ERROR ${e.code ?? e.message}`);
  const progress = await agent.kv.get("progress");
  const calls = (await agent.tools.getRecent(0)).length;
  await agent.close();
  return { files: Array.isArray(files) ? files.length : files, progress: progress ?? null, toolCalls: calls };
}

const out = {};

// A: copy the .db file while the agent is still open
let agent = await populate(`${dir}/a.db`);
out.A_sizes_while_open = sizes();
fs.copyFileSync(`${dir}/a.db`, `${dir}/a-snapshot.db`);
await agent.close();
out.A_sizes_after_close = sizes();
out.A_copy_db_only_while_open = await inspect(`${dir}/a-snapshot.db`);

// B: copy the .db file after a clean close()
fs.copyFileSync(`${dir}/a.db`, `${dir}/b-snapshot.db`);
out.B_copy_db_only_after_close = await inspect(`${dir}/b-snapshot.db`);

// C: copy .db + .db-wal together after close()
fs.copyFileSync(`${dir}/a.db`, `${dir}/c-snapshot.db`);
fs.copyFileSync(`${dir}/a.db-wal`, `${dir}/c-snapshot.db-wal`);
out.C_copy_db_and_wal = await inspect(`${dir}/c-snapshot.db`);

// D: explicit checkpoint before copying the .db file
agent = await populate(`${dir}/d.db`);
out.D_checkpoint = await agent.getDatabase().prepare("PRAGMA wal_checkpoint(TRUNCATE)").all();
fs.copyFileSync(`${dir}/d.db`, `${dir}/d-snapshot.db`);
await agent.close();
out.D_copy_db_after_checkpoint = await inspect(`${dir}/d-snapshot.db`);

// E: can stock SQLite (node:sqlite) read the AgentFS file?
try {
  const db = new DatabaseSync(`${dir}/d-snapshot.db`, { readOnly: true });
  out.E_stock_sqlite = db.prepare("SELECT count(*) AS dentries FROM fs_dentry").get();
  db.close();
} catch (e) {
  out.E_stock_sqlite = `ERROR ${e.message}`;
}

out.final_sizes = sizes();
console.log(JSON.stringify(out, null, 2));
fs.writeFileSync("results/01-snapshot.json", JSON.stringify(out, null, 2));
