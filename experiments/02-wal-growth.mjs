// Does the WAL ever get folded back into agent.db on its own?
// And how much of the agent's state does a copy of agent.db alone contain at each point?
import { AgentFS } from "agentfs-sdk";
import fs from "node:fs";

const dir = "results/wal";
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
const path = `${dir}/agent.db`;
const kib = (f) => Math.round((fs.existsSync(f) ? fs.statSync(f).size : 0) / 1024);

const agent = await AgentFS.open({ path });
const payload = "x".repeat(1024); // 1 KiB per file
const rows = [];
let written = 0;
for (const n of [10, 100, 500, 1000, 2000, 5000]) {
  while (written < n) await agent.fs.writeFile(`/f/${written++}.txt`, payload);
  fs.copyFileSync(path, `${dir}/copy-${n}.db`); // the README's `cp agent.db snapshot.db`
  rows.push({ filesWritten: n, dbKiB: kib(path), walKiB: kib(`${path}-wal`) });
}
await agent.close();

for (const r of rows) {
  const copy = await AgentFS.open({ path: `${dir}/copy-${r.filesWritten}.db` });
  r.filesInDbOnlyCopy = (await copy.fs.readdir("/f").catch(() => [])).length;
  await copy.close();
}
rows.push({ filesWritten: "after close()", dbKiB: kib(path), walKiB: kib(`${path}-wal`) });

console.table(rows);
fs.writeFileSync("results/02-wal-growth.json", JSON.stringify(rows, null, 2));
