/** Thu nhỏ & nén ảnh trước khi gửi AI: tránh lỗi payload quá lớn / định dạng lạ. */
const MAX_SIDE = 1600;
const QUALITY = 0.85;

const readAsDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

export async function prepareImage(file: File): Promise<string> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no canvas");
    ctx.fillStyle = "#fff"; // PNG trong suốt -> nền trắng khi chuyển JPEG
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return canvas.toDataURL("image/jpeg", QUALITY);
  } catch {
    // Trình duyệt không giải mã được (vd. HEIC) -> thử gửi nguyên bản nếu đủ nhỏ.
    if (file.size > 8 * 1024 * 1024)
      throw new Error("Không đọc được ảnh hoặc ảnh quá lớn.");
    return readAsDataUrl(file);
  }
}
