import type { User } from 'firebase/auth';
import { CheckCircle2, FileUp, ImagePlus, Loader2, RefreshCw, Trash2, X } from 'lucide-react';
import { useRef, useState } from 'react';
import type { ChangeEvent, DragEvent, FormEvent } from 'react';
import {
  cancelServerApkUpload,
  publishAppToStore,
  uploadApkToServer,
} from '../services/storeService';
import { SCHEMA_LIMITS } from '../types/store';
import type { UploadedApkInfo } from '../types/store';
import { compressScreenshotFile, formatFileSize } from '../utils/imageUtils';

interface UploadApkModalProps {
  open: boolean;
  user: User | null;
  onClose: () => void;
  onPublished: (appName: string) => void;
}

export function UploadApkModal({
  open,
  user,
  onClose,
  onPublished,
}: UploadApkModalProps) {
  const apkInputRef = useRef<HTMLInputElement>(null);
  const shotsInputRef = useRef<HTMLInputElement>(null);
  const uploadAbortRef = useRef<AbortController | null>(null);

  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadPhase, setUploadPhase] = useState<'uploading' | 'extracting'>('uploading');
  const [selectedFileSize, setSelectedFileSize] = useState(0);
  const [uploadedApk, setUploadedApk] = useState<UploadedApkInfo | null>(null);
  const [customName, setCustomName] = useState('');
  const [description, setDescription] = useState('');
  const [screenshots, setScreenshots] = useState<string[]>([]);
  const [processingShots, setProcessingShots] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!open) return null;

  async function resetState(cleanupServerFile: boolean) {
    if (uploadAbortRef.current) {
      uploadAbortRef.current.abort();
      uploadAbortRef.current = null;
    }
    if (cleanupServerFile && uploadedApk?.fileId) {
      await cancelServerApkUpload(uploadedApk.fileId);
    }
    setUploading(false);
    setUploadProgress(0);
    setUploadPhase('uploading');
    setSelectedFileSize(0);
    setUploadedApk(null);
    setCustomName('');
    setDescription('');
    setScreenshots([]);
    setProcessingShots(false);
    setPublishing(false);
    setIsDragging(false);
    setErrorMsg(null);
    if (apkInputRef.current) apkInputRef.current.value = '';
    if (shotsInputRef.current) shotsInputRef.current.value = '';
  }

  async function handleClose() {
    if (publishing) return;
    await resetState(true);
    onClose();
  }

  async function processApkFile(file: File) {
    setErrorMsg(null);

    if (file.size <= 0) {
      setErrorMsg('ملف التطبيق فارغ ولا يمكن رفعه.');
      return;
    }

    if (file.size > 500 * 1024 * 1024) {
      setErrorMsg('حجم ملف التطبيق يتجاوز الحد الأقصى المسموح به (500 ميجابايت).');
      return;
    }

    const lowerName = file.name.toLowerCase();
    const isApkMime =
      file.type === 'application/vnd.android.package-archive' ||
      file.type === 'application/octet-stream' ||
      file.type === 'application/zip' ||
      file.type === 'application/x-zip-compressed' ||
      file.type === '';

    if (!lowerName.includes('.apk') && !isApkMime) {
      setErrorMsg('يرجى اختيار ملف تطبيق أندرويد بصيغة (.apk) فقط.');
      return;
    }

    if (uploadedApk?.fileId) {
      void cancelServerApkUpload(uploadedApk.fileId);
      setUploadedApk(null);
    }

    const controller = new AbortController();
    uploadAbortRef.current = controller;

    setSelectedFileSize(file.size);
    setUploading(true);
    setUploadPhase('uploading');
    setUploadProgress(1);

    try {
      const info = await uploadApkToServer(
        file,
        (pct, phase) => {
          setUploadProgress(pct);
          setUploadPhase(phase);
        },
        controller.signal
      );
      setUploadedApk(info);
      setCustomName('');
    } catch (err) {
      if (!controller.signal.aborted) {
        setErrorMsg(
          err instanceof Error
            ? err.message
            : 'تعذر رفع ملف التطبيق. يرجى المحاولة مرة أخرى.'
        );
      }
    } finally {
      uploadAbortRef.current = null;
      setUploading(false);
      if (apkInputRef.current) apkInputRef.current.value = '';
    }
  }

  function handleApkInputChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) {
      void processApkFile(file);
    }
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragging(false);
    if (uploading || publishing) return;
    const file = e.dataTransfer.files?.[0];
    if (file) {
      void processApkFile(file);
    }
  }

  async function handleScreenshotsChange(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    setErrorMsg(null);

    const remainingSlots = SCHEMA_LIMITS.MAX_SCREENSHOTS - screenshots.length;
    if (remainingSlots <= 0) {
      setErrorMsg(`يمكنك إرفاق ${SCHEMA_LIMITS.MAX_SCREENSHOTS} صور كحد أقصى.`);
      return;
    }

    const selected = files.slice(0, remainingSlots);
    setProcessingShots(true);

    try {
      const compressed: string[] = [];
      for (const file of selected) {
        if (!file.type.startsWith('image/')) continue;
        const dataUrl = await compressScreenshotFile(file);
        compressed.push(dataUrl);
      }
      if (compressed.length > 0) {
        setScreenshots((prev) =>
          [...prev, ...compressed].slice(0, SCHEMA_LIMITS.MAX_SCREENSHOTS)
        );
      }
    } catch {
      setErrorMsg('تعذرت معالجة إحدى الصور المختارة. يرجى تجربة صورة أخرى.');
    } finally {
      setProcessingShots(false);
      if (shotsInputRef.current) shotsInputRef.current.value = '';
    }
  }

  function removeScreenshot(index: number) {
    setScreenshots((prev) => prev.filter((_, i) => i !== index));
  }

  async function handlePublish(e: FormEvent) {
    e.preventDefault();
    if (!user || !uploadedApk || publishing) return;

    setErrorMsg(null);
    setPublishing(true);

    try {
      await publishAppToStore({
        user,
        uploadedApk,
        customName,
        description,
        screenshots,
      });

      const publishedName =
        customName.trim() || uploadedApk.extractedName || uploadedApk.fileName;
      await resetState(false);
      onPublished(publishedName);
    } catch (err) {
      console.error('Publish error:', err);
      setErrorMsg('حدث خطأ أثناء نشر التطبيق في قاعدة البيانات. يرجى المحاولة مرة أخرى.');
      setPublishing(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/45 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4 animate-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && !uploading && !publishing) {
          void handleClose();
        }
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="upload-apk-title"
    >
      <div className="w-full sm:max-w-lg max-h-[92vh] flex flex-col bg-white rounded-t-[28px] sm:rounded-3xl shadow-2xl animate-sheet-up overflow-hidden">
        {/* Modal Header */}
        <div className="flex items-center justify-between gap-4 px-6 pt-6 pb-4 shrink-0">
          <h2 id="upload-apk-title" className="text-xl font-bold text-slate-900">
            رفع التطبيق من الجهاز
          </h2>
          <button
            type="button"
            onClick={() => void handleClose()}
            disabled={publishing}
            className="w-10 h-10 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-600 flex items-center justify-center transition-colors cursor-pointer disabled:opacity-50"
            aria-label="إغلاق"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="px-6 pb-7 overflow-y-auto">
          <input
            ref={apkInputRef}
            type="file"
            accept=".apk,application/vnd.android.package-archive"
            onChange={handleApkInputChange}
            className="hidden"
          />

          {/* Step 1: APK Dropzone */}
          {!uploadedApk ? (
            <div>
              <div
                onClick={() => !uploading && apkInputRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (!uploading) setIsDragging(true);
                }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={handleDrop}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if ((e.key === 'Enter' || e.key === ' ') && !uploading) {
                    e.preventDefault();
                    apkInputRef.current?.click();
                  }
                }}
                className={`border-2 border-dashed rounded-2xl px-6 py-10 text-center transition-all cursor-pointer select-none ${
                  isDragging
                    ? 'border-[#00995e] bg-emerald-50/60'
                    : 'border-slate-200 hover:border-[#00995e]/70 hover:bg-slate-50/70 bg-white'
                } ${uploading ? 'pointer-events-none opacity-95' : ''}`}
              >
                {uploading ? (
                  <div className="py-2">
                    <Loader2 className="w-9 h-9 text-[#00995e] mx-auto animate-spin mb-4" />
                    <p className="text-base font-bold text-slate-900">
                      {uploadPhase === 'extracting'
                        ? 'جارٍ استخراج أيقونة وبيانات التطبيق...'
                        : 'جارٍ رفع ملف التطبيق بأمان...'}
                    </p>
                    <p className="text-sm text-slate-500 mt-1.5 tabular-nums">
                      {uploadProgress}%
                      {selectedFileSize > 0 ? ` · ${formatFileSize(selectedFileSize)}` : ''}
                    </p>
                    <div className="mt-4 w-full max-w-xs mx-auto h-2 bg-emerald-100 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-[#00995e] transition-all duration-200 rounded-full"
                        style={{ width: `${uploadProgress}%` }}
                      />
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="w-12 h-12 rounded-2xl bg-emerald-50 text-[#00995e] flex items-center justify-center mx-auto mb-4">
                      <FileUp className="w-7 h-7" />
                    </div>
                    <p className="text-base sm:text-[17px] font-bold text-slate-900">
                      اختر ملف التطبيق (APK) من جهازك
                    </p>
                    <p className="text-sm text-slate-500 mt-2 leading-relaxed max-w-xs mx-auto">
                      سيتم تجهيز التطبيق للنشر واستخراج أيقونته تلقائياً فور الرفع
                    </p>
                  </>
                )}
              </div>

              {errorMsg && (
                <div className="mt-4 rounded-xl bg-rose-50 border border-rose-200 px-4 py-3 text-sm text-rose-700 font-medium text-center">
                  {errorMsg}
                </div>
              )}
            </div>
          ) : (
            /* Step 2: Auto-Extracted Icon Preview + ONLY 3 Optional Fields */
            <form onSubmit={handlePublish} className="space-y-5">
              {/* Auto-Extracted Icon & File Summary */}
              <div className="flex items-center gap-4 p-4 rounded-2xl bg-slate-50 border border-slate-200/80">
                <img
                  src={uploadedApk.iconDataUrl}
                  alt={uploadedApk.extractedName || 'أيقونة التطبيق'}
                  referrerPolicy="no-referrer"
                  className="w-16 h-16 rounded-2xl object-cover bg-white border border-slate-200 shadow-xs shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-emerald-700 text-xs font-semibold mb-1">
                    <CheckCircle2 className="w-4 h-4 shrink-0" />
                    <span>تم استخراج الأيقونة وتجهيز الملف</span>
                  </div>
                  <p className="font-bold text-slate-900 text-base truncate">
                    {customName.trim() || uploadedApk.extractedName}
                  </p>
                  <p className="text-xs text-slate-500 mt-0.5 truncate tabular-nums">
                    {formatFileSize(uploadedApk.fileSize)}
                    {uploadedApk.versionName ? ` · الإصدار ${uploadedApk.versionName}` : ''}
                    {` · ${uploadedApk.fileName}`}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => apkInputRef.current?.click()}
                  disabled={publishing}
                  className="shrink-0 h-9 px-3 rounded-xl border border-slate-200 bg-white hover:bg-slate-100 text-slate-700 text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
                  title="اختيار ملف APK آخر"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>تغيير</span>
                </button>
              </div>

              {/* Optional Field 1: App Name */}
              <div>
                <label
                  htmlFor="app-name-input"
                  className="block text-sm font-bold text-slate-800 mb-1.5"
                >
                  اسم التطبيق{' '}
                  <span className="font-normal text-slate-400 text-xs">(اختياري)</span>
                </label>
                <input
                  id="app-name-input"
                  type="text"
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                  maxLength={SCHEMA_LIMITS.NAME_MAX}
                  placeholder={uploadedApk.extractedName}
                  disabled={publishing}
                  className="w-full h-12 px-4 rounded-xl border border-slate-200 bg-white text-slate-900 placeholder:text-slate-400 text-sm focus:outline-none focus:border-[#00995e] focus:ring-2 focus:ring-emerald-500/15 transition-all"
                />
              </div>

              {/* Optional Field 2: App Description */}
              <div>
                <label
                  htmlFor="app-desc-input"
                  className="block text-sm font-bold text-slate-800 mb-1.5"
                >
                  وصف التطبيق{' '}
                  <span className="font-normal text-slate-400 text-xs">(اختياري)</span>
                </label>
                <textarea
                  id="app-desc-input"
                  rows={3}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  maxLength={SCHEMA_LIMITS.DESCRIPTION_MAX}
                  placeholder="أضف وصفاً مختصراً لمميزات التطبيق..."
                  disabled={publishing}
                  className="w-full px-4 py-3 rounded-xl border border-slate-200 bg-white text-slate-900 placeholder:text-slate-400 text-sm leading-relaxed resize-none focus:outline-none focus:border-[#00995e] focus:ring-2 focus:ring-emerald-500/15 transition-all"
                />
              </div>

              {/* Optional Field 3: Screenshots */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-sm font-bold text-slate-800">
                    صور للتطبيق{' '}
                    <span className="font-normal text-slate-400 text-xs">(اختياري)</span>
                  </label>
                  <span className="text-xs text-slate-400 tabular-nums">
                    {screenshots.length} / {SCHEMA_LIMITS.MAX_SCREENSHOTS}
                  </span>
                </div>

                <input
                  ref={shotsInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={handleScreenshotsChange}
                  className="hidden"
                />

                <div className="grid grid-cols-4 gap-2.5">
                  {screenshots.map((src, idx) => (
                    <div
                      key={idx}
                      className="relative aspect-[3/4] rounded-xl overflow-hidden border border-slate-200 bg-slate-50 group"
                    >
                      <img
                        src={src}
                        alt={`صورة التطبيق ${idx + 1}`}
                        referrerPolicy="no-referrer"
                        className="w-full h-full object-cover"
                      />
                      <button
                        type="button"
                        onClick={() => removeScreenshot(idx)}
                        disabled={publishing}
                        className="absolute top-1.5 left-1.5 w-7 h-7 rounded-lg bg-slate-900/75 hover:bg-rose-600 text-white flex items-center justify-center transition-colors cursor-pointer"
                        aria-label="حذف الصورة"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}

                  {screenshots.length < SCHEMA_LIMITS.MAX_SCREENSHOTS && (
                    <button
                      type="button"
                      onClick={() => shotsInputRef.current?.click()}
                      disabled={processingShots || publishing}
                      className="aspect-[3/4] rounded-xl border-2 border-dashed border-slate-200 hover:border-[#00995e] hover:bg-emerald-50/40 text-slate-500 hover:text-[#00995e] flex flex-col items-center justify-center gap-1.5 transition-all cursor-pointer disabled:opacity-50"
                    >
                      {processingShots ? (
                        <Loader2 className="w-5 h-5 animate-spin" />
                      ) : (
                        <>
                          <ImagePlus className="w-5 h-5" />
                          <span className="text-[11px] font-semibold">إضافة صورة</span>
                        </>
                      )}
                    </button>
                  )}
                </div>
              </div>

              {errorMsg && (
                <div className="rounded-xl bg-rose-50 border border-rose-200 px-4 py-3 text-sm text-rose-700 font-medium text-center">
                  {errorMsg}
                </div>
              )}

              {/* Publish Primary CTA */}
              <button
                type="submit"
                disabled={publishing || processingShots}
                className="w-full h-13 rounded-2xl bg-[#00995e] hover:bg-[#008250] active:scale-[0.99] text-white font-bold text-base flex items-center justify-center gap-2 shadow-sm shadow-emerald-600/20 transition-all cursor-pointer disabled:opacity-65"
              >
                {publishing ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    <span>جارٍ النشر في المتجر...</span>
                  </>
                ) : (
                  <span>نشر التطبيق في المتجر</span>
                )}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
