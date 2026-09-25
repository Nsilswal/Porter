import { migratePostgres } from "./migrations.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is required to run migrations");
  process.exitCode = 1;
} else {
  try {
    await migratePostgres(connectionString);
    console.log("Database migrations applied");
  } catch {
    // Connection errors can contain connection details; never print credentials.
    console.error("Database migration failed; check database access and migration history");
    process.exitCode = 1;
  }
}
