
// api/clone.js  ->  POST /api/clone
// 上传音频 -> 取 file_id（字符串，防精度丢失）-> 音色克隆 -> 返回 voice_id + 试听链接
//
// Vercel 环境变量（Project Settings > Environment Variables）：
//   MINIMAX_API_KEY    必填
//   MINIMAX_GROUP_ID   可选（新版接口通常不需要）
//   MINIMAX_BASE_URL   可选，默认 https://api.minimaxi.com（国际站：https://api.minimax.io）
//   ALLOWED_ORIGINS    可选，逗号分隔，例如 https://你的项目.vercel.app
//   ACCESS_CODE        可选，设置后前端需带请求头 x-access-code

const MAX_AUDIO_BYTES = 4 * 1024 * 1024; // Vercel 函数请求体上限 4.5MB
const MAX_RAW_BYTES = 4.4 * 1024 * 1024;
const VOICE_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{6,254}[A-Za-z0-9]$/;
const BASE = (process.env.MINIMAX_BASE_URL || "https://api.minimaxi.com").replace(/\/$/, "");

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

const withGroup = (url) => {
  const gid = process.env.MINIMAX_GROUP_ID;
  return gid ? `${url}${url.includes("?") ? "&" : "?"}GroupId=${encodeURIComponent(gid)}` : url;
};

// 直接读取原始请求流（Vercel 不会自动解析 multipart）
function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_RAW_BYTES) { reject(Object.assign(new Error("TOO_LARGE"), { code: "TOO_LARGE" })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return send(res, 405, { ok: false, error: "Method Not Allowed" });
  if (!guard(req, res)) return;

  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) return send(res, 500, { ok: false, error: "服务端未配置 MINIMAX_API_KEY" });

  // ---------- 1. 读取前端音频（兼容 multipart 和原始二进制） ----------
  let blob = null;
  let filename = "sample.wav";
  let voiceId = "";
  let model = "speech-2.8-hd";
  let previewText = "你好，很高兴认识你。";
  let denoise = false;

  try {
    const ct = req.headers["content-type"] || "";
    const raw = await readRaw(req);

    if (ct.includes("multipart/form-data")) {
      const form = await new Request("http://local/", {
        method: "POST",
        headers: { "content-type": ct },
        body: raw,
      }).formData();

      for (const k of ["file", "audio", "sample"]) {
        const v = form.get(k);
        if (v && typeof v === "object" && "arrayBuffer" in v) { blob = v; break; }
      }
      if (!blob) {
        for (const [, v] of form.entries()) {
          if (v && typeof v === "object" && "arrayBuffer" in v) { blob = v; break; }
        }
      }
      if (blob && blob.name) filename = blob.name;
      voiceId = String(form.get("voice_id") || form.get("voiceId") || "");
      model = String(form.get("model") || model);
      previewText = String(form.get("text") || previewText).slice(0, 300);
      denoise = String(form.get("need_noise_reduction") || "") === "true";
    } else {
      blob = new Blob([raw], { type: ct || "audio/wav" });
      voiceId = String((req.query && req.query.voice_id) || "");
    }
  } catch (e) {
    if (e.code === "TOO_LARGE")
      return send(res, 413, { ok: false, error: "音频过大，请压缩到 4MB 以内（建议 16kHz 单声道 WAV 或 MP3）" });
    return send(res, 400, { ok: false, error: "请求解析失败：" + e.message });
  }

  if (!blob || !blob.size) return send(res, 400, { ok: false, error: "没有收到音频文件" });
  if (blob.size > MAX_AUDIO_BYTES) return send(res, 413, { ok: false, error: "音频过大，请压缩到 4MB 以内" });
  if (!VOICE_ID_RE.test(voiceId)) voiceId = "ElseWhere" + Date.now().toString(36);

  // ---------- 2. 上传音频 ----------
  let fileId;
  try {
    const up = new FormData();
    up.append("purpose", "voice_clone");
    up.append("file", blob, filename);
    const upRes = await fetch(withGroup(`${BASE}/v1/files/upload`), {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: up,
    });
    const upText = await upRes.text();

    // 关键：用正则从原始文本取 file_id，始终当字符串处理，不经过 JSON.parse / Number
    const m = upText.match(/"file_id"\s*:\s*"?(\d+)"?/);
    if (!m) {
      let status_code, status_msg;
      try { const j = JSON.parse(upText); status_code = j?.base_resp?.status_code; status_msg = j?.base_resp?.status_msg; } catch {}
      return send(res, 502, { ok: false, step: "upload", http: upRes.status, status_code, status_msg, raw: upText.slice(0, 500) });
    }
    fileId = m[1]; // string
  } catch (e) {
    return send(res, 502, { ok: false, step: "upload", error: e.message });
  }

  // ---------- 3. 音色克隆 ----------
  // MiniMax 要求 file_id 在 JSON 中为整数：把字符串原样拼进 JSON 文本，
  // 不经过 Number，18 位 ID 不会丢精度。
  try {
    const body =
      `{"file_id":${fileId},` +
      `"voice_id":${JSON.stringify(voiceId)},` +
      `"text":${JSON.stringify(previewText)},` +
      `"model":${JSON.stringify(model)}` +
      (denoise ? `,"need_noise_reduction":true` : "") +
      `}`;

    const clRes = await fetch(withGroup(`${BASE}/v1/voice_clone`), {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body,
    });
    const clText = await clRes.text();
    let j;
    try { j = JSON.parse(clText); } catch { return send(res, 502, { ok: false, step: "clone", raw: clText.slice(0, 500) }); }

    const code = j?.base_resp?.status_code;
    if (code !== 0) {
      return send(res, 400, { ok: false, step: "clone", status_code: code, status_msg: j?.base_resp?.status_msg, file_id: fileId });
    }

    return send(res, 200, {
      ok: true,
      voice_id: voiceId,
      file_id: fileId,                   // 字符串
      demo_audio: j.demo_audio || "",    // 试听音频链接
      preview_url: j.demo_audio || "",   // 别名
      input_sensitive: j.input_sensitive ?? null,
    });
  } catch (e) {
    return send(res, 502, { ok: false, step: "clone", error: e.message, file_id: fileId });
  }
};
