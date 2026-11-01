// Vercel serverless entry (Hobby/free). Reusa o mesmo Express app do server.ts.
// Limitação: POST de A4 runs precisa de Python+OR-Tools (solver/) — não roda em função Node da Vercel.
import { makePool } from "../src/db/pool.js";
import { env } from "../src/config/env.js";
import { createApp } from "../src/http/app.js";

const pool = makePool(env.databaseUrl);
export default createApp(pool, { corsOrigin: env.corsOrigin });
