# What happens to an AgentFS filesystem when the agent gets killed?

[AgentFS](https://github.com/tursodatabase/agentfs) from Turso gives an AI agent a filesystem, a key-value store and a tool-call log, all in one SQLite file. The pitch is that the agent's whole state is a single portable database: you can inspect it with SQL, move it between machines, and, in the README's words, "Snapshot an agent's state at any point with `cp agent.db snapshot.db`."

I wanted to see how that holds up in the two situations where agent state matters most: when you copy the state somewhere, and when the process dies halfway through a write. This repo has the four experiments I ran and their raw results.

**Setup:** `agentfs-sdk` 0.6.4 (TypeScript), `@tursodatabase/database` 0.4.4, Node 24.16, Windows 11, local disk. Everything here is about the TypeScript SDK. I did not test the CLI, the FUSE/NFS mount or the Rust SDK, which may behave differently.

## 1. `cp agent.db snapshot.db` can copy an empty filesystem

The database runs in WAL mode (`PRAGMA journal_mode` returns `wal`). New writes go to `agent.db-wal` first and only get copied into `agent.db` at a checkpoint. When I opened an agent, wrote 20 small files, set a KV key and logged one tool call, this was the disk:

| | `agent.db` | `agent.db-wal` |
|---|---|---|
| while open | 4 KiB | 1,022 KiB |
| after `close()` | 4 KiB | 1,022 KiB |

`close()` doesn't checkpoint. I copied the `.db` file the way the README suggests and opened the copy ([`01-snapshot.mjs`](experiments/01-snapshot.mjs)):

| How the snapshot was taken | Files | KV key | Tool calls |
|---|---|---|---|
| copy `agent.db` while the agent is open | none (`ENOENT`) | missing | 0 |
| copy `agent.db` after a clean `close()` | none (`ENOENT`) | missing | 0 |
| copy `agent.db` **and** `agent.db-wal` | 20 | present | 1 |
| `PRAGMA wal_checkpoint(TRUNCATE)`, then copy `agent.db` | 20 | present | 1 |

SQLite does checkpoint on its own once the WAL reaches about 1,000 pages (around 4 MB). So the gap is total for small agents and partial for bigger ones. I wrote 1 KiB files and copied only `agent.db` at intervals ([`02-wal-growth.mjs`](experiments/02-wal-growth.mjs)):

| Files written | `agent.db` | `agent.db-wal` | Files visible in the copy |
|---|---|---|---|
| 10 | 4 KiB | 600 KiB | 0 |
| 100 | 184 KiB | 4,027 KiB | 88 |
| 500 | 712 KiB | 4,027 KiB | 437 |
| 1,000 | 1,452 KiB | 4,044 KiB | 948 |
| 5,000 | 7,256 KiB | 4,056 KiB | 4,935 |

None of these copies were corrupt. Each was a consistent view of the last checkpoint. That's arguably worse than corruption because nothing tells you the snapshot is stale: it opens fine and is just missing the agent's most recent work.

This is standard SQLite behaviour, not an AgentFS bug. But "the agent is one file" isn't quite true on disk: it's one file plus a WAL. If you snapshot, either copy both files with the agent stopped, or checkpoint first:

```js
await agent.getDatabase().exec("PRAGMA wal_checkpoint(TRUNCATE)");
```

## 2. `writeFile` is not atomic, even though the database underneath is

Reading `dist/filesystem/agentfs.js`, `writeFile` creates the inode, creates the directory entry, deletes the old data chunks, inserts the new content in 4 KiB chunks, and finally updates the inode's size. Each of those is its own autocommitted statement. There's no `BEGIN`/`COMMIT` around them.

To see what that means in practice, [`03-crash.mjs`](experiments/03-crash.mjs) starts a child process that overwrites one 256 KiB file in a loop. Every version is a single repeated byte (`AAAA…`, `BBBB…`), so you can tell a complete version from a torn one. The parent kills the child with `SIGKILL` at a random moment (`TerminateProcess` on Windows: no handlers, no `close()`), reopens the database and checks the file. 40 trials per mode:

| Mode | Intact | Torn / empty | stat size matches data | `PRAGMA integrity_check` |
|---|---|---|---|---|
| AgentFS `writeFile` | 1 | 39 torn (wrong length) | 1 of 40 | ok in 40 of 40 |
| AgentFS `writeFile` inside `BEGIN`…`COMMIT` | 40 | 0 | 40 of 40 | ok in 40 of 40 |
| Node `fs.writeFileSync` on NTFS (baseline) | 23 | 17 empty | n/a | n/a |

SQLite did its job every time: the database was never corrupt. The *file* was torn because the SDK commits a half-written file as a sequence of perfectly valid transactions. In 39 of 40 cases the inode's recorded `size` also disagreed with the bytes actually stored, so `stat()` and `readFile()` give different answers about the same file.

Two caveats. First, 39/40 is not a real-world failure rate. AgentFS writes are slow enough that a random kill almost always lands mid-write; in a real agent most of the time is spent waiting on the model. What matters is that a torn state is *reachable*, not how often it happens. Second, the native baseline shows that a regular filesystem's `writeFile` isn't atomic either: 17 of 40 files were empty. So AgentFS isn't worse than a normal disk here. It just doesn't use the transactional guarantees it already has. Issue [#335](https://github.com/tursodatabase/agentfs/issues/335) reports a related symptom: concurrent `readdirPlus` seeing partially created files.

The fix on the caller's side is one line either side. Since the SDK uses a single connection, you can wrap the write yourself:

```js
const db = agent.getDatabase();
await db.exec("BEGIN");
await agent.fs.writeFile("/state.json", data);
await db.exec("COMMIT");
```

## 3. The transaction also makes writes faster

Committing once per write instead of once per 4 KiB chunk costs fewer WAL syncs ([`04-write-cost.mjs`](experiments/04-write-cost.mjs), a single run on a laptop, so treat it as directional):

| File size | writes/s, autocommit | writes/s, in a transaction |
|---|---|---|
| 1 KiB | 248 | 450 |
| 64 KiB | 34 | 74 |
| 256 KiB | 10 | 25 |
| 1 MiB | 2 | 7 |

## 4. What worked well

The tool-call log behaved exactly the way you'd want for recovery. In 39 of 40 trials of each AgentFS mode, the interrupted call was left in the log with `status = 'pending'`. In the remaining run nothing was pending, which fits a kill landing between two calls. After a restart you can run one query and know precisely which action the agent was in the middle of:

```sql
SELECT id, name, parameters, started_at FROM tool_calls WHERE status = 'pending';
```

The file is also plain SQLite. Node's built-in `node:sqlite` opened a checkpointed AgentFS database read-only and queried `fs_dentry` with no extra tooling.

One scoping note on auditability: the README says "Every file operation, tool call, and state change is recorded." In the 0.6.4 TypeScript SDK schema (`fs_inode`, `fs_dentry`, `fs_data`, `fs_symlink`, `fs_config`, `kv_store`, `tool_calls`) I found the current state of the filesystem, but no table that logs individual file operations over time. The tool-call log contains what you record explicitly. The CLI or mount layer may record more; I didn't test it.

## Takeaways

- Treat an AgentFS agent as `agent.db` + `agent.db-wal`. Checkpoint before you copy, or copy both with the agent stopped.
- If a file must never be half-written (plans, checkpoints, anything the agent resumes from), wrap `writeFile` in a transaction. It's safer and faster.
- Use `tool_calls.status = 'pending'` as your "what was I doing when I died" signal.

## Run it yourself

```bash
npm install
npm run all        # or: npm run snapshot | wal | crash | cost
```

`TRIALS=10 npm run crash` runs a shorter crash test. Raw results from my runs are in [`results/`](results).
