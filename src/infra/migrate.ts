import { drizzle } from "drizzle-orm/node-postgres";
import { migrate as runMigrations } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createPool } from "./db";

const migrationsFolder = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "drizzle",
);

/** Apply Drizzle-generated migrations (model-driven; see src/db/schema.ts). */
export async function migrate(): Promise<void> {
  const pool = createPool({ max: 1 });
  try {
    await runMigrations(drizzle(pool), { migrationsFolder });
  } finally {
    await pool.end();
  }
}

// Run directly: `npm run migrate`
if (import.meta.url === `file://${process.argv[1]}`) {
  migrate()
    .then(() => console.log("✓ migrations applied"))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
