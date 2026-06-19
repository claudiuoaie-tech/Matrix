import { PrismaClient } from "@prisma/client";

// A single shared PrismaClient instance for the whole process. Re-using one
// client avoids exhausting the database connection pool.
export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === "production" ? ["error"] : ["warn", "error"],
});
