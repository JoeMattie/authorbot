import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, "../../..");
const migrationsDir = join(repoRoot, "migrations");
const require = createRequire(import.meta.url);
const wranglerCli = require.resolve("wrangler");

describe("Cloudflare D1 migrations", () => {
  let workDir: string | undefined;

  afterEach(async () => {
    if (workDir !== undefined) {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("applies the complete migration chain through Wrangler's D1 runtime", async () => {
    workDir = await mkdtemp(join(tmpdir(), "authorbot-d1-migrations-"));
    const configPath = join(workDir, "wrangler.jsonc");
    const persistPath = join(workDir, "state");
    const workerPath = join(workDir, "worker.mjs");

    await writeFile(
      workerPath,
      "export default { fetch() { return new Response('ok'); } };\n",
    );
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          name: "authorbot-d1-migration-test",
          main: workerPath,
          compatibility_date: "2026-07-22",
          d1_databases: [
            {
              binding: "DB",
              database_name: "authorbot-d1-migration-test",
              database_id: "00000000-0000-0000-0000-000000000000",
              migrations_dir: migrationsDir,
            },
          ],
        },
        null,
        2,
      )}\n`,
    );

    let stdout: string;
    let stderr: string;
    try {
      ({ stdout, stderr } = await execFileAsync(
        process.execPath,
        [
          wranglerCli,
          "d1",
          "migrations",
          "apply",
          "DB",
          "--local",
          "--config",
          configPath,
          "--persist-to",
          persistPath,
        ],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            CI: "true",
            WRANGLER_SEND_METRICS: "false",
            XDG_CONFIG_HOME: join(workDir, "xdg"),
          },
          maxBuffer: 10 * 1024 * 1024,
        },
      ));
    } catch (error) {
      const failure = error as Error & { stdout?: string; stderr?: string };
      throw new Error(
        `Wrangler could not apply the migration chain:\n${failure.stdout ?? ""}\n${failure.stderr ?? ""}`,
        { cause: error },
      );
    }

    const output = `${stdout}\n${stderr}`;
    expect(output).toContain("0013_phase11_capabilities_backfill.sql");
  });
});
