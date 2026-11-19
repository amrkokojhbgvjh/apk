import type { User } from 'firebase/auth';
import { Download, Loader2, Pencil, ShieldCheck, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  deletePublishedApp,
  downloadExactApkFile,
  fetchAppScreenshots,
} from '../services/storeService';
import type { AppEntry, AppScreenshot } from '../types/store';
import { formatFileSize, formatRelativeDate } from '../utils/imageUtils';

interface AppDetailsModalProps {
  app: AppEntry | null;
  currentUser: User | null;
  onClose: () => void;
  onEditApp: (app: AppEntry) => void;
  onDeleted: (appName: string) => void;
}

export function AppDetailsModal({
  app,
  currentUser,
  onClose,
  onEditApp,
  onDeleted,
}: AppDetailsModalProps) {
  const [screenshots, setScreenshots] = useState<AppScreenshot[]>([]);
  const [loadingShots, setLoadingShots] = useState(false);
  const [zoomImage, setZoomImage] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!app) {
      setScreenshots([]);
      setZoomImage(null);
      setDownloadError(null);
      setConfirmDelete(false);
      return;
    }

    let cancelled = false;
    if (app.screenshotCount > 0) {
      setLoadingShots(true);
      fetchAppScreenshots(app.id)
        .then((shots) => {
          if (!cancelled) setScreenshots(shots);
        })
        .catch(() => {
          if (!cancelled) setScreenshots([]);
        })
        .finally(() => {
          if (!cancelled) setLoadingShots(false);
        });
    } else {
      setScreenshots([]);
      setLoadingShots(false);
    }

    return () => {
      cancelled = true;
    };
  }, [app?.id, app?.screenshotCount]);

  if (!app) return null;

  const isOwner =
    Boolean(currentUser) &&
    (currentUser?.uid === app.uploaderId || currentUser?.email === 'amrfarkha751@gmail.com');

  async function handleDownload() {
    if (!app || downloading) return;
    setDownloadError(null);
    setDownloading(true);
    setDownloadProgress(1);

    try {
      await downloadExactApkFile(app, (pct) => {
        setDownloadProgress(pct);
      });
    } catch (err) {
      setDownloadError(
        err instanceof Error
          ? err.message
          : 'تعذر بدء تحميل الملف. يرجى المحاولة مرة أخرى.'
      );
    } finally {
      setDownloading(false);
      setDownloadProgress(0);
    }
  }

  async function handleDeleteApp() {
    if (!app || deleting) return;
    setDeleting(true);
    try {
      await deletePublishedApp(app);
      onDeleted(app.name);
      onClose();
    } catch {
      setDownloadError('تعذر حذف التطبيق حالياً. يرجى المحاولة مرة أخرى.');
      setDeleting(false);
    }
  }

  const publishedDate = app.createdAt ? app.createdAt.toDate() : null;

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/45 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4 animate-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && !deleting) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="app-details-title"
    >
      <div className="w-full sm:max-w-xl max-h-[92vh] flex flex-col bg-white rounded-t-[28px] sm:rounded-3xl shadow-2xl animate-sheet-up overflow-hidden">
        {/* Top Row */}
        <div className="flex items-start justify-between gap-4 px-6 pt-6 pb-4 shrink-0 border-b border-slate-100">
          <div className="flex items-center gap-4 min-w-0">
            <img
              src={app.iconDataUrl}
              alt={app.name}
              referrerPolicy="no-referrer"
              className="w-18 h-18 rounded-2xl object-cover bg-slate-50 border border-slate-200/80 shadow-xs shrink-0"
            />
            <div className="min-w-0">
              <h2
                id="app-details-title"
                className="text-xl font-bold text-slate-900 leading-snug break-words"
              >
                {app.name}
              </h2>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500 mt-1.5 tabular-nums">
                <span>{formatFileSize(app.fileSize)}</span>
                {app.versionName && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>الإصدار {app.versionName}</span>
                  </>
                )}
                <span aria-hidden="true">·</span>
                <span>{app.downloadsCount} تنزيل</span>
              </div>
              <p className="text-xs text-slate-400 mt-1">
                بواسطة {app.uploaderName} · {formatRelativeDate(publishedDate)}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            disabled={deleting}
            className="w-10 h-10 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-600 flex items-center justify-center transition-colors cursor-pointer shrink-0"
            aria-label="إغلاق"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Scrollable Body */}
        <div className="px-6 py-5 overflow-y-auto space-y-6">
          {/* Primary Download Button + Untouched File Guarantee */}
          <div>
            <button
              type="button"
              onClick={() => void handleDownload()}
              disabled={downloading}
              className="w-full h-13 rounded-2xl bg-[#00995e] hover:bg-[#008250] active:scale-[0.99] text-white font-bold text-base flex items-center justify-center gap-2.5 shadow-sm shadow-emerald-600/20 transition-all cursor-pointer disabled:opacity-85"
            >
              {downloading ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  <span className="tabular-nums">جارٍ تحميل التطبيق... {downloadProgress}%</span>
                </>
              ) : (
                <>
                  <Download className="w-5 h-5" />
                  <span>تحميل الملف الأصلي ({app.fileName.split('.').pop()?.toUpperCase() || 'APK'})</span>
                </>
              )}
            </button>

            {downloading && (
              <div className="mt-2.5 w-full h-1.5 bg-emerald-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-[#00995e] rounded-full transition-all duration-200"
                  style={{ width: `${downloadProgress}%` }}
                />
              </div>
            )}

            <div className="mt-2.5 flex items-center justify-center gap-1.5 text-xs text-slate-500">
              <ShieldCheck className="w-4 h-4 text-[#00995e] shrink-0" />
              <span>ينزل بنفس الصيغة والأيقونة والملف الأصلي كما رُفع بدون أي تعديل</span>
            </div>

            {downloadError && (
              <p className="mt-3 rounded-xl bg-rose-50 border border-rose-200 px-4 py-2.5 text-xs text-rose-700 font-medium text-center">
                {downloadError}
              </p>
            )}
          </div>

          {/* Description */}
          {app.description && (
            <div>
              <h3 className="text-sm font-bold text-slate-900 mb-2">عن التطبيق</h3>
              <p className="text-sm text-slate-600 leading-relaxed whitespace-pre-line break-words">
                {app.description}
              </p>
            </div>
          )}

          {/* Optional Screenshots Gallery */}
          {(loadingShots || screenshots.length > 0) && (
            <div>
              <h3 className="text-sm font-bold text-slate-900 mb-3">صور التطبيق</h3>
              {loadingShots ? (
                <div className="flex gap-3 overflow-x-auto pb-1">
                  {Array.from({ length: Math.min(app.screenshotCount, 3) }).map((_, i) => (
                    <div
                      key={i}
                      className="w-36 h-56 rounded-2xl bg-slate-100 animate-pulse shrink-0"
                    />
                  ))}
                </div>
              ) : (
                <div className="flex gap-3 overflow-x-auto pb-2">
                  {screenshots.map((shot, idx) => (
                    <button
                      key={shot.id}
                      type="button"
                      onClick={() => setZoomImage(shot.imageDataUrl)}
                      className="shrink-0 w-36 sm:w-40 aspect-[9/16] rounded-2xl overflow-hidden border border-slate-200 bg-slate-50 hover:border-emerald-400 transition-colors cursor-pointer"
                    >
                      <img
                        src={shot.imageDataUrl}
                        alt={`لقطة شاشة ${idx + 1} لتطبيق ${app.name}`}
                        referrerPolicy="no-referrer"
                        className="w-full h-full object-cover"
                      />
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* File Metadata & Owner Actions */}
          <div className="pt-4 border-t border-slate-100 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-400">
            <div className="space-y-0.5 min-w-0">
              <p className="truncate" dir="ltr">
                {app.fileName}
              </p>
              {app.packageName && (
                <p className="truncate font-mono text-[11px]" dir="ltr">
                  {app.packageName}
                </p>
              )}
              {app.fileSha256 && (
                <p className="truncate font-mono text-[10px] text-slate-400" dir="ltr">
                  SHA-256: {app.fileSha256.slice(0, 16)}...
                </p>
              )}
            </div>

            {isOwner && (
              <div className="flex items-center gap-2">
                {!confirmDelete ? (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        onClose();
                        onEditApp(app);
                      }}
                      className="h-9 px-3 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                      <span>تعديل</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(true)}
                      className="h-9 px-3 rounded-xl text-rose-600 hover:bg-rose-50 font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
                    >
                      <Trash2 className="w-4 h-4" />
                      <span>حذف</span>
                    </button>
                  </>
                ) : (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(false)}
                      disabled={deleting}
                      className="h-9 px-3 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold cursor-pointer"
                    >
                      إلغاء
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDeleteApp()}
                      disabled={deleting}
                      className="h-9 px-3.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-semibold flex items-center gap-1.5 cursor-pointer disabled:opacity-60"
                    >
                      {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                      <span>تأكيد الحذف</span>
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Fullscreen Screenshot Lightbox */}
      {zoomImage && (
        <div
          className="fixed inset-0 z-[60] bg-black/85 flex items-center justify-center p-4"
          onClick={() => setZoomImage(null)}
        >
          <button
            type="button"
            onClick={() => setZoomImage(null)}
            className="absolute top-5 left-5 w-11 h-11 rounded-full bg-white/15 hover:bg-white/25 text-white flex items-center justify-center cursor-pointer"
            aria-label="إغلاق المعاينة"
          >
            <X className="w-6 h-6" />
          </button>
          <img
            src={zoomImage}
            alt="معاينة الصورة"
            referrerPolicy="no-referrer"
            className="max-w-full max-h-[88vh] rounded-2xl object-contain shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}
