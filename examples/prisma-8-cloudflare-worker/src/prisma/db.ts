import { budgets, lints } from '@prisma/orm-postgres/family-runtime';
import postgresServerless from '@prisma/orm-postgres/serverless';
import type { Contract } from './contract.d';
import contractJson from './contract.json' with { type: 'json' };

function createMiddleware() {
  return [
    lints(),
    budgets({
      maxRows: 10_000,
      defaultTableRows: 10_000,
      tableRows: { user: 10_000, post: 10_000 },
      maxLatencyMs: 5_000,
    }),
  ];
}

/**
 * Module-scope client, built once per isolate. It holds no connection. Each request gets its own client from `postgres.connect({ url })`.
 */
export const postgres = postgresServerless<Contract>({
  contractJson,
  middleware: createMiddleware(),
});
