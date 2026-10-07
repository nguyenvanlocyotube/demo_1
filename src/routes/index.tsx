import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  fetchHistory,
  fetchStats,
  deleteHistoryItem,
  formatBytes,
  formatTime,
  saveRecognition,
  uploadImage,
  type HistoryItem,
  type Stats,
} from "@/lib/history";
import {
  analyzeImage,
  getGroqRateLimit,
  transcribeAudio,
  type ImageResult,
  type GroqRateLimit,
} from "@/lib/recognition.functions";
import { prepareImage } from "@/lib/image";
import { startWavRecording, type WavRecorder } from "@/lib/wav-recorder";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "AI Video&Text — Nhận dạng hình ảnh & giọng nói" },
      {
        name: "description",
        content:
          "Tải ảnh hoặc ghi âm để nhận dạng bằng AI. Ảnh và kết quả ghi âm sẽ được lưu lại, số lượng Token sẽ tính theo mỗi lần tải tệp lên.",
      },
      { property: "og:title", content: "AI Video&Text" },
      {
        property: "og:description",
        content:
          "Nhận dạng ảnh, chuyển giọng nói thành văn bản, kho lưu trữ ảnh và số lần tải tệp lên hệ thống.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

const STORAGE_QUOTA = 1024 * 1024 * 1024; // 1 GB dung lượng kho ảnh

function pct(value: number, max: number) {
  if (max <= 0) return 0;
  return Math.max(2, Math.min(100, Math.round((value / max) * 100)));
}

function num(n: number) {
  return n.toLocaleString("vi-VN");
}

const GROQ_USAGE_HISTORY_KEY = "groq-image-token-usage-qwen3.6-27b";
const DEFAULT_TOKENS_PER_IMAGE = 2500;
const MAX_USAGE_SAMPLES = 12;
const GROQ_RATE_LIMIT_STORAGE_KEY = "groq-rate-limit-qwen3.6-27b";

function loadTokenUsageSamples(): number[] {
  try {
    const raw = window.localStorage.getItem(GROQ_USAGE_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (value): value is number =>
        typeof value === "number" && Number.isFinite(value) && value > 0,
    ).slice(-MAX_USAGE_SAMPLES);
  } catch {
    return [];
  }
}

function saveTokenUsageSample(totalTokens: number) {
  if (!Number.isFinite(totalTokens) || totalTokens <= 0) return;
  const samples = [...loadTokenUsageSamples(), Math.ceil(totalTokens)].slice(
    -MAX_USAGE_SAMPLES,
  );
  try {
    window.localStorage.setItem(
      GROQ_USAGE_HISTORY_KEY,
      JSON.stringify(samples),
    );
  } catch {
    // Bỏ qua nếu trình duyệt không cho phép localStorage.
  }
}

function averageTokensPerImage(samples: number[]) {
  if (!samples.length) return DEFAULT_TOKENS_PER_IMAGE;
  return Math.max(
    1,
    Math.round(samples.reduce((sum, value) => sum + value, 0) / samples.length),
  );
}

function Index() {
  const runAnalyzeImage = useServerFn(analyzeImage);
  const runGetGroqRateLimit = useServerFn(getGroqRateLimit);
  const runTranscribe = useServerFn(transcribeAudio);
  const queryClient = useQueryClient();

  const statsQuery = useQuery<Stats>({
    queryKey: ["stats"],
    queryFn: fetchStats,
    refetchInterval: 20000,
  });
  const historyQuery = useQuery<HistoryItem[]>({
    queryKey: ["history"],
    queryFn: () => fetchHistory(),
    refetchInterval: 60000,
  });

  const stats = statsQuery.data;
  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["stats"] });
    void queryClient.invalidateQueries({ queryKey: ["history"] });
  }, [queryClient]);

  const fileInput = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<WavRecorder | null>(null);

  const [imageFiles, setImageFiles] = useState<
    { name: string; size: number; url: string }[]
  >([]);
  const [imageBusy, setImageBusy] = useState(false);
  const [imageResult, setImageResult] = useState<ImageResult | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [imageBatchProgress, setImageBatchProgress] = useState({
    done: 0,
    total: 0,
    status: "",
  });
  const [groqRateLimit, setGroqRateLimit] = useState<GroqRateLimit | null>(
    null,
  );
  const [groqResetSeconds, setGroqResetSeconds] = useState(0);
  const [groqResetAt, setGroqResetAt] = useState<number | null>(null);
  const [groqProbeLoading, setGroqProbeLoading] = useState(true);
  const [tokenUsageSamples, setTokenUsageSamples] = useState<number[]>([]);
  const [selectedImage, setSelectedImage] = useState<HistoryItem | null>(null);

  const cursorGlowRef = useRef<HTMLDivElement>(null);
  const cursorGlowSecondaryRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const primary = cursorGlowRef.current;
    const secondary = cursorGlowSecondaryRef.current;
    if (!primary || !secondary) return;

    let targetX = window.innerWidth / 2;
    let targetY = window.innerHeight / 2;
    let currentX = targetX;
    let currentY = targetY;
    let frame = 0;

    const move = (event: MouseEvent) => {
      targetX = event.clientX;
      targetY = event.clientY;
    };

    const animate = () => {
      currentX += (targetX - currentX) * 0.08;
      currentY += (targetY - currentY) * 0.08;

      primary.style.transform = `translate3d(${currentX - 210}px, ${currentY - 210}px, 0)`;
      secondary.style.transform = `translate3d(${currentX - 145}px, ${currentY - 145}px, 0)`;

      frame = requestAnimationFrame(animate);
    };

    window.addEventListener("mousemove", move, { passive: true });
    frame = requestAnimationFrame(animate);

    return () => {
      window.removeEventListener("mousemove", move);
      cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    if (!groqResetAt) {
      setGroqResetSeconds(0);
      return;
    }

    const updateCountdown = () => {
      const remainingMs = Math.max(0, groqResetAt - Date.now());
      const seconds = Math.ceil(remainingMs / 1000);
      setGroqResetSeconds(seconds);

      // Khi cửa sổ TPM đã reset, cho UI hiển thị lại đầy đủ quota ngay lập tức.
      // Request Groq tiếp theo sẽ cập nhật lại con số thực tế từ response header.
      if (seconds <= 0) {
        setGroqRateLimit((current) => {
          if (!current) return current;
          const resetLimit = {
            ...current,
            remainingTokens: current.limitTokens,
          };
          try {
            window.localStorage.setItem(
              GROQ_RATE_LIMIT_STORAGE_KEY,
              JSON.stringify({ ...resetLimit, resetAt: Date.now() }),
            );
          } catch {
            // Bỏ qua nếu localStorage không khả dụng.
          }
          return resetLimit;
        });
      }
    };

    updateCountdown();
    const timer = window.setInterval(updateCountdown, 1000);

    return () => window.clearInterval(timer);
  }, [groqResetAt]);

  // Khi mở trang, gửi một request cực nhỏ tới đúng model Groq Vision để lấy
  // x-ratelimit-remaining-tokens. Giá trị này được cache để F5 không bị trống.
  useEffect(() => {
    let cachedResetAt: number | null = null;
    let hasValidCache = false;

    try {
      const cached = window.localStorage.getItem(GROQ_RATE_LIMIT_STORAGE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached) as GroqRateLimit & { resetAt?: number };
        if (
          Number.isFinite(parsed.limitTokens) &&
          Number.isFinite(parsed.remainingTokens)
        ) {
          setGroqRateLimit(parsed);
          cachedResetAt = Number(parsed.resetAt);
          if (Number.isFinite(cachedResetAt) && cachedResetAt > Date.now()) {
            setGroqResetAt(cachedResetAt);
            hasValidCache = true;
          }
        }
      }
    } catch {
      // Bỏ qua cache lỗi.
    }

    setTokenUsageSamples(loadTokenUsageSamples());

    // Nếu countdown cũ vẫn còn hiệu lực thì KHÔNG probe lại khi F5.
    // Nếu probe lại, Groq trả một khoảng reset mới và countdown sẽ bị khởi động lại.
    if (hasValidCache) return;

    let cancelled = false;

    const probe = async () => {
      setGroqProbeLoading(true);
      try {
        const rateLimit = await runGetGroqRateLimit();
        if (cancelled) return;

        setGroqRateLimit(rateLimit);
        const resetAt = Date.now() + Math.max(0, rateLimit.resetTokensSeconds) * 1000;
        setGroqResetAt(resetAt);
        window.localStorage.setItem(
          GROQ_RATE_LIMIT_STORAGE_KEY,
          JSON.stringify({ ...rateLimit, resetAt }),
        );
      } catch (error) {
        console.error("Không kiểm tra được Token Groq:", error);
      } finally {
        if (!cancelled) setGroqProbeLoading(false);
      }
    };

    void probe();

    return () => {
      cancelled = true;
    };
  }, [runGetGroqRateLimit]);

  const [recording, setRecording] = useState(false);
  const [levels, setLevels] = useState<number[]>(new Array(24).fill(0.25));
  const [audioBusy, setAudioBusy] = useState(false);
  const [transcript, setTranscript] = useState<{ text: string; durationMs: number } | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);

  const handleFiles = useCallback(
    async (files: File[]) => {
      const imageFilesOnly = files.filter((file) =>
        file.type.startsWith("image/"),
      );

      if (!imageFilesOnly.length) return;

      setImageError(null);
      setImageResult(null);
      setImageBatchProgress({
        done: 0,
        total: imageFilesOnly.length,
        status: "",
      });
      let previews: { name: string; size: number; url: string }[];
      try {
        previews = await Promise.all(
          imageFilesOnly.map(async (file) => ({
            name: file.name,
            size: file.size,
            url: await prepareImage(file),
          })),
        );
      } catch (err) {
        setImageError(err instanceof Error ? err.message : "Không đọc được ảnh.");
        return;
      }

      setImageFiles(previews);
      setImageBusy(true);

      const results: ImageResult[] = [];
      const errors: string[] = [];

      try {
        // Xử lý tuần tự để không gửi 12 request AI cùng lúc.
        // Điều này tránh nghẽn server/rate-limit và đảm bảo tiến trình
        // luôn đi từ 1/12 → 2/12 → ... → 12/12.
        for (let index = 0; index < imageFilesOnly.length; index += 1) {
          const file = imageFilesOnly[index];
          if (!file) continue;
          const dataUrl = previews[index]?.url;
          if (!dataUrl) {
            setImageBatchProgress((current) => ({
              ...current,
              done: current.done + 1,
            }));
            continue;
          }

          const started = Date.now();

          try {
            let result: ImageResult | null = null;

            // Groq có giới hạn token/phút. Tự động chờ và thử lại khi gặp 429
            // thay vì đánh dấu ảnh là lỗi ngay lập tức.
            for (let attempt = 0; attempt < 8; attempt += 1) {
              try {
                result = await runAnalyzeImage({ data: { dataUrl } });

                if (result.rateLimit) {
                  setGroqRateLimit(result.rateLimit);
                  const resetAt =
                    Date.now() +
                    Math.max(0, result.rateLimit.resetTokensSeconds) * 1000;
                  setGroqResetAt(resetAt);
                  window.localStorage.setItem(
                    GROQ_RATE_LIMIT_STORAGE_KEY,
                    JSON.stringify({ ...result.rateLimit, resetAt }),
                  );

                  const ratio =
                    result.rateLimit.remainingTokens /
                    Math.max(1, result.rateLimit.limitTokens);

                  setImageBatchProgress((current) => ({
                    ...current,
                    status:
                      ratio <= 0.1
                        ? "Sắp chạm giới hạn token — đang xử lý chậm để tránh lỗi."
                        : "",
                  }));
                }

                if (result.usage?.totalTokens) {
                  const usage = Math.ceil(result.usage.totalTokens);
                  saveTokenUsageSample(usage);
                  setTokenUsageSamples(loadTokenUsageSamples());
                }

                break;
              } catch (error) {
                const message =
                  error instanceof Error ? error.message : String(error);

                if (!message.startsWith("__GROQ_RATE_LIMIT__")) {
                  throw error;
                }

                let rateLimit: GroqRateLimit | undefined;

                try {
                  const payload = JSON.parse(
                    message.replace("__GROQ_RATE_LIMIT__", ""),
                  ) as { rateLimit?: GroqRateLimit };
                  rateLimit = payload.rateLimit;
                } catch {
                  // Fallback nếu server không gửi metadata.
                }

                if (rateLimit) {
                  setGroqRateLimit(rateLimit);
                  const reset = Math.max(
                    1,
                    Math.ceil(rateLimit.resetTokensSeconds),
                  );
                  const resetAt = Date.now() + reset * 1000;
                  setGroqResetAt(resetAt);
                  window.localStorage.setItem(
                    GROQ_RATE_LIMIT_STORAGE_KEY,
                    JSON.stringify({ ...rateLimit, resetAt }),
                  );
                  setImageBatchProgress((current) => ({
                    ...current,
                    status: `Token gần đầy — tự động chờ ${reset} giây rồi tiếp tục...`,
                  }));

                  await new Promise((resolve) =>
                    setTimeout(resolve, reset * 1000 + 300),
                  );
                  continue;
                }

                const waitMs = Math.min(60000, 5000 * 2 ** attempt);
                const waitSeconds = Math.ceil(waitMs / 1000);

                setGroqResetAt(Date.now() + waitMs);
                setImageBatchProgress((current) => ({
                  ...current,
                  status: `Đang chờ giới hạn API... ${waitSeconds} giây`,
                }));

                await new Promise((resolve) =>
                  setTimeout(resolve, waitMs),
                );
              }
            }

            if (!result) {
              throw new Error(
                "Groq đang giới hạn số token/phút. Hãy thử lại sau.",
              );
            }

            const path = await uploadImage(file);
            if (!path) console.warn("Không lưu được ảnh vào kho — kiểm tra bucket recognition-images.");
            results.push(result);

            await saveRecognition({
              kind: "image",
              file_name: file.name,
              image_path: path,
              bytes: file.size,
              labels: result.labels,
              summary: result.summary,
              ocr_text: result.text,
              latency_ms: Date.now() - started,
            });
          } catch (err) {
            errors.push(
              `${file.name}: ${
                err instanceof Error
                  ? err.message
                  : "Không phân tích được hình ảnh."
              }`,
            );
          } finally {
            setImageBatchProgress((current) => ({
              ...current,
              done: current.done + 1,
              status: "",
            }));
          }
        }

        if (results.length) {
          const allLabels = results.flatMap((result) => result.labels);
          const allSummaries = results
            .map((result) => result.summary?.trim())
            .filter(Boolean);
          const allTexts = results
            .map((result) => result.text?.trim())
            .filter(Boolean);

          setImageResult({
            labels: allLabels,
            summary: allSummaries.join(" "),
            text: allTexts.length ? allTexts.join("\n") : null,
          });
        }

        if (errors.length) {
          const visibleError = errors.find(
            (error) =>
              !error.includes("429") &&
              !error.includes("Rate limit") &&
              !error.includes("rate_limit"),
          );

          setImageError(
            visibleError
              ? `${errors.length}/${imageFilesOnly.length} ảnh không xử lý được. ${visibleError}`
              : null,
          );
        }

        refresh();
      } finally {
        setImageBusy(false);
      }
    },
    [runAnalyzeImage, refresh],
  );

  const handleFile = useCallback(
    async (file: File) => {
      await handleFiles([file]);
    },
    [handleFiles],
  );


  const toggleRecording = useCallback(async () => {
    setAudioError(null);
    if (recording) {
      const recorder = recorderRef.current;
      recorderRef.current = null;
      setRecording(false);
      if (!recorder) return;
      setAudioBusy(true);
      const started = Date.now();
      try {
        const { dataUrl, durationMs } = await recorder.stop();
        const { text } = await runTranscribe({ data: { dataUrl, durationMs } });
        setTranscript({ text: text || "(không nhận được nội dung)", durationMs });
        await saveRecognition({
          kind: "audio",
          file_name: "Nhấp vào ghi âm để chuyển thành văn bản",
          bytes: Math.round((dataUrl.length * 3) / 4),
          transcript: text,
          duration_ms: Math.round(durationMs),
          latency_ms: Date.now() - started,
        });
        refresh();
      } catch (err) {
        setAudioError(err instanceof Error ? err.message : "Không trích xuất được âm thanh.");
      } finally {
        setAudioBusy(false);
      }
      return;
    }
    try {
      setTranscript(null);
      recorderRef.current = await startWavRecording(setLevels);
      setRecording(true);
    } catch {
      setAudioError("Không truy cập được micro. Hãy cho phép quyền ghi âm trong trình duyệt.");
    }
  }, [recording, runTranscribe, refresh]);

  const estimatedTokensPerImage = averageTokensPerImage(tokenUsageSamples);
  const estimatedImagesAvailable = groqRateLimit
    ? Math.max(
        0,
        Math.floor(
          groqRateLimit.remainingTokens / Math.max(1, estimatedTokensPerImage),
        ),
      )
    : 0;
  const selectedImageCount = imageFiles.length;
  const estimatedBatchTokens = selectedImageCount * estimatedTokensPerImage;
  const batchPredictionText = groqRateLimit
    ? selectedImageCount > 0
      ? estimatedImagesAvailable >= selectedImageCount
        ? `Ước tính đủ cho ${estimatedImagesAvailable} ảnh · batch này khoảng ${num(estimatedBatchTokens)} token`
        : `Ước tính chỉ đủ ${estimatedImagesAvailable} / ${selectedImageCount} ảnh · nên chờ reset hoặc giảm số ảnh`
      : `Ước tính còn đủ khoảng ${estimatedImagesAvailable} ảnh`
    : "Đang chờ dữ liệu token để tính";

  const resources = [
    {
      name: "Dịch vụ AI",
      value: stats ? num(stats.total) : "—",
      meta: stats ? `${num(stats.images)} ảnh · ${num(stats.audios)} ghi âm` : "đang tải…",
      state: "ok" as const,
      status: stats && stats.last_hour > 0 ? "Đang chạy" : "Rảnh",
    },
    {
      name: "Cơ sở dữ liệu",
      value: stats ? num(stats.total) : "—",
      meta: stats ? `${num(stats.labels)} nhãn đã lưu · ${num(stats.active_days)} ngày dữ liệu` : "đang tải…",
      state: "ok" as const,
      status: "Hoạt động",
    },
    {
      name: "Kho lưu trữ ảnh",
      value: stats ? formatBytes(stats.bytes) : "—",
      meta: stats
        ? `${num(stats.images)} tệp · ${pct(stats.bytes, STORAGE_QUOTA)}% của 1 GB`
        : "đang tải…",
      state:
        stats && stats.bytes > STORAGE_QUOTA * 0.8 ? ("warn" as const) : ("ok" as const),
      status: stats && stats.bytes > STORAGE_QUOTA * 0.8 ? "Gần đầy" : "Còn trống",
    },
    {
      name: "Lưu lượng mạng",
      value: stats ? `${num(stats.last_24h)}/24h` : "—",
      meta: stats ? `${num(stats.last_hour)} trong 1 giờ · ${num(stats.last_7d)} trong 7 ngày` : "đang tải…",
      state: "ok" as const,
      status: stats && stats.last_hour > 0 ? "Có lưu lượng" : "Im lặng",
    },
    {
      name: "Token Groq còn lại",
      value: groqRateLimit ? groqRateLimit.remainingTokens.toLocaleString("vi-VN") : "—",
      meta: groqRateLimit
        ? `/${groqRateLimit.limitTokens.toLocaleString("vi-VN")} token · ~${num(estimatedImagesAvailable)} ảnh · reset ${groqResetSeconds > 0 ? `${groqResetSeconds}s` : "sắp cập nhật"}`
        : groqProbeLoading
          ? "đang kiểm tra…"
          : "chưa có dữ liệu token",
      state:
        groqRateLimit &&
        groqRateLimit.remainingTokens / Math.max(1, groqRateLimit.limitTokens) <= 0.1
          ? ("warn" as const)
          : ("ok" as const),
      status:
        groqProbeLoading && !groqRateLimit
          ? "Đang kiểm tra"
          : groqRateLimit &&
        groqRateLimit.remainingTokens / Math.max(1, groqRateLimit.limitTokens) <= 0.1
          ? "Sắp hết"
          : "Khả dụng",
    },
  ];

  const metrics = [
    {
      label: "Lượt nhận dạng",
      value: stats ? num(stats.total) : "—",
      pct: stats ? pct(stats.last_24h, Math.max(stats.total, 1)) : 0,
      tone: "primary",
    },
    {
      label: "Dung lượng đã dùng",
      value: stats ? formatBytes(stats.bytes) : "—",
      pct: stats ? pct(stats.bytes, STORAGE_QUOTA) : 0,
      tone: "amber",
    },
    {
      label: "Độ trễ trung bình",
      value: stats ? `${num(stats.avg_latency_ms)}ms` : "—",
      pct: stats ? pct(stats.avg_latency_ms, 8000) : 0,
      tone: "primary",
    },
    {
      label: "Âm thanh đã xử lý",
      value: stats ? `${num(stats.audio_seconds)}s` : "—",
      pct: stats ? pct(stats.audio_seconds, 600) : 0,
      tone: "primary",
    },
  ];

  return (
    <>
    <div className="relative min-h-screen overflow-x-hidden bg-background font-body text-foreground antialiased [scrollbar-width:none] [&::-webkit-scrollbar]:w-0 [&::-webkit-scrollbar]:h-0">
      <div
        ref={cursorGlowRef}
        className="pointer-events-none fixed left-0 top-0 z-0 hidden size-[420px] rounded-full bg-primary/10 blur-[90px] will-change-transform sm:block"
        aria-hidden="true"
      />
      <div
        ref={cursorGlowSecondaryRef}
        className="pointer-events-none fixed left-0 top-0 z-0 hidden size-[290px] rounded-full bg-amber/5 blur-[75px] will-change-transform sm:block"
        aria-hidden="true"
      />
      <div className="pointer-events-none absolute inset-0">
        <div
          className="absolute -top-40 -left-32 h-[520px] w-[520px] rounded-full bg-primary/25 blur-[130px]"
          style={{ animation: "auroraShift 22s ease-in-out infinite" }}
        />
        <div
          className="absolute top-1/3 -right-24 h-[460px] w-[460px] rounded-full bg-amber/20 blur-[130px]"
          style={{ animation: "auroraShift2 26s ease-in-out infinite" }}
        />
        <div
          className="absolute bottom-0 left-1/3 h-[400px] w-[600px] rounded-full bg-primary/10 blur-[140px]"
          style={{ animation: "auroraShift 30s ease-in-out infinite" }}
        />
      </div>

      <div className="tech-grid pointer-events-none absolute inset-x-0 top-0 h-[720px]" aria-hidden="true" />

      <div className="relative">
        <header className="fixed inset-x-0 top-0 z-50 border-b border-line bg-background/80 backdrop-blur-md">
          <div className="mx-auto flex min-w-0 w-full max-w-[1400px] items-center gap-2 px-3 py-2.5 sm:gap-4 sm:px-6 sm:py-3.5">
            <button
              type="button"
              onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
              className="flex min-w-0 shrink items-center gap-2 rounded-lg text-left outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-primary/40 sm:shrink-0 sm:gap-2.5"
              aria-label="Về trang chủ"
            >
              <span className="grid size-7 shrink-0 place-items-center rounded-md bg-primary/15 ring-1 ring-primary/30">
                <span className="pulse-glow size-2 rounded-full bg-primary" />
              </span>
              <span className="truncate font-display text-[clamp(0.78rem,3.5vw,0.94rem)] font-bold tracking-tight">
                AI Video&amp;Text
              </span>
              <span className="hidden font-mono text-[10px] uppercase tracking-[0.2em] text-faint sm:inline">
                Cloud
              </span>
            </button>
            <nav className="ml-4 hidden items-center gap-1 md:flex">
              <a href="#nhan-dang" className="rounded-md px-3 py-1.5 text-sm text-foreground/90">
                Nhận dạng
              </a>
              <a
                href="#kho-luu-tru"
                className="rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                Kho lưu trữ
              </a>
              <a
                href="#tai-nguyen"
                className="rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                Tài nguyên
              </a>
            </nav>
            <div className="ml-auto flex min-w-0 shrink-0 items-center gap-1 sm:gap-3">
              <span className="hidden items-center gap-1.5 rounded-full border border-line bg-panel/60 px-3 py-1.5 font-mono text-[11px] text-muted-foreground sm:flex">
                <span className="pulse-glow size-1.5 rounded-full bg-primary" />
                {stats ? `${num(stats.total)} lượt đã lưu` : "Đang kết nối"}
              </span>
              <button
                onClick={() => fileInput.current?.click()}
                className="btn-glow whitespace-nowrap rounded-lg bg-primary px-2.5 py-2 text-[clamp(0.68rem,2.8vw,0.875rem)] font-medium text-primary-foreground transition-all hover:brightness-110 hover:ring-2 hover:ring-primary/40 sm:px-4"
              >
                Phân tích ngay
              </button>
            </div>
          </div>
        </header>

        <section className="mx-auto w-full max-w-[1400px] px-3.5 pt-[88px] pb-8 sm:px-6 sm:pt-[108px] sm:pb-10">
          <div className="rise-in flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between lg:gap-8">
            <div className="max-w-xl">
              <div className="mb-4 inline-flex max-w-full items-center gap-2 rounded-full border border-line bg-panel/50 px-3 py-1 font-mono text-[clamp(0.62rem,2.4vw,0.69rem)] uppercase tracking-[0.14em] text-primary sm:tracking-[0.18em]">
                Nhận dạng hình ảnh &amp; giọng nói
              </div>
              <h1 className="font-display text-[clamp(2rem,8vw,2.75rem)] font-bold leading-[1.05] tracking-tight text-balance">
                Chuyển giọng nói thành <span className="gradient-text">Văn Bản</span> rõ ràng
              </h1>
              <p className="mt-4 max-w-2xl text-pretty text-[clamp(0.875rem,2vw,0.94rem)] leading-relaxed text-muted-foreground">
                Tải ảnh hoặc ghi âm để nhận dạng. Mọi ảnh và kết quả đều được lưu vào kho lưu trữ và
                cơ sở dữ liệu, số liệu bên dưới tính theo lưu lượng tải lên hệ thống.
              </p>
            </div>
            <div className="hidden shrink-0 items-center gap-6 font-mono text-[11px] text-faint lg:flex">
              <div className="text-right">
                <div className="text-[13px] text-foreground">
                  {stats ? num(stats.last_24h) : "—"}
                </div>
                lượt / 24 giờ
              </div>
              <div className="text-right">
                <div className="text-[13px] text-foreground">
                  {stats ? formatBytes(stats.bytes) : "—"}
                </div>
                ảnh đã lưu
              </div>
              <div className="text-right">
                <div className="text-[13px] text-primary">
                  {stats ? `${num(stats.avg_latency_ms)}ms` : "—"}
                </div>
                độ trễ trung bình
              </div>
            </div>
          </div>
        </section>

        <section id="nhan-dang" className="mx-auto grid w-full max-w-[1400px] min-w-0 gap-4 px-3.5 sm:gap-5 sm:px-6 lg:grid-cols-2">
          {/* INPUT */}
          <div className="min-w-0 glass-card rounded-2xl p-2.5 sm:p-5">
            <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2 sm:mb-4">
              <h2 className="min-w-0 font-display text-[clamp(0.82rem,2.2vw,0.94rem)] font-medium leading-snug tracking-tight">
                Nhận dạng giọng nói và hình ảnh, phân tích bằng AI chính xác tuyệt đối !
              </h2>
              <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-faint">
                Đầu vào
              </span>
            </div>

            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                if (files.length) void handleFiles(files);
                e.target.value = "";
              }}
            />

            {/* image */}
            <div
              className="grid min-w-0 grid-cols-[42px_minmax(0,1fr)] gap-2 sm:grid-cols-[72px_1fr] sm:gap-4"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const files = Array.from(e.dataTransfer.files ?? []);
                if (files.length) void handleFiles(files);
              }}
            >
              <div className={`${imageBusy ? "scan " : ""}grid size-11 shrink-0 place-items-center overflow-hidden rounded-lg bg-background/60 outline-1 -outline-offset-1 outline-primary/40 sm:size-[72px] sm:rounded-xl`}>
                {imageFiles.length ? (
                  <div className="grid size-full grid-cols-2 gap-px bg-line">
                    {imageFiles.slice(0, 4).map((file) => (
                      <img
                        key={`${file.name}-${file.size}`}
                        src={file.url}
                        alt={`Ảnh đã tải lên: ${file.name}`}
                        className="size-full min-h-0 min-w-0 object-cover"
                      />
                    ))}
                  </div>
                ) : (
                  <span className="text-[9px] font-medium uppercase tracking-[0.15em] text-faint">
                    Image
                  </span>
                )}
              </div>
              <div className="min-w-0 rounded-lg border border-line bg-background/40 p-2.5 sm:rounded-xl sm:p-4">
                <div className="flex min-w-0 flex-wrap items-center justify-between gap-2.5">
                  <span className="min-w-0 flex-1 truncate font-mono text-[clamp(0.66rem,2.2vw,0.69rem)] text-foreground">
                    {imageFiles.length ? (
                      <>
                        {imageFiles.length === 1
                          ? imageFiles[0]?.name
                          : `${imageFiles.length} ảnh đã chọn`}
                      </>
                    ) : (
                      <i>
                        Chưa có tệp nào được tải lên — có thể chọn nhiều ảnh cùng lúc
                      </i>
                    )}
                  </span>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 font-mono text-[10px] ${
                      imageBusy
                        ? "bg-amber/15 text-amber"
                        : imageResult
                          ? "bg-primary/15 text-primary"
                          : "bg-panel-2/60 text-faint"
                    }`}
                  >
                    {imageBusy
                      ? imageBatchProgress.total > 1
                        ? `Đang xử lý ${imageBatchProgress.done}/${imageBatchProgress.total}`
                        : "Đang xử lý"
                      : imageResult
                        ? imageBatchProgress.total > 1
                          ? `Đã xử lý ${imageBatchProgress.total} ảnh`
                          : "Đã lưu"
                        : "Chờ phản hồi"}
                  </span>
                </div>

                {groqRateLimit ? (
                  <div className="mt-2 flex flex-wrap items-center gap-2 font-mono text-[10px]">
                    <span
                      className={`rounded-full border px-2.5 py-1 ${
                        groqRateLimit.remainingTokens <=
                        groqRateLimit.limitTokens * 0.1
                          ? "border-red-500/30 bg-red-500/10 text-red-400"
                          : groqRateLimit.remainingTokens <=
                              groqRateLimit.limitTokens * 0.25
                            ? "border-amber/30 bg-amber/10 text-amber"
                            : "border-primary/20 bg-primary/5 text-muted-foreground"
                      }`}
                    >
                      Token đã dùng{" "}
                      {Math.max(
                        0,
                        groqRateLimit.limitTokens -
                          groqRateLimit.remainingTokens,
                      ).toLocaleString("vi-VN")}
                      {" / "}
                      {groqRateLimit.limitTokens.toLocaleString("vi-VN")}
                    </span>

                    <span className="rounded-full border border-border bg-muted/30 px-2.5 py-1 text-faint">
                      Còn{" "}
                      {groqRateLimit.remainingTokens.toLocaleString("vi-VN")}
                      token · reset{" "}
                      {groqResetSeconds > 0
                        ? `${groqResetSeconds}s`
                        : "đang cập nhật"}
                    </span>
                    <span className="rounded-full border border-border bg-muted/30 px-2.5 py-1 text-faint">
                      ~{num(estimatedTokensPerImage)} token/ảnh
                    </span>
                  </div>
                ) : null}

                {imageBatchProgress.status ? (
                  <div className="mt-2 font-mono text-[10px] text-amber">
                    {imageBatchProgress.status}
                  </div>
                ) : null}

                {groqRateLimit && selectedImageCount > 0 ? (
                  <div
                    className={`mt-2 rounded-lg border px-3 py-2 font-mono text-[10px] leading-relaxed ${
                      estimatedImagesAvailable < selectedImageCount
                        ? "border-amber/30 bg-amber/5 text-amber"
                        : "border-primary/20 bg-primary/5 text-muted-foreground"
                    }`}
                  >
                    <div>{batchPredictionText}</div>
                    <div className="mt-0.5 text-faint">
                      Dự đoán dựa trên trung bình {num(estimatedTokensPerImage)} token/ảnh
                      {tokenUsageSamples.length
                        ? ` từ ${tokenUsageSamples.length} lần xử lý gần nhất`
                        : " (mức ước tính ban đầu)"}
                    </div>
                  </div>
                ) : null}

                <div className="hidden flex-wrap items-center gap-1.5 font-mono text-[clamp(0.68rem,2.2vw,0.75rem)] text-muted-foreground sm:flex">
                  <span className="rounded-full border border-border bg-muted/40 px-3 py-1">
                      <i>PNG</i>
                    </span>
                    &bull;
                    <span className="rounded-full border border-border bg-muted/40 px-3 py-1">
                      <i>JPG</i>
                    </span>
                    &bull;
                    <span className="rounded-full border border-border bg-muted/40 px-3 py-1">
                      <i>WEBP</i>
                    </span>
                    &bull;
                    <span className="rounded-full border border-border bg-muted/40 px-3 py-1">
                      <i>JPEG</i>
                    </span>
                </div>
                <p className="mt-2 hidden font-mono text-[clamp(0.62rem,2vw,0.69rem)] leading-relaxed text-faint sm:block">
                  Bạn có thể chọn 2, 3, 4 hoặc nhiều ảnh cùng lúc. AI sẽ xử lý từng ảnh và lưu riêng từng kết quả.
                </p>
                <div className="mt-2 flex flex-wrap gap-2 sm:mt-3">
                  <button
                    onClick={() => fileInput.current?.click()}
                    className="rounded-lg border border-line bg-panel-2/60 px-3 py-2 text-[12px] text-foreground/90 transition-colors hover:border-primary/40 hover:text-foreground"
                  >
                    Tải ảnh lên
                  </button>
                  <button
                    onClick={() => {
                      setImageFiles([]);
                      setImageResult(null);
                      setImageError(null);
                      setImageBatchProgress({ done: 0, total: 0, status: "" });
                    }}
                    className="rounded-lg border border-line bg-panel-2/60 px-3 py-2 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
                  >
                    Xóa
                  </button>
                </div>
                {imageError ? (
                  <p className="mt-2 font-mono text-[11px] text-destructive">{imageError}</p>
                ) : null}
              </div>
            </div>

            {/* audio */}
            <div className="mt-2.5 grid grid-cols-[44px_minmax(0,1fr)] gap-2 sm:mt-4 sm:grid-cols-[72px_1fr] sm:gap-4">
              <div className="grid size-11 shrink-0 place-items-center rounded-lg bg-background/60 outline-1 -outline-offset-1 outline-amber/40 sm:size-[72px] sm:rounded-xl">
                <span className="text-[9px] font-medium uppercase tracking-[0.15em] text-faint">
                  Audio
                </span>
              </div>
              <div className="min-w-0 rounded-lg border border-line bg-background/40 p-2.5 sm:rounded-xl sm:p-4">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[11px] text-foreground"><i>Bấm vào ghi âm để chuyển thành văn bản</i></span>
                  <span className="flex items-center gap-1.5 font-mono text-[10px] text-amber">
                    {recording ? (
                      <>
                        <span className="pulse-glow size-1.5 rounded-full bg-amber" />
                        Đang lắng nghe ...
                      </>
                    ) : audioBusy ? (
                      "Đang trích xuất"
                    ) : (
                      <span className="text-faint">Chờ tải lên</span>
                    )}
                  </span>
                </div>
                <div className="hidden flex-wrap items-center gap-1.5 font-mono text-[clamp(0.68rem,2.2vw,0.75rem)] text-muted-foreground sm:flex">
                  <span>Model AI gồm: </span>
                    <span className="rounded-full border border-border bg-muted/40 px-3 py-1">
                      <i>whisper-large-v3-turbo</i>
                    </span>
                    &bull;
                    <span className="rounded-full border border-border bg-muted/40 px-3 py-1">
                      <i>whisper-large-v3</i>
                    </span>
                </div>
                <div className="mt-3 flex h-8 items-center gap-[3px]">
                  {levels.slice(-16).map((lvl, i) => (
                    <span
                      key={i}
                      className="w-1 flex-1 rounded-full bg-amber/70 transition-transform duration-100"
                      style={
                        recording
                          ? { transform: `scaleY(${Math.max(0.15, lvl)})` }
                          : {
                              animation: `wavePulse ${0.9 + (i % 5) * 0.1}s ease-in-out ${i * 0.05}s infinite`,
                            }
                      }
                    />
                  ))}
                </div>
                <div className="mt-2 flex flex-wrap gap-2 sm:mt-3">
                  <button
                    onClick={() => void toggleRecording()}
                    disabled={audioBusy}
                    className="rounded-lg border border-amber/40 bg-amber/10 px-3 py-1.5 text-[12px] font-medium text-amber transition-colors hover:bg-amber/20 disabled:opacity-50"
                  >
                    {recording ? "Dừng & trích xuất" : "Ghi âm"}
                  </button>
                  <button
                    onClick={() => {
                      setTranscript(null);
                      setAudioError(null);
                    }}
                    className="rounded-lg border border-line bg-panel-2/60 px-3 py-2 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
                  >
                    Xóa
                  </button>
                </div>
                {audioError ? (
                  <p className="mt-2 font-mono text-[11px] text-destructive">{audioError}</p>
                ) : null}
              </div>
            </div>
          </div>

          {/* OUTPUT */}
          <div className="min-w-0 glass-card rounded-2xl p-2.5 sm:p-5">
            <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2 sm:mb-4">
              <h2 className="min-w-0 font-display text-[clamp(0.82rem,2.2vw,0.94rem)] font-medium leading-snug tracking-tight">
                Kết quả nhận dạng
              </h2>
              <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-faint">
                Ra tín hiệu
              </span>
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.16em] text-faint">
                <span>Nhãn hình ảnh</span>
                <span>{imageResult ? `${imageResult.labels.length} phát hiện` : "—"}</span>
              </div>
              <div className="space-y-3">
                {imageResult?.labels.length ? (
                  imageResult.labels.map((l, i) => (
                    <div key={l.label} className="rise-in" style={{ animationDelay: `${i * 0.08}s` }}>
                      <div className="mb-1 flex justify-between text-[12px]">
                        <span className="text-foreground">{l.label}</span>
                        <span className="font-mono text-primary">
                          {l.confidence.toFixed(1).replace(".", ",")}%
                        </span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-background/70">
                        <div
                          className="bar-grow h-full rounded-full bg-primary"
                          style={{ width: `${l.confidence}%`, animationDelay: `${0.1 + i * 0.08}s` }}
                        />
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="font-mono text-[11px] text-faint">
                    {imageBusy ? "AI đang phân tích vui lòng chờ…" : "Tải một ảnh lên để AI Kết luận."}
                  </p>
                )}
              </div>
              {imageResult?.summary ? (
                <p className="mt-3 text-[13px] leading-relaxed text-foreground/90">
                  {imageResult.summary}
                </p>
              ) : null}
              {imageResult?.text ? (
                <p className="mt-2 font-mono text-[11px] text-muted-foreground">
                  Văn bản trong ảnh: {imageResult.text}
                </p>
              ) : null}
            </div>

            <div className="rise-in mt-5 border-t border-line pt-4">
              <div className="mb-2 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.16em] text-faint">
                <span>Trích xuất âm thanh</span>
                <span>{transcript ? "Hoàn tất" : audioBusy ? "Đang xử lý" : "—"}</span>
              </div>
              <p className="text-[13px] leading-relaxed text-foreground/90">
                {transcript
                  ? `“${transcript.text}”`
                  : "Ghi âm một đoạn tiếng Việt để AI chuyển thành văn bản."}
              </p>
              {transcript ? (
                <div className="mt-2 font-mono text-[11px] text-faint">
                  {(transcript.durationMs / 1000).toFixed(1).replace(".", ",")}s · bản ghi đã được lưu vào hệ thống dữu liệu
                </div>
              ) : null}
            </div>
          </div>
        </section>

        {/* KHO LƯU TRỮ + CƠ SỞ DỮ LIỆU */}
        <section id="kho-luu-tru" className="mx-auto w-full max-w-[1400px] px-3.5 py-9 sm:px-6 sm:py-12">
          <div className="rise-in mb-5 flex flex-wrap items-end justify-between gap-3">
            <div>
              <div className="hidden font-mono text-[10px] uppercase tracking-[0.2em] text-faint sm:inline">
                (a) Dữ liệu
              </div>
              <h2 className="mt-1 font-display text-[clamp(1.15rem,4vw,1.375rem)] font-bold leading-tight tracking-tight">
                Kho lưu trữ ảnh &amp; lịch sử chuyển đổi
              </h2>
            </div>
            <span className="rounded-lg border border-line bg-panel/60 px-3 py-1.5 font-mono text-[12px] text-muted-foreground">
              {stats ? `${num(stats.images)} ảnh · ${num(stats.audios)} ghi âm` : "đang tải…"}
            </span>
          </div>

          {historyQuery.data?.length ? (
            <div className="relative">
              <div className="max-h-[620px] overflow-y-auto overscroll-contain pr-1 [scrollbar-width:none] [&::-webkit-scrollbar]:w-0 [&::-webkit-scrollbar]:h-0 sm:pr-2">
                <div className="grid min-w-0 gap-3 sm:gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {historyQuery.data.map((item, i) => (
                    <article
                      key={item.id}
                      className="rise-in min-w-0 overflow-hidden glass-card overflow-hidden rounded-xl transition-all duration-300 hover:-translate-y-0.5"
                      style={{ animationDelay: `${0.04 + i * 0.06}s` }}
                    >
                      <div className="grid h-32 place-items-center overflow-hidden bg-background/60 sm:h-36">
                        {item.signedUrl ? (
                          <button
                            type="button"
                            onClick={() => setSelectedImage(item)}
                            className="group relative block size-full cursor-zoom-in"
                            aria-label={`Xem ảnh ${item.file_name ?? ""}`}
                          >
                            <img
                              src={item.signedUrl}
                              alt={`Ảnh đã nhận dạng: ${item.labels[0]?.label ?? item.file_name ?? "ảnh"}`}
                              loading="lazy"
                              className="size-full object-cover transition duration-300 group-hover:scale-105"
                            />
                            <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/0 transition group-hover:bg-black/25">
                              <span className="rounded-full border border-white/20 bg-black/55 px-3 py-1.5 font-mono text-[10px] text-white opacity-0 backdrop-blur-sm transition group-hover:opacity-100">
                                🔍 Phóng to
                              </span>
                            </span>
                          </button>
                        ) : (
                          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-amber">
                            {item.kind === "audio" ? "Ghi âm" : "Không có ảnh"}
                          </span>
                        )}
                      </div>

                      <div className="min-w-0 p-3 sm:p-4">
                        <div className="flex min-w-0 items-center justify-between gap-2 font-mono text-[clamp(0.6rem,1.8vw,0.625rem)] text-faint">
                          <span>{formatTime(item.created_at)}</span>
                          <span>{item.latency_ms}ms</span>
                        </div>

                        <p className="mt-2 line-clamp-3 text-[clamp(0.75rem,2vw,0.8125rem)] leading-relaxed text-foreground/90 sm:line-clamp-2">
                          {item.kind === "image"
                            ? item.summary || item.labels[0]?.label || "Chưa có mô tả"
                            : item.transcript || "(không có nội dung)"}
                        </p>

                        <div className="mt-3 flex flex-wrap gap-1.5">
                          {item.labels.slice(0, 3).map((l) => (
                            <span
                              key={l.label}
                              className="rounded-full bg-primary/12 px-2 py-0.5 font-mono text-[10px] text-primary"
                            >
                              {l.label}
                            </span>
                          ))}
                          {item.kind === "audio" && item.duration_ms ? (
                            <span className="rounded-full bg-amber/12 px-2 py-0.5 font-mono text-[10px] text-amber">
                              {(item.duration_ms / 1000).toFixed(1).replace(".", ",")}s
                            </span>
                          ) : null}
                        </div>

                        {item.kind === "image" && (
                          <button
                            type="button"
                            onClick={async () => {
                              const confirmed = window.confirm(
                                `Bạn có chắc muốn xóa "${item.file_name ?? "ảnh này"}"?`,
                              );

                              if (!confirmed) return;

                              try {
                                await deleteHistoryItem(item.id, item.image_path);
                                await queryClient.invalidateQueries({ queryKey: ["history"] });
                                await queryClient.invalidateQueries({ queryKey: ["stats"] });
                              } catch (error) {
                                console.error("Xóa ảnh thất bại:", error);
                                window.alert("Xóa ảnh thất bại. Vui lòng thử lại.");
                              }
                            }}
                            className="mt-4 w-full rounded-lg border border-red-500/30 px-3 py-2 font-mono text-[11px] text-red-400 transition hover:bg-red-500/10"
                          >
                            🗑️ Xóa ảnh
                          </button>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              </div>

              {historyQuery.data.length > 6 ? (
                <div className="pointer-events-none absolute bottom-0 left-0 right-2 h-24 rounded-b-xl bg-gradient-to-t from-background via-background/75 to-transparent" />
              ) : null}
            </div>
          ) : (
            <div className="rounded-xl border border-line bg-panel/40 p-8 text-center font-mono text-[12px] text-faint">
              {historyQuery.isLoading
                ? "Đang tải kho lưu trữ…"
                : "Kho lưu trữ đang trống — hãy tải một ảnh lên hoặc ghi âm để bắt đầu."}
            </div>
          )}
        </section>

        <section id="tai-nguyen" className="mx-auto w-full max-w-[1400px] px-4 pb-10 sm:px-6 sm:pb-12">
          <div className="rise-in mb-5 flex flex-wrap items-end justify-between gap-3">
            <div>
              <div className="hidden font-mono text-[10px] uppercase tracking-[0.2em] text-faint sm:inline">
                (b) Hạ tầng
              </div>
              <h2 className="mt-1 font-display text-[clamp(1.15rem,4vw,1.375rem)] font-bold leading-tight tracking-tight">
                Bảng điều khiển tài nguyên
              </h2>
            </div>
            <span className="rounded-lg border border-line bg-panel/60 px-3 py-1.5 font-mono text-[12px] text-muted-foreground">
              {stats?.last_at ? `cập nhật ${formatTime(stats.last_at)}` : "chưa có lưu lượng"}
            </span>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
            {resources.map((r, i) => (
              <div
                key={r.name}
                className="rise-in glass-card rounded-xl p-4 transition-all duration-300 hover:-translate-y-0.5"
                style={{ animationDelay: `${0.05 + i * 0.07}s` }}
              >
                <div className="flex items-center justify-between">
                  <span className="font-display text-[13px] font-medium">{r.name}</span>
                  <span
                    className={`flex items-center gap-1.5 font-mono text-[10px] ${
                      r.state === "warn" ? "text-amber" : "text-primary"
                    }`}
                  >
                    <span
                      className={`pulse-glow size-1.5 rounded-full ${
                        r.state === "warn" ? "bg-amber" : "bg-primary"
                      }`}
                    />
                    {r.status}
                  </span>
                </div>
                <div className="mt-3 font-mono text-2xl tracking-tight">{r.value}</div>
                <div className="mt-1 font-mono text-[11px] text-muted-foreground">{r.meta}</div>
              </div>
            ))}
          </div>

          <div
            id="giam-sat"
            className="rise-in mt-4 rounded-xl border border-line bg-panel/40 p-4 backdrop-blur-sm"
            style={{ animationDelay: "0.33s" }}
          >
            <div className="grid grid-cols-1 gap-4 min-[420px]:grid-cols-2 md:grid-cols-4 md:gap-6">
              {metrics.map((m, i) => (
                <div key={m.label}>
                  <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-faint">
                    {m.label}
                  </div>
                  <div className="mt-1 font-display text-lg font-medium">{m.value}</div>
                  <div className="mt-2 h-1 overflow-hidden rounded-full bg-background/70">
                    <div
                      className={`bar-grow h-full rounded-full ${
                        m.tone === "amber" ? "bg-amber" : "bg-primary"
                      }`}
                      style={{ width: `${m.pct}%`, animationDelay: `${0.5 + i * 0.08}s` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {selectedImage?.signedUrl ? (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center overflow-auto bg-black/85 p-2 backdrop-blur-md sm:p-4"
            onClick={() => setSelectedImage(null)}
          >
            <div
              className="relative flex max-h-[94vh] max-w-[98vw] items-center justify-center sm:max-h-[92vh] sm:max-w-[95vw]"
              onClick={(e) => e.stopPropagation()}
            >
              <img
                src={selectedImage.signedUrl}
                alt={`Ảnh đã nhận dạng: ${selectedImage.labels[0]?.label ?? selectedImage.file_name ?? "ảnh"}`}
                className="max-h-[82vh] max-w-[96vw] rounded-xl object-contain shadow-2xl sm:max-h-[88vh] sm:max-w-[92vw]"
              />

              {/* Watermark bản quyền chỉ hiển thị khi ảnh được mở/phóng to */}
              <div
                className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden rounded-xl"
                aria-hidden="true"
              >
                <div className="select-none -rotate-[24deg] whitespace-nowrap text-center font-display text-[clamp(2rem,7vw,5rem)] font-bold uppercase tracking-[0.18em] text-white/10 drop-shadow-[0_1px_2px_rgba(0,0,0,0.45)] sm:text-[clamp(3rem,6vw,5.5rem)]">
                  NHÓM 6
                </div>
              </div>

              <button
                type="button"
                onClick={() => setSelectedImage(null)}
                className="absolute right-3 top-3 grid size-9 place-items-center rounded-full border border-white/20 bg-black/60 text-xl text-white transition hover:bg-black/80"
                aria-label="Đóng ảnh"
              >
                ×
              </button>

              <div className="absolute bottom-2 left-2 right-2 max-h-[28vh] overflow-auto rounded-lg border border-white/10 bg-black/60 px-3 py-2.5 backdrop-blur-md sm:bottom-3 sm:left-3 sm:right-3 sm:px-4 sm:py-3">
                <div className="font-mono text-[11px] text-white/80">
                  {selectedImage.file_name ?? "Ảnh đã nhận dạng"}
                </div>
                {selectedImage.summary ? (
                  <div className="mt-1 text-sm text-white">{selectedImage.summary}</div>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}

        <footer className="border-t border-line">
          <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-5 px-3.5 py-7 sm:flex-row sm:items-center sm:justify-between sm:px-6 sm:py-8">
            <button
              type="button"
              onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
              className="flex shrink-0 items-center gap-2.5 text-left"
              aria-label="Về trang chủ"
            >
              <span className="grid size-6 place-items-center rounded-md bg-primary/15 ring-1 ring-primary/30">
                <span className="size-1.5 rounded-full bg-primary" />
              </span>
              <span className="font-display text-sm font-medium">AI Video&amp;Text</span>
            </button>
            <div className="w-full min-w-0 text-center font-mono text-[clamp(0.42rem,2vw,0.69rem)] leading-relaxed text-muted-foreground sm:text-right">
              Bản quyền &amp; thuộc về nhóm 6 vui lòng không copy dưới mọi hình thức, nội dung mang tính chất nghiên cứu và học tập Commumity <a href="https://cdn.phototourl.com/free/2026-09-09-69d89a68-47b6-4cc7-87ad-9011a207e451.jpg"><b><i>Lạc Trôi</i></b></a> · © 2026
            </div>
          </div>
        </footer>
      </div>
    </div>
    </>
  );
}