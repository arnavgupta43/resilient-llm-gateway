import { getPool, closePool } from "./client";
import { hashApiKey } from "../auth/hashApiKey";

// No admin API exists yet to create real API keys — these fixed dev/test
// keys unblock local dev and e2e tests until one does.
const DEV_KEYS: { rawKey: string; tier: "free" | "pro" | "enterprise" }[] = [
  { rawKey: "dev-free-key", tier: "free" },
  { rawKey: "dev-pro-key", tier: "pro" },
  { rawKey: "dev-enterprise-key", tier: "enterprise" },
];

async function run(): Promise<void> {
  const pool = getPool();

  for (const { rawKey, tier } of DEV_KEYS) {
    await pool.query(
      `INSERT INTO api_keys (key_hash, tier) VALUES ($1, $2)
       ON CONFLICT (key_hash) DO NOTHING`,
      [hashApiKey(rawKey), tier],
    );
  }

   // eslint-disable-next-line no-console
    console.log(`Seeded dev API keys: ${DEV_KEYS.map((k) => k.rawKey).join(", ")}`);
}

run()
  .catch((err) => {
     // eslint-disable-next-line no-console
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
