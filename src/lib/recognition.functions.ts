import { z } from "zod";
import { createServerFn } from "@tanstack/react-start";

const GROQ_API = "https://api.groq.com/openai/v1";

// qwen/qwen3.6-27b đã bị Groq ngừng hoạt động từ 14/09/2026 -> dùng bản kế nhiệm.
// Có thể ghi đè bằng biến môi trường GROQ_VISION_MODEL khi Groq đổi model lần nữa.
const DEFAULT_VISION_MODEL = "qwen/qwen3.8-27b";
const getVisionModel = () =>
  process.env["GROQ_VISION_MODEL"]?.trim() || DEFAULT_VISION_MODEL;

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const DATA_URL_RE = /^data:image\/(png|jpe?g|webp|gif);base64,/i;

function groqErrorMessage(status: number, body: string) {
  let detail = body.slice(0, 300);
  try {
    detail = JSON.parse(body)?.error?.message ?? detail;
  } catch {
    /* body không phải JSON */
  }
  if (status === 401) return "GROQ_API_KEY không hợp lệ hoặc đã hết hạn.";
  if (status === 404)
    return `Model "${getVisionModel()}" không còn tồn tại trên Groq. Hãy cập nhật GROQ_VISION_MODEL. (${detail})`;
  if (status === 413) return "Ảnh quá lớn, vui lòng chọn ảnh nhỏ hơn.";
  return `Groq Vision API lỗi (${status}): ${detail}`;
}

function parseModelJson(raw: string) {
  const cleaned = raw.replace(/^```(?:json)?\s*|\s*```$/gi, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("invalid json");
    return JSON.parse(m[0]);
  }
}

const imageSchema = z.object({
  dataUrl: z.string().min(32),
});

export type GroqRateLimit = {
  limitTokens: number;
  remainingTokens: number;
  resetTokensSeconds: number;
};

export type ImageResult = {
  labels: {
    label: string;
    confidence: number;
  }[];
  summary: string;
  text: string | null;
  rateLimit?: GroqRateLimit | undefined;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
};

function readRateLimitHeaders(headers: Headers): GroqRateLimit | undefined {
  const limit = Number(headers.get("x-ratelimit-limit-tokens"));
  const remaining = Number(headers.get("x-ratelimit-remaining-tokens"));
  const resetRaw = headers.get("x-ratelimit-reset-tokens") ?? "";

  if (!Number.isFinite(limit) || !Number.isFinite(remaining)) {
    return undefined;
  }

  // Groq returns values such as "7.66s", "1m2.3s", or similar.
  let resetSeconds = 0;
  const minutes = resetRaw.match(/(\d+(?:\.\d+)?)m/);
  const seconds = resetRaw.match(/(\d+(?:\.\d+)?)s/);

  if (minutes) resetSeconds += Number(minutes[1]) * 60;
  if (seconds) resetSeconds += Number(seconds[1]);

  return {
    limitTokens: limit,
    remainingTokens: Math.max(0, remaining),
    resetTokensSeconds: Math.max(0, resetSeconds),
  };
}

function rateLimitErrorMessage(
  rateLimit: GroqRateLimit | undefined,
  body: string,
) {
  return `__GROQ_RATE_LIMIT__${JSON.stringify({
    rateLimit,
    body: body.slice(0, 500),
  })}`;
}

/* =========================
   NHẬN DẠNG HÌNH ẢNH
========================= */

export const analyzeImage = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => imageSchema.parse(data))
  .handler(async ({ data }): Promise<ImageResult> => {
    const apiKey = process.env["GROQ_API_KEY"];

    if (!apiKey) {
      throw new Error(
        "Thiếu GROQ_API_KEY. Hãy thêm GROQ_API_KEY vào file .env.",
      );
    }

    if (!DATA_URL_RE.test(data.dataUrl)) {
      throw new Error("Định dạng ảnh không được hỗ trợ (chỉ PNG, JPG, WEBP, GIF).");
    }
    if (data.dataUrl.length * 0.75 > MAX_IMAGE_BYTES) {
      throw new Error("Ảnh quá lớn, vui lòng chọn ảnh nhỏ hơn.");
    }

    const res = await fetch(`${GROQ_API}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: getVisionModel(),
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  "Phân tích hình ảnh này và trả về DUY NHẤT JSON hợp lệ. " +
                  '{"labels":[{"label":"tên tiếng Việt","confidence":95}],"summary":"mô tả ngắn","text":"văn bản trong ảnh hoặc null"}. ' +
                  "labels phải có từ 3 đến 6 mục. " +
                  "confidence là số từ 0 đến 100. " +
                  "text là toàn bộ văn bản có thể đọc được trong ảnh. " +
                  "Nếu không có văn bản thì text là null. " +
                  "Không thêm giải thích. Không thêm Markdown. Không thêm <think>.",
              },
              {
                type: "image_url",
                image_url: { url: data.dataUrl },
              },
            ],
          },
        ],
        reasoning_effort: "none",
        reasoning_format: "hidden",
        response_format: { type: "json_object" },
        temperature: 0.2,
        max_completion_tokens: 1000,
        stream: false,
      }),
    });

    const rateLimit = readRateLimitHeaders(res.headers);

    if (res.status === 429) {
      const body = await res.text().catch(() => "");
      throw new Error(rateLimitErrorMessage(rateLimit, body));
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(groqErrorMessage(res.status, body));
    }

    const json = (await res.json()) as {
      choices?: {
        message?: {
          content?: string;
        };
      }[];
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
    };

    const raw = json.choices?.[0]?.message?.content?.trim() ?? "";

    if (!raw) {
      throw new Error("Groq không trả về kết quả nhận dạng hình ảnh.");
    }

    try {
      const parsed = parseModelJson(raw) as Partial<ImageResult>;

      return {
        labels: Array.isArray(parsed.labels)
          ? parsed.labels
              .filter((l) => l && typeof l.label === "string")
              .map((l) => ({
                label: String(l.label),
                confidence: Math.max(
                  0,
                  Math.min(100, Number(l.confidence) || 0),
                ),
              }))
          : [],
        summary: typeof parsed.summary === "string" ? parsed.summary : "",
        text: typeof parsed.text === "string" ? parsed.text : null,
        rateLimit,
        usage: {
          promptTokens: Number(json.usage?.prompt_tokens) || 0,
          completionTokens: Number(json.usage?.completion_tokens) || 0,
          totalTokens: Number(json.usage?.total_tokens) || 0,
        },
      };
    } catch {
      console.error("Groq trả về JSON không hợp lệ:", raw);

      return {
        labels: [],
        summary: raw,
        text: null,
        rateLimit,
        usage: {
          promptTokens: Number(json.usage?.prompt_tokens) || 0,
          completionTokens: Number(json.usage?.completion_tokens) || 0,
          totalTokens: Number(json.usage?.total_tokens) || 0,
        },
      };
    }
  });

/* =========================
   CHUYỂN GIỌNG NÓI → VĂN BẢN
========================= */

const audioSchema = z.object({
  dataUrl: z.string().min(32),
  durationMs: z.number().nonnegative().optional(),
});

export type AudioResult = { text: string };

export const transcribeAudio = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => audioSchema.parse(data))
  .handler(async ({ data }): Promise<AudioResult> => {
    const apiKey = process.env["GROQ_API_KEY"];

    if (!apiKey) {
      throw new Error(
        "Thiếu GROQ_API_KEY. Hãy thêm GROQ_API_KEY vào file .env.",
      );
    }

    const base64 = data.dataUrl.split(",")[1] ?? "";
    if (!base64) {
      throw new Error("Không đọc được dữ liệu ghi âm.");
    }

    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

    if (bytes.byteLength < 2048) {
      throw new Error(
        "Bản ghi quá ngắn hoặc không có âm thanh. Hãy thử ghi lại.",
      );
    }

    const form = new FormData();
    form.append(
      "file",
      new Blob([bytes], { type: "audio/wav" }),
      "recording.wav",
    );
    form.append("model", "whisper-large-v3-turbo");
    form.append("language", "vi");
    form.append("response_format", "json");
    form.append("temperature", "0");

    const res = await fetch(`${GROQ_API}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Groq Whisper API lỗi (${res.status}): ${body.slice(0, 500)}`,
      );
    }

    const json = (await res.json()) as { text?: string };
    return { text: json.text?.trim() ?? "" };
  });

/* =========================
   KIỂM TRA TOKEN GROQ KHI MỞ TRANG
========================= */
export const getGroqRateLimit = createServerFn({ method: "POST" })
  .handler(async (): Promise<GroqRateLimit> => {
    const apiKey = process.env["GROQ_API_KEY"];
    if (!apiKey) {
      throw new Error(
        "Thiếu GROQ_API_KEY. Hãy thêm GROQ_API_KEY vào file .env.",
      );
    }

    // Một request cực nhỏ chỉ để lấy rate-limit headers của đúng model Vision.
    // Groq trả x-ratelimit-remaining-tokens ngay cả khi request thành công.
    const res = await fetch(`${GROQ_API}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: getVisionModel(),
        messages: [
          {
            role: "user",
            content: "Reply only: OK",
          },
        ],
        reasoning_effort: "none",
        reasoning_format: "hidden",
        max_completion_tokens: 1,
        temperature: 0,
        stream: false,
      }),
    });

    const rateLimit = readRateLimitHeaders(res.headers);

    if (rateLimit) {
      return rateLimit;
    }

    const body = await res.text().catch(() => "");
    throw new Error(
      `Không đọc được giới hạn token Groq (${res.status}): ${body.slice(0, 300)}`,
    );
  });
