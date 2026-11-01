import { makePool } from "../db/pool.js";
import { env } from "../config/env.js";
import { createApp } from "./app.js";

const pool = makePool(env.databaseUrl);
createApp(pool, { corsOrigin: env.corsOrigin }).listen(env.port, () => {
  console.log(`IBP Agentic W0 API on http://localhost:${env.port} (health: /health)`);
});
