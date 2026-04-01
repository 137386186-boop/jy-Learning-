import Redis from "ioredis";

const redis = new Redis(process.env.REDIS_URL || "redis://127.0.0.1:6379");

redis.on("error", (err) => {
  console.error("[REDIS_ERROR]", err?.message || err);
});

export default redis;
