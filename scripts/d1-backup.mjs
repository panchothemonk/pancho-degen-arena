import { mkdirSync } from "node:fs";
import { stat, readdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const dbName = process.env.PANCHO_D1_DB_NAME ?? "pancho-sim-db";
const backupDir = process.env.PANCHO_D1_BACKUP_DIR ?? path.join(process.cwd(), "data", "backups");
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const outputFile = path.join(backupDir, `d1-${dbName}-${timestamp}.sql`);

function run(cmd, args) {
  return spawnSync(cmd, args, {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8"
  });
}

async function main() {
  mkdirSync(backupDir, { recursive: true });

  const result = run("npx", ["wrangler", "d1", "export", dbName, "--remote", "--output", outputFile]);
  if (result.status !== 0) {
    console.error(
      JSON.stringify(
        { ok: false, step: "export", dbName, outputFile, stdout: result.stdout, stderr: result.stderr },
        null,
        2
      )
    );
    process.exit(1);
  }

  const st = await stat(outputFile);
  const files = await readdir(backupDir);
  console.log(
    JSON.stringify(
      {
        ok: true,
        dbName,
        outputFile,
        sizeBytes: st.size,
        backupsInDir: files.filter((f) => f.endsWith(".sql")).length
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error ?? "unknown d1 backup error");
  console.error(JSON.stringify({ ok: false, dbName, error: message }, null, 2));
  process.exit(1);
});
