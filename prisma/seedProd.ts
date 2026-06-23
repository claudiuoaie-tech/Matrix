/**
 * Idempotent production-safe seed (CLI).
 *
 *   npm run seed:prod
 *
 * Inserts demo data only when the database is empty; never deletes anything.
 * Same logic as the admin `POST /api/admin/seed` endpoint. Point DATABASE_URL at
 * the target database before running.
 */
import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { seedDemoData } from "../src/lib/seedDemo";

seedDemoData()
  .then((r) => console.log(r.message))
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
