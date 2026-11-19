import type { User } from 'firebase/auth';
import { CheckCircle2, FileUp, ImagePlus, Loader2, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import {
  cancelServerApkUpload,
  fetchAppScreenshots,
  updatePublishedApp,
  uploadApkToServer,
} from '../services/storeService';
import { SCHEMA_LIMITS } from '../types/store';
import type { AppEntry, AppScreenshot, UploadedApkInfo } from '../types/store';
import { compressScreenshotFile, formatFileSize } from '../utils/imageUtils';

interface EditAppModalProps {
  app: AppEntry | null;
  user: User | null;
  onClose: () => void;
  onSaved: (appName: string) => void;
}

export function EditAppModal({ app, user, onClose, onSaved }: EditAppModalProps) {
  const apkInputRef = useRef<HTMLInputElement>(null);
  const shotsInputRef = useRef<HTMLInputElement>(null);
  const uploadAbortRef = useRef<AbortController | null>(null);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [existingShots, setExistingShots] = useState<AppScreenshot[]>([]);
  const [removedShotIds, setRemovedShotIds] = useState<string[]>([]);
  const [addedShots, setAddedShots] = useState<string[]>([]);
  const [loadingShots, setLoadingShots] = useState(false);
  const [processingShots, setProcessingShots] = useState(false);

  const [replacementApk, setReplacementApk] = useState<UploadedApkInfo | null>(null);
  const [uploadingApk, setUploadingApk] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadPhase, setUploadPhase] = useState<'uploading' | 'extracting'>('uploading');

  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!app) return;
    setName(app.name);
    setDescription(app.description);
    setRemovedShotIds([]);
    setAddedShots([]);
    setReplacementApk(null);
    setErrorMsg(null);
    setSaving(false);

    let cancelled = false;
    if (app.screenshotCount > 0) {
      setLoadingShots(true);
      fetchAppScreenshots(app.id)
        .then((shots) => {
          if (!cancelled) setExistingShots(shots);
        })
        .catch(() => {
          if (!cancelled) setExistingShots([]);
        })
        .finally(() => {
          if (!cancelled) setLoadingShots(false);
        });
    } else {
      setExistingShots([]);
      setLoadingShots(false);
    }

    return () => {
      cancelled = true;
    };
  }, [app]);

  if (!app || !user) return null;

  const totalShotsCount = existingShots.length + addedShots.length;

  async function handleClose() {
    if (saving) return;
    if (uploadAbortRef.current) {
      uploadAbortRef.current.abort();
      uploadAbortRef.current = null;
    }
    if (replacementApk?.fileId) {
      await cancelServerApkUpload(replacementApk.fileId);
    }
    onClose();
  }

  async function handleReplaceApkChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setErrorMsg(null);

    if (file.size <= 0) {
      setErrorMsg('ملف التطبيق فارغ ولا يمكن رفعه.');
      return;
    }
    if (file.size > 500 * 1024 * 1024) {
      setErrorMsg('حجم الملف يتجاوز الحد الأقصى المسموح به (500 ميجابايت).');
      return;
    }

    if (replacementApk?.fileId) {
      void cancelServerApkUpload(replacementApk.fileId);
      setReplacementApk(null);
    }

    const controller = new AbortController();
    uploadAbortRef.current = controller;
    setUploadingApk(true);
    setUploadProgress(1);
    setUploadPhase('uploading');

    try {
      const info = await uploadApkToServer(
        file,
        (pct, phase) => {
          setUploadProgress(pct);
          setUploadPhase(phase);
        },
        controller.signal
      );
      setReplacementApk(info);
    } catch (err) {
      if (!controller.signal.aborted) {
        setErrorMsg(
          err instanceof Error ? err.message : 'تعذر رفع ملف التطبيق البديل.'
        );
      }
    } finally {
      uploadAbortRef.current = null;
      setUploadingApk(false);
      if (apkInputRef.current) apkInputRef.current.value = '';
    }
  }

  async function handleAddScreenshots(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    setErrorMsg(null);

    const remaining = SCHEMA_LIMITS.MAX_SCREENSHOTS - totalShotsCount;
    if (remaining <= 0) {
      setErrorMsg(`الحد الأقصى للصور هو ${SCHEMA_LIMITS.MAX_SCREENSHOTS} صور.`);
      return;
    }

    setProcessingShots(true);
    try {
      const compressed: string[] = [];
      for (const file of files.slice(0, remaining)) {
        if (!file.type.startsWith('image/')) continue;
        compressed.push(await compressScreenshotFile(file));
      }
      if (compressed.length > 0) {
        setAddedShots((prev) => [...prev, ...compressed].slice(0, SCHEMA_LIMITS.MAX_SCREENSHOTS));
      }
    } catch {
      setErrorMsg('تعذرت معالجة إحدى الصور المختارة.');
    } finally {
      setProcessingShots(false);
      if (shotsInputRef.current) shotsInputRef.current.value = '';
    }
  }

  function removeExistingShot(shotId: string) {
    setExistingShots((prev) => prev.filter((s) => s.id !== shotId));
    setRemovedShotIds((prev) => [...prev, shotId]);
  }

  function removeAddedShot(idx: number) {
    setAddedShots((prev) => prev.filter((_, i) => i !== idx));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!app || !user || saving || uploadingApk) return;
    setErrorMsg(null);
    setSaving(true);

    try {
      await updatePublishedApp({
        user,
        app,
        name,
        description,
        keptScreenshots: existingShots,
        removedScreenshotIds: removedShotIds,
        addedScreenshotDataUrls: addedShots,
        replacementApk,
      });
      onSaved(name.trim() || app.name);
      onClose();
    } catch (err) {
      console.error('Update app failed:', err);
      setErrorMsg('تعذر حفظ التعديلات حالياً. يرجى المحاولة مرة أخرى.');
      setSaving(false);
    }
  }

  const activeIcon = replacementApk?.iconDataUrl || app.iconDataUrl;
  const activeFileName = replacementApk?.fileName || app.fileName;
  const activeFileSize = replacementApk?.fileSize || app.fileSize;

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/45 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4 animate-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && !uploadingApk && !saving) {
          void handleClose();
        }
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-app-title"
    >
      <div className="w-full sm:max-w-lg max-h-[92vh] flex flex-col bg-white rounded-t-[28px] sm:rounded-3xl shadow-2xl animate-sheet-up overflow-hidden">
        <div className="flex items-center justify-between gap-4 px-6 pt-6 pb-4 shrink-0 border-b border-slate-100">
          <h2 id="edit-app-title" className="text-xl font-bold text-slate-900">
            تعديل التطبيق
          </h2>
          <button
            type="button"
            onClick={() => void handleClose()}
            disabled={saving}
            className="w-10 h-10 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-600 flex items-center justify-center transition-colors cursor-pointer disabled:opacity-50"
            aria-label="إغلاق"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-6 py-5 overflow-y-auto space-y-5">
          {/* Current / Updated APK File Card */}
          <div className="p-4 rounded-2xl bg-slate-50 border border-slate-200/80">
            <div className="flex items-center gap-3.5">
              <img
                src={activeIcon}
                alt={name || app.name}
                referrerPolicy="no-referrer"
                className="w-14 h-14 rounded-2xl object-cover bg-white border border-slate-200 shrink-0"
              />
              <div className="min-w-0 flex-1">
                {replacementApk ? (
                  <p className="text-xs font-semibold text-emerald-700 flex items-center gap-1 mb-0.5">
                    <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                    <span>تم تجهيز ملف APK جديد</span>
                  </p>
                ) : (
                  <p className="text-xs text-slate-500 mb-0.5">ملف التطبيق الحالي (محفوظ كما هو)</p>
                )}
                <p className="text-sm font-bold text-slate-900 truncate" dir="ltr">
                  {activeFileName}
                </p>
                <p className="text-xs text-slate-500 tabular-nums mt-0.5">
                  {formatFileSize(activeFileSize)}
                </p>
              </div>
              <input
                ref={apkInputRef}
                type="file"
                accept=".apk,application/vnd.android.package-archive"
                onChange={handleReplaceApkChange}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => apkInputRef.current?.click()}
                disabled={uploadingApk || saving}
                className="shrink-0 h-9 px-3 rounded-xl border border-slate-200 bg-white hover:bg-slate-100 text-slate-700 text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
              >
                <FileUp className="w-3.5 h-3.5" />
                <span>تحديث APK</span>
              </button>
            </div>

            {uploadingApk && (
              <div className="mt-3 pt-3 border-t border-slate-200/70">
                <div className="flex items-center justify-between text-xs text-slate-600 mb-1.5">
                  <span>
                    {uploadPhase === 'extracting'
                      ? 'جارٍ استخراج الأيقونة...'
                      : 'جارٍ رفع ملف APK الجديد...'}
                  </span>
                  <span className="tabular-nums font-semibold">{uploadProgress}%</span>
                </div>
                <div className="w-full h-1.5 bg-emerald-100 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-[#00995e] rounded-full transition-all duration-200"
                    style={{ width: `${uploadProgress}%` }}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Name */}
          <div>
            <label htmlFor="edit-app-name" className="block text-sm font-bold text-slate-800 mb-1.5">
              اسم التطبيق
            </label>
            <input
              id="edit-app-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={SCHEMA_LIMITS.NAME_MAX}
              placeholder={app.name}
              disabled={saving}
              className="w-full h-12 px-4 rounded-xl border border-slate-200 bg-white text-slate-900 placeholder:text-slate-400 text-sm focus:outline-none focus:border-[#00995e] focus:ring-2 focus:ring-emerald-500/15"
            />
          </div>

          {/* Description */}
          <div>
            <label htmlFor="edit-app-desc" className="block text-sm font-bold text-slate-800 mb-1.5">
              وصف التطبيق
            </label>
            <textarea
              id="edit-app-desc"
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={SCHEMA_LIMITS.DESCRIPTION_MAX}
              placeholder="اكتب وصفاً مختصراً للتطبيق..."
              disabled={saving}
              className="w-full px-4 py-3 rounded-xl border border-slate-200 bg-white text-slate-900 placeholder:text-slate-400 text-sm leading-relaxed resize-none focus:outline-none focus:border-[#00995e] focus:ring-2 focus:ring-emerald-500/15"
            />
          </div>

          {/* Screenshots */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-bold text-slate-800">صور التطبيق</label>
              <span className="text-xs text-slate-400 tabular-nums">
                {totalShotsCount} / {SCHEMA_LIMITS.MAX_SCREENSHOTS}
              </span>
            </div>

            <input
              ref={shotsInputRef}
              type="file"
              accept="image/*"
              multiple
              onChange={handleAddScreenshots}
              className="hidden"
            />

            {loadingShots ? (
              <div className="grid grid-cols-4 gap-2.5">
                {Array.from({ length: Math.min(app.screenshotCount, 4) }).map((_, i) => (
                  <div key={i} className="aspect-[3/4] rounded-xl bg-slate-100 animate-pulse" />
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-4 gap-2.5">
                {existingShots.map((shot) => (
                  <div
                    key={shot.id}
                    className="relative aspect-[3/4] rounded-xl overflow-hidden border border-slate-200 bg-slate-50"
                  >
                    <img
                      src={shot.imageDataUrl}
                      alt="صورة التطبيق"
                      referrerPolicy="no-referrer"
                      className="w-full h-full object-cover"
                    />
                    <button
                      type="button"
                      onClick={() => removeExistingShot(shot.id)}
                      disabled={saving}
                      className="absolute top-1.5 left-1.5 w-7 h-7 rounded-lg bg-slate-900/75 hover:bg-rose-600 text-white flex items-center justify-center transition-colors cursor-pointer"
                      aria-label="حذف الصورة"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}

                {addedShots.map((src, idx) => (
                  <div
                    key={`new-${idx}`}
                    className="relative aspect-[3/4] rounded-xl overflow-hidden border border-emerald-300 bg-slate-50"
                  >
                    <img
                      src={src}
                      alt={`صورة جديدة ${idx + 1}`}
                      referrerPolicy="no-referrer"
                      className="w-full h-full object-cover"
                    />
                    <button
                      type="button"
                      onClick={() => removeAddedShot(idx)}
                      disabled={saving}
                      className="absolute top-1.5 left-1.5 w-7 h-7 rounded-lg bg-slate-900/75 hover:bg-rose-600 text-white flex items-center justify-center transition-colors cursor-pointer"
                      aria-label="حذف الصورة"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}

                {totalShotsCount < SCHEMA_LIMITS.MAX_SCREENSHOTS && (
                  <button
                    type="button"
                    onClick={() => shotsInputRef.current?.click()}
                    disabled={processingShots || saving}
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
            )}
          </div>

          {errorMsg && (
            <div className="rounded-xl bg-rose-50 border border-rose-200 px-4 py-3 text-sm text-rose-700 font-medium text-center">
              {errorMsg}
            </div>
          )}

          <div className="flex items-center gap-3 pt-1">
            <button
              type="submit"
              disabled={saving || uploadingApk || processingShots}
              className="flex-1 h-12 rounded-2xl bg-[#00995e] hover:bg-[#008250] text-white font-bold text-sm flex items-center justify-center gap-2 transition-colors cursor-pointer disabled:opacity-65"
            >
              {saving ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>جارٍ حفظ التعديلات...</span>
                </>
              ) : (
                <span>حفظ التعديلات</span>
              )}
            </button>
            <button
              type="button"
              onClick={() => void handleClose()}
              disabled={saving}
              className="h-12 px-5 rounded-2xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-sm transition-colors cursor-pointer"
            >
              إلغاء
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
