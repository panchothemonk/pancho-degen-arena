import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const backupDir = process.env.PANCHO_D1_BACKUP_DIR ?? path.join(process.cwd(), "data", "backups");

async function main() {
  const files = (await readdir(backupDir))
    .filter((name) => name.endsWith(".sql"))
    .map((name) => path.join(backupDir, name));

  if (files.length === 0) {
    throw new Error(`No SQL backups found in ${backupDir}`);
  }

  const withStats = await Promise.all(
    files.map(async (file) => ({
      file,
      stat: await stat(file)
    }))
  );
  withStats.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  const latest = withStats[0];
  const contents = await readFile(latest.file, "utf8");

  const hasEntriesTable = /CREATE TABLE[^;]*sim_entries/i.test(contents);
  const hasSettlementsTable = /CREATE TABLE[^;]*sim_round_settlements/i.test(contents);
  const hasInsert = /INSERT INTO/i.test(contents);

  const ok = latest.stat.size > 0 && hasEntriesTable && hasSettlementsTable && hasInsert;
  const report = {
    ok,
    latestFile: latest.file,
    sizeBytes: latest.stat.size,
    checks: {
      hasEntriesTable,
      hasSettlementsTable,
      hasInsert
    }
  };

  console.log(JSON.stringify(report, null, 2));
  if (!ok) {
    process.exit(1);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error ?? "unknown backup verify error");
  console.error(JSON.stringify({ ok: false, backupDir, error: message }, null, 2));
  process.exit(1);
});
