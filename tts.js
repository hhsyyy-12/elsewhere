
// api/tts.js  ->  POST /api/tts
// 请求体(JSON)：{ text, voice_id, speed?, model?, vol?, pitch?, emotion? }
// 默认返回 audio/mpeg 二进制（前端 response.blob()）；
// 加 ?format=json 则返回 { ok, mime, audio_base64 }。
//
// 环境变量：MINIMAX_API_KEY（必填）、MINIMAX_GROUP_ID、MINIMAX_BASE_URL、ALLOWED_ORIGINS、ACCESS_CODE

const BASE = (process.env.MINIMAX_BASE_URL || "https://api.minimaxi.com").replace(/\/$/, "");
const MAX_TEXT = 1500;

function send(res, status, obj) {
  res.setHeader("Cache-Control", "no-store");
  res.status(status).json(obj);
}

function guard(req, res) {
  const origins = (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (origins.length) {
    const o = req.headers.origin;
    if (!o || !origins.includes(o)) { send(res, 403, { ok: false, error: "来源不被允许" }); return false; }
  }
  const code = process.env.ACCESS_CODE;
  if (code && req.headers["x-access-code"] !== code) { send(res, 401, { ok: false, error: "访问口令错误" }); return false; }
  return true;
}

const num = (v, d, lo, hi) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return send(res, 405, { ok: false, error: "Method Not Allowed" });
  if (!guard(req, res)) return;

  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) return send(res, 500, { ok: false, error: "服务端未配置 MINIMAX_API_KEY" });

  let p = req.body;
  if (typeof p === "string") { try { p = JSON.parse(p); } catch { p = null; } }
  if (!p || typeof p !== "object") return send(res, 400, { ok: false, error: "请求体必须是 JSON" });

  const text = String(p.text || "").trim();
  if (!text) return send(res, 400, { ok: false, error: "text 不能为空" });
  if (text.length > MAX_TEXT) return send(res, 413, { ok: false, error: `文本过长（上限 ${MAX_TEXT} 字）` });

  const vs = p.voice_setting || {};
  const voice_setting = {
    voice_id: String(p.voice_id || p.voiceId || vs.voice_id || "male-qn-qingse"),
    speed: num(p.speed ?? vs.speed, 1, 0.5, 2),
    vol: num(p.vol ?? p.volume ?? vs.vol, 1, 0.1, 10),
    pitch: Math.round(num(p.pitch ?? vs.pitch, 0, -12, 12)),
  };
  const emotion = p.emotion || vs.emotion;
  if (emotion) voice_setting.emotion = emotion;

  const payload = {
    model: p.model || "speech-2.8-hd",
    text,
    stream: false,
    voice_setting,
    audio_setting: { sample_rate: 32000, bitrate: 128000, format: "mp3", channel: 1 },
  };
  if (p.language_boost) payload.language_boost = p.language_boost;

  const gid = process.env.MINIMAX_GROUP_ID;
  const url = `${BASE}/v1/t2a_v2` + (gid ? `?GroupId=${encodeURIComponent(gid)}` : "");

  let j;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const raw = await r.text();
    try { j = JSON.parse(raw); } catch { return send(res, 502, { ok: false, http: r.status, raw: raw.slice(0, 500) }); }
  } catch (e) {
    return send(res, 502, { ok: false, error: e.message });
  }

  const code = j?.base_resp?.status_code;
  const hex = j?.data?.audio;
  if (code !== 0 || !hex) {
    return send(res, 400, { ok: false, status_code: code, status_msg: j?.base_resp?.status_msg || "未返回音频" });
  }

  const buf = Buffer.from(hex, "hex"); // MiniMax 返回 hex 字符串

  if (req.query && req.query.format === "json") {
    return send(res, 200, { ok: true, mime: "audio/mpeg", audio_base64: buf.toString("base64") });
  }
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Cache-Control", "no-store");
  res.status(200).send(buf);
};
