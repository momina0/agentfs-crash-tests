// Print the saved crash-test results (results/03-crash.json) as a table.
import fs from "node:fs";

const results = JSON.parse(fs.readFileSync("results/03-crash.json", "utf8"));
const labels = {
  agentfs: "AgentFS writeFile",
  "agentfs-tx": "AgentFS writeFile in BEGIN/COMMIT",
  native: "fs.writeFileSync (NTFS)",
};

console.table(
  Object.entries(results).map(([mode, r]) => ({
    mode: labels[mode],
    kills: r.trials,
    intact: r.fileState.intact ?? 0,
    torn: (r.fileState["torn (wrong length)"] ?? 0) + (r.fileState["torn (mixed versions)"] ?? 0),
    empty: r.fileState.empty ?? 0,
    "sqlite integrity": r.sqliteIntegrity ? `ok ${r.sqliteIntegrity.ok ?? 0}/${r.trials}` : "-",
  })),
);
