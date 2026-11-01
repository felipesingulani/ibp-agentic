import pg from "pg";

export type Pool = pg.Pool;
export type Client = pg.PoolClient;

export function makePool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 10 });
}

/**
 * Executa `fn` numa transação com `app.tenant_id` setado (SET LOCAL via set_config, parametrizado).
 * RLS no Postgres é a fonte da verdade do isolamento — não só o filtro da aplicação.
 */
export async function withTenant<T>(pool: pg.Pool, tenantId: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
