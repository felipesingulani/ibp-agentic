import { existsSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env");

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name} (see .env.example)`);
  return v;
}

export const env = {
  get databaseUrl() { return req("DATABASE_URL"); },
  get migrationDatabaseUrl() { return req("MIGRATION_DATABASE_URL"); },
  get appDbUser() { return process.env.APP_DB_USER ?? "ibp_app"; },
  get appDbPassword() { return req("APP_DB_PASSWORD"); },
  port: Number(process.env.PORT ?? 3000),
  corsOrigin: process.env.CORS_ORIGIN ?? "",
};
