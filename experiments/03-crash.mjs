// Kill a process mid-write (hard kill, no cleanup) and check what the file looks like afterwards.
// Compares AgentFS writeFile, AgentFS writeFile inside a caller-owned transaction, and plain fs.writeFileSync.
import { AgentFS } from "agentfs-sdk";
import { spawn } from "node:child_process";
import fs from "node:fs";

const TRIALS = Number(process.env.TRIALS ?? 40);
const MODES = (process.env.MODES ?? "agentfs,agentfs-tx,native").split(",");
const OUT = process.env.OUT ?? "results/03-crash.json";
const SIZE = 256 * 1024;
const dir = "results/crash";
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

function classify(buf) {
  if (buf === null) return "missing";
  if (buf.length === 0) return "empty";
  if (buf.length !== SIZE) return "torn (wrong length)";
  return buf.every((b) => b === buf[0]) ? "intact" : "torn (mixed versions)";
}

async function runTrial(mode, i) {
  const path = `${dir}/${mode}-${i}.${mode === "native" ? "bin" : "db"}`;
  const child = spawn(process.execPath, ["experiments/03-crash-worker.mjs", mode, path], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((resolve) => child.stdout.once("data", resolve)); // first version fully written
  await new Promise((r) => setTimeout(r, 50 + Math.random() * 450));
  const exited = new Promise((r) => child.once("exit", r));
  child.kill("SIGKILL"); // TerminateProcess on Windows: no handlers, no close()
  await exited;

  if (mode === "native") return { result: classify(fs.existsSync(path) ? fs.readFileSync(path) : null) };

  const agent = await AgentFS.open({ path });
  const buf = await agent.fs.readFile("/state.bin").catch(() => null);
  const st = await agent.fs.stat("/state.bin").catch(() => null);
  const db = agent.getDatabase();
  const [{ integrity_check }] = await db.prepare("PRAGMA integrity_check").all();
  const pending = (await db.prepare("SELECT count(*) AS n FROM tool_calls WHERE status = 'pending'").get()).n;
  await agent.close();
  return {
    result: classify(buf),
    statSizeMatchesData: st && buf ? st.size === buf.length : null,
    integrity: integrity_check,
    pendingToolCalls: pending,
  };
}

const summary = {};
for (const mode of MODES) {
  const trials = [];
  for (let i = 0; i < TRIALS; i++) trials.push(await runTrial(mode, i));
  const count = (f) => trials.reduce((acc, t) => ((acc[f(t)] = (acc[f(t)] ?? 0) + 1), acc), {});
  summary[mode] = {
    trials: TRIALS,
    fileState: count((t) => t.result),
    ...(mode !== "native" && {
      statSizeMatchesData: count((t) => String(t.statSizeMatchesData)),
      sqliteIntegrity: count((t) => t.integrity),
      pendingToolCallsLeftBehind: count((t) => String(t.pendingToolCalls)),
    }),
  };
  console.log(mode, JSON.stringify(summary[mode]));
}
fs.writeFileSync(OUT, JSON.stringify(summary, null, 2));
