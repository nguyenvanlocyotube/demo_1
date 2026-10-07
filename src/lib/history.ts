import { supabase } from "@/integrations/supabase/client";

export const BUCKET = "recognition-images";

export type Stats = {
    total: number;
    images: number;
    audios: number;
    bytes: number;
    labels: number;
    audio_seconds: number;
    avg_latency_ms: number;
    p95_latency_ms: number;
    last_hour: number;
    last_24h: number;
    last_7d: number;
    active_days: number;
    last_at: string | null;
};

export type HistoryItem = {
    id: string;
    kind: "image" | "audio";
    file_name: string | null;
    image_path: string | null;
    bytes: number;
    labels: { label: string; confidence: number }[];
    summary: string | null;
    ocr_text: string | null;
    transcript: string | null;
    duration_ms: number | null;
    latency_ms: number;
    created_at: string;
    signedUrl?: string | null;
};

const EMPTY_STATS: Stats = {
    total: 0,
    images: 0,
    audios: 0,
    bytes: 0,
    labels: 0,
    audio_seconds: 0,
    avg_latency_ms: 0,
    p95_latency_ms: 0,
    last_hour: 0,
    last_24h: 0,
    last_7d: 0,
    active_days: 0,
    last_at: null,
};

function generateId(): string {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === "x" ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

export async function fetchStats(): Promise<Stats> {
    const { data, error } = await supabase.rpc("platform_stats");
    if (error) throw error;
    return { ...EMPTY_STATS, ...((data ?? {}) as Partial<Stats>) };
}

export async function fetchHistory(limit?: number): Promise<HistoryItem[]> {
    let query = supabase
        .from("recognitions")
        .select("*")
        .order("created_at", { ascending: false });

    if (limit !== undefined) {
        query = query.limit(limit);
    }

    const { data, error } = await query;
    if (error) throw error;

    const rows = (data ?? []) as unknown as HistoryItem[];
    const paths = rows.map((r) => r.image_path).filter((p): p is string => !!p);
    const urls = new Map<string, string>();

    if (paths.length) {
        const signed = await supabase.storage
            .from(BUCKET)
            .createSignedUrls(paths, 3600);

        signed.data?.forEach((s, i) => {
            const path = paths[i];
            if (path && s.signedUrl) urls.set(path, s.signedUrl);
        });
    }

    return rows.map((r) => ({
        ...r,
        labels: Array.isArray(r.labels) ? r.labels : [],
        signedUrl: r.image_path ? (urls.get(r.image_path) ?? null) : null,
    }));
}

export async function uploadImage(file: File): Promise<string | null> {
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "jpg";
    const path = `${new Date().toISOString().slice(0, 10)}/${generateId()}.${ext}`;
    const { error } = await supabase.storage
        .from(BUCKET)
        .upload(path, file, { contentType: file.type || "image/jpeg" });
    if (error) return null;
    return path;
}

export async function saveRecognition(row: {
    kind: "image" | "audio";
    file_name?: string | null;
    image_path?: string | null;
    bytes?: number;
    labels?: { label: string; confidence: number }[];
    summary?: string | null;
    ocr_text?: string | null;
    transcript?: string | null;
    duration_ms?: number | null;
    latency_ms: number;
}) {
    await supabase.from("recognitions").insert(row as never);
}

export async function deleteHistoryItem(
    id: string,
    imagePath?: string | null,
) {
    const { error: dbError } = await supabase
        .from("recognitions")
        .delete()
        .eq("id", id);

    if (dbError) throw dbError;

    if (imagePath) {
        const { error: storageError } = await supabase.storage
            .from(BUCKET)
            .remove([imagePath]);

        if (storageError) console.error("Không thể xóa file ảnh:", storageError);
    }

    return true;
}

export function formatBytes(n: number) {
    if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2).replace(".", ",")} GB`;
    if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1).replace(".", ",")} MB`;
    return `${Math.max(1, Math.round(n / 1024))} KB`;
}

export function formatTime(iso: string) {
    return new Date(iso).toLocaleString("vi-VN", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    });
}