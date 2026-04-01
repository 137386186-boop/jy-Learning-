import { Router } from "express";
import rateLimit from "express-rate-limit";
import { randomUUID, createHash } from "crypto";
import redis from "../lib/redis";
import { requireAdmin } from "../lib/admin-auth";
import { dispatchBiliReply } from "../lib/bilibili-dispatch";

const router = Router();

type DraftReq = {
  userId: string;
  message: string;
  platform?: "bilibili";
  round?: number;
};

type SendReq = {
  userId: string;
  replyText: string;
  targetId?: string;
  oid?: string;
  type?: number;
  root?: string;
  parent?: string;
  confirm?: boolean;
  confirmToken?: string;
};

const CONTACT_COOLDOWN_SEC = Number(process.env.CONTACT_COOLDOWN_SEC || 86400);
const BILI_SEND_CONFIRM_TTL_SEC = Number(process.env.BILI_SEND_CONFIRM_TTL_SEC || 300);
const BILI_SEND_ENABLED = (process.env.BILI_SEND_ENABLED || "1") !== "0";

const sendLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: Number(process.env.BILI_SEND_MAX_PER_10M || 30),
  standardHeaders: true,
  legacyHeaders: false,
});

function contactKey(userId: string) {
  return `bili:contact:cooldown:${userId}`;
}

function confirmKey(token: string) {
  return `bili:send:confirm:${token}`;
}

function payloadDigest(input: {
  userId: string;
  oid: string;
  replyText: string;
  type: number;
  root: string;
  parent: string;
}) {
  return createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex");
}

function calcIntentScore(text: string): number {
  const t = text.toLowerCase();
  let score = 0.2;
  const high = ["报价", "多少钱", "怎么购买", "合作", "方案", "教程", "代做", "私聊", "联系方式", "微信", "qq"];
  const mid = ["怎么", "可以吗", "帮我", "详细", "步骤", "解决"];
  const neg = ["投诉", "举报", "骗子", "垃圾", "滚"];
  if (high.some(k => t.includes(k))) score += 0.5;
  if (mid.some(k => t.includes(k))) score += 0.2;
  if (neg.some(k => t.includes(k))) score -= 0.4;
  return Math.max(0, Math.min(1, score));
}

function isSensitive(text: string): boolean {
  const bad = ["政治", "违法", "色情", "仇恨", "恐怖", "未成年人不当"];
  return bad.some(k => text.includes(k));
}

function buildBaseReply(_message: string): string {
  return `收到，你这个问题我建议先这样做：\n1) 明确你当前目标和限制；\n2) 按最小步骤先验证一版；\n3) 把结果发我，我再给你下一步优化。`;
}

function canSendContact(round: number, intentScore: number, userAskedContact: boolean): boolean {
  if (userAskedContact) return true;
  return round >= 3 && intentScore >= 0.75;
}

router.post("/draft", async (req, res) => {
  try {
    const body = req.body as DraftReq;
    const userId = body.userId;
    const message = (body.message || "").trim();
    const round = Number(body.round || 1);

    if (!userId || !message) {
      return res.status(400).json({ ok: false, error: "userId/message 必填" });
    }

    if (isSensitive(message)) {
      return res.json({ ok: true, mode: "manual_review", reason: "sensitive" });
    }

    const intentScore = calcIntentScore(message);
    const userAskedContact = /微信|qq|联系方式|怎么联系|私聊/i.test(message);
    const base = buildBaseReply(message);

    const wechat = process.env.BILI_WECHAT || "";
    const qq = process.env.BILI_QQ || "";

    let finalReply = base;
    let contactIncluded = false;
    let contactReason = "not_triggered";

    const shouldTryContact = canSendContact(round, intentScore, userAskedContact);

    if (shouldTryContact) {
      const key = contactKey(userId);
      const ttl = await redis.ttl(key);
      const inCooldown = ttl > 0;

      if (inCooldown) {
        contactReason = "cooldown_24h";
      } else if (!wechat && !qq) {
        contactReason = "contact_not_configured";
      } else {
        const contactParts: string[] = [];
        if (wechat) contactParts.push(`微信：${wechat}（备注：B站昵称）`);
        if (qq) contactParts.push(`QQ：${qq}`);

        finalReply += `\n\n如果你愿意，我可以继续1对1协助。可加${contactParts.join(" 或 ")}。`;
        contactIncluded = true;
        contactReason = "included";

        await redis.set(key, "1", "EX", CONTACT_COOLDOWN_SEC);
      }
    }

    return res.json({
      ok: true,
      data: {
        userId,
        round,
        intentScore,
        userAskedContact,
        contactIncluded,
        contactReason,
        replyText: finalReply
      }
    });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || "draft_failed" });
  }
});

router.post("/send", requireAdmin, sendLimiter, async (req, res) => {
  try {
    if (!BILI_SEND_ENABLED) {
      return res.status(403).json({ ok: false, error: "bili_send_disabled" });
    }

    const body = req.body as SendReq;
    const userId = (body.userId || "").trim();
    const replyText = (body.replyText || "").trim();
    const oid = String(body.oid || body.targetId || "").trim();
    const type = Number(body.type || 1);
    const root = String(body.root || "").trim();
    const parent = String(body.parent || "").trim();

    if (!userId || !replyText || !oid) {
      return res.status(400).json({ ok: false, error: "userId/replyText/oid(或targetId) 必填" });
    }

    const digest = payloadDigest({ userId, oid, replyText, type, root, parent });

    if (!body.confirm || !body.confirmToken) {
      const token = randomUUID();
      const key = confirmKey(token);
      await redis.set(
        key,
        JSON.stringify({ digest, userId, oid, type, root, parent }),
        "EX",
        BILI_SEND_CONFIRM_TTL_SEC
      );

      return res.status(409).json({
        ok: false,
        error: "manual_confirmation_required",
        confirmToken: token,
        expiresInSec: BILI_SEND_CONFIRM_TTL_SEC
      });
    }

    const key = confirmKey(body.confirmToken);
    const saved = await redis.get(key);
    if (!saved) {
      return res.status(409).json({ ok: false, error: "confirm_token_invalid_or_expired" });
    }

    await redis.del(key);

    const parsed = JSON.parse(saved) as { digest?: string };
    if (parsed.digest !== digest) {
      return res.status(409).json({ ok: false, error: "confirm_payload_mismatch" });
    }

    const sent = await dispatchBiliReply({ oid, message: replyText, type, root: root || undefined, parent: parent || undefined });

    return res.json({
      ok: true,
      data: { sent: true, userId, targetId: oid, rpid: sent.rpid || null }
    });
  } catch (e: any) {
    const msg = e?.message || "send_failed";
    const status = msg.includes("not configured") ? 500 : 502;
    return res.status(status).json({ ok: false, error: msg });
  }
});

export default router;
