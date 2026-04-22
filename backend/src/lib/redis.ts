import Redis from "ioredis";

const redisUrl = process.env.REDIS_URL;

if (!redisUrl) {
  throw new Error("REDIS_URL is required");
}

const redis = new Redis(redisUrl);

redis.on("error", (err) => {
  console.error("[REDIS_ERROR]", err?.message || err);
});

export default redis;
