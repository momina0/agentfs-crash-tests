// Child process for 03-crash.mjs. Overwrites one 256 KiB file in a loop until it gets killed.
// Every version is a single repeated byte, so a reader can tell a complete version from a torn one.
// usage: node 03-crash-worker.mjs <mode: agentfs | agentfs-tx | native> <path>
import { AgentFS } from "agentfs-sdk";
import fs from "node:fs";

const [mode, path] = process.argv.slice(2);
const SIZE = 256 * 1024;
const version = (n) => Buffer.alloc(SIZE, 65 + (n % 26)); // "AAAA…", "BBBB…", …

if (mode === "native") {
  for (let n = 0; ; n++) {
    fs.writeFileSync(path, version(n));
    if (n === 0) process.stdout.write("ready\n");
  }
}

const agent = await AgentFS.open({ path });
const db = agent.getDatabase();
for (let n = 0; ; n++) {
  const call = await agent.tools.start("write_state", { version: n });
  if (mode === "agentfs-tx") await db.exec("BEGIN");
  await agent.fs.writeFile("/state.bin", version(n));
  if (mode === "agentfs-tx") await db.exec("COMMIT");
  await agent.tools.success(call, { bytes: SIZE });
  if (n === 0) process.stdout.write("ready\n");
}
