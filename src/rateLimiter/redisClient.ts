import Redis from "ioredis";
import { loadEnv } from "../config/env";

let client: Redis | undefined;

export function getRedisClient(): Redis {
  if (!client) {
    const env = loadEnv();
    client = new Redis(env.REDIS_URL);
  }
  return client;
}

export async function closeRedisClient(): Promise<void> {
  if (client) {
    await client.quit();
    client = undefined;
  }
}
