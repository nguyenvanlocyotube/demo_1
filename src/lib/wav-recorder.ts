/** Records microphone audio as PCM and encodes a complete 16-bit mono WAV. */
export type WavRecorder = {
  stop: () => Promise<{ dataUrl: string; durationMs: number }>;
  cancel: () => void;
  levels: () => number[];
};

const TARGET_RATE = 16000;

function downsample(input: Float32Array, from: number, to: number): Float32Array {
  if (to >= from) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j]!;
    out[i] = sum / Math.max(1, end - start);
  }
  return out;
}

function encodeWav(chunks: Float32Array[], sampleRate: number): Blob {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const merged = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.length;
  }
  const samples = downsample(merged, sampleRate, TARGET_RATE);
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (pos: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(pos + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, TARGET_RATE, true);
  view.setUint32(28, TARGET_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

export async function startWavRecording(
  onLevel?: (levels: number[]) => void,
): Promise<WavRecorder> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];
  let levels: number[] = new Array(24).fill(0.2);
  const startedAt = Date.now();

  processor.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0);
    chunks.push(new Float32Array(input));
    let peak = 0;
    for (let i = 0; i < input.length; i += 32) peak = Math.max(peak, Math.abs(input[i]!));
    levels = [...levels.slice(1), Math.min(1, 0.15 + peak * 2.5)];
    onLevel?.(levels);
  };
  source.connect(processor);
  processor.connect(ctx.destination);

  const teardown = () => {
    stream.getTracks().forEach((t) => t.stop());
    processor.disconnect();
    source.disconnect();
  };

  return {
    levels: () => levels,
    cancel: () => {
      teardown();
      void ctx.close();
    },
    stop: async () => {
      teardown();
      const blob = encodeWav(chunks, ctx.sampleRate);
      await ctx.close();
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error("Không đọc được bản ghi."));
        reader.readAsDataURL(blob);
      });
      return { dataUrl, durationMs: Date.now() - startedAt };
    },
  };
}