import { SCHEMA_LIMITS } from '../types/store';

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatRelativeDate(date: Date | null): string {
  if (!date) return 'الآن';
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'الآن';
  if (diffMin < 60) return `منذ ${diffMin} دقيقة`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `منذ ${diffHours} ساعة`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `منذ ${diffDays} يوم`;
  return date.toLocaleDateString('ar-EG', { year: 'numeric', month: 'short', day: 'numeric' });
}

function createSafeFallbackIcon(label = 'A'): string {
  const initial = (label.trim()[0] || 'A').toUpperCase().replace(/[<>&"']/g, '');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="192" height="192" viewBox="0 0 192 192"><rect width="192" height="192" rx="44" fill="#059669"/><text x="96" y="114" text-anchor="middle" fill="#ffffff" font-family="system-ui,sans-serif" font-size="84" font-weight="700">${initial}</text></svg>`;
  return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('تعذر تحميل الصورة.'));
    img.src = src;
  });
}

/**
 * Ensures any extracted APK icon fits cleanly within Firestore limits (<= 200KB)
 * while preserving sharp alpha transparency at 192x192.
 */
export async function normalizeIconDataUrl(dataUrl: string, fallbackName = 'A'): Promise<string> {
  if (!dataUrl) return createSafeFallbackIcon(fallbackName);
  if (dataUrl.startsWith('data:image/svg+xml') && dataUrl.length <= 180000) {
    return dataUrl;
  }
  if (dataUrl.length <= 120000) {
    return dataUrl;
  }

  try {
    const img = await loadImage(dataUrl);
    const size = 192;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return createSafeFallbackIcon(fallbackName);

    ctx.clearRect(0, 0, size, size);
    const scale = Math.min(size / img.width, size / img.height);
    const drawW = img.width * scale;
    const drawH = img.height * scale;
    ctx.drawImage(img, (size - drawW) / 2, (size - drawH) / 2, drawW, drawH);

    const webp = canvas.toDataURL('image/webp', 0.85);
    if (webp.startsWith('data:image/webp') && webp.length <= 180000) {
      return webp;
    }
    const png = canvas.toDataURL('image/png');
    if (png.length <= 220000) return png;
    const jpg = canvas.toDataURL('image/jpeg', 0.82);
    return jpg.length <= SCHEMA_LIMITS.ICON_DATA_URL_MAX ? jpg : createSafeFallbackIcon(fallbackName);
  } catch {
    return createSafeFallbackIcon(fallbackName);
  }
}

/**
 * Compresses an optional user screenshot so it stays crisp and strictly under
 * the 450KB Firestore document budget.
 */
export async function compressScreenshotFile(file: File): Promise<string> {
  const rawDataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('تعذرت قراءة ملف الصورة.'));
    reader.readAsDataURL(file);
  });

  const img = await loadImage(rawDataUrl);
  const maxDimension = 960;
  const scale = Math.min(1, maxDimension / Math.max(img.width, img.height));
  const width = Math.max(1, Math.round(img.width * scale));
  const height = Math.max(1, Math.round(img.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('تعذرت معالجة الصورة.');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);

  let quality = 0.82;
  let result = canvas.toDataURL('image/jpeg', quality);
  while (result.length > 380000 && quality > 0.35) {
    quality -= 0.12;
    result = canvas.toDataURL('image/jpeg', quality);
  }

  if (result.length > SCHEMA_LIMITS.SCREENSHOT_DATA_URL_MAX) {
    const smallCanvas = document.createElement('canvas');
    smallCanvas.width = Math.round(width * 0.65);
    smallCanvas.height = Math.round(height * 0.65);
    const sCtx = smallCanvas.getContext('2d');
    if (sCtx) {
      sCtx.fillStyle = '#ffffff';
      sCtx.fillRect(0, 0, smallCanvas.width, smallCanvas.height);
      sCtx.drawImage(canvas, 0, 0, smallCanvas.width, smallCanvas.height);
      result = smallCanvas.toDataURL('image/jpeg', 0.72);
    }
  }

  return result;
}
