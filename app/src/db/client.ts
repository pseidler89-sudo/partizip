import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

function buildDb(url: string) {
  const sql = postgres(url, { max: 10 });
  return drizzle(sql, { schema });
}

// Pool-Cache pro Connection-URL: Route-Handler rufen createDb pro Request auf;
// ohne Cache entsteht pro Aufruf ein neuer postgres-Pool, der nie geschlossen
// wird (Connection-Erschöpfung, Gate-B-Befund M2). globalThis überlebt Next-HMR.
const globalForDb = globalThis as unknown as {
  __partizipDbPools?: Map<string, ReturnType<typeof buildDb>>;
};

export function createDb(url: string) {
  const pools = (globalForDb.__partizipDbPools ??= new Map());
  let db = pools.get(url);
  if (!db) {
    db = buildDb(url);
    pools.set(url, db);
  }
  return db;
}

export type Db = ReturnType<typeof createDb>;
