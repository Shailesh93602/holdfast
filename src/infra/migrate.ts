import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createPool } from "./db";

const here = dirname(fileURLToPath(import.meta.url));

export async function migrate(): Promise<void> {
  const sql = readFileSync(join(here, "schema.sql"), "utf8");
  const pool = createPool({ max: 1 });
  try {
    await pool.query(sql);
  } finally {
    await pool.end();
  }
}

// Run directly: `npm run migrate`
if (import.meta.url === `file://${process.argv[1]}`) {
  migrate()
    .then(() => {
      console.log("✓ schema applied");
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
