import type { User } from 'firebase/auth';
import {
  ArrowRight,
  Download,
  ExternalLink,
  Loader2,
  LogOut,
  Pencil,
  Plus,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { deletePublishedApp } from '../services/storeService';
import type { AppEntry } from '../types/store';
import { formatFileSize, formatRelativeDate } from '../utils/imageUtils';

interface UserProfileViewProps {
  user: User;
  myApps: AppEntry[];
  downloadingAppId: string | null;
  downloadPercent: number;
  onBackToStore: () => void;
  onUploadClick: () => void;
  onEditApp: (app: AppEntry) => void;
  onPreviewApp: (app: AppEntry) => void;
  onDownloadApp: (app: AppEntry) => void;
  onDeletedApp: (appName: string) => void;
  onLogout: () => void;
}

export function UserProfileView({
  user,
  myApps,
  downloadingAppId,
  downloadPercent,
  onBackToStore,
  onUploadClick,
  onEditApp,
  onPreviewApp,
  onDownloadApp,
  onDeletedApp,
  onLogout,
}: UserProfileViewProps) {
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [avatarFailed, setAvatarFailed] = useState(false);

  const stats = useMemo(() => {
    const totalDownloads = myApps.reduce((acc, a) => acc + a.downloadsCount, 0);
    return {
      appsCount: myApps.length,
      totalDownloads,
    };
  }, [myApps]);

  async function handleConfirmDelete(app: AppEntry) {
    if (deletingId) return;
    setDeletingId(app.id);
    try {
      await deletePublishedApp(app);
      setConfirmDeleteId(null);
      onDeletedApp(app.name);
    } catch {
      // Handled silently
    } finally {
      setDeletingId(null);
    }
  }

  const userInitial = (user.displayName || user.email || 'م').trim().charAt(0).toUpperCase();

  return (
    <section className="space-y-6">
      {/* Top Breadcrumb / Back Action */}
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={onBackToStore}
          className="h-10 px-3.5 rounded-xl bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 text-sm font-semibold flex items-center gap-2 transition-colors cursor-pointer"
        >
          <ArrowRight className="w-4 h-4" />
          <span>العودة للمتجر</span>
        </button>

        <button
          type="button"
          onClick={onLogout}
          className="h-10 px-3.5 rounded-xl border border-slate-200 bg-white hover:bg-rose-50 hover:border-rose-200 text-rose-600 text-sm font-semibold flex items-center gap-2 transition-colors cursor-pointer"
        >
          <LogOut className="w-4 h-4" />
          <span>تسجيل الخروج</span>
        </button>
      </div>

      {/* Profile Header Card */}
      <div className="bg-white rounded-3xl border border-slate-200/80 p-5 sm:p-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-4 min-w-0">
            <div className="w-16 h-16 rounded-2xl overflow-hidden bg-indigo-600 text-white font-bold text-xl flex items-center justify-center shrink-0 ring-2 ring-slate-100">
              {user.photoURL && !avatarFailed ? (
                <img
                  src={user.photoURL}
                  alt={user.displayName || 'صورة الحساب'}
                  referrerPolicy="no-referrer"
                  onError={() => setAvatarFailed(true)}
                  className="w-full h-full object-cover"
                />
              ) : (
                <span>{userInitial}</span>
              )}
            </div>
            <div className="min-w-0">
              <h1 className="text-xl sm:text-2xl font-bold text-slate-900 truncate">
                {user.displayName || 'حسابي'}
              </h1>
              <p className="text-sm text-slate-500 truncate mt-0.5" dir="ltr">
                {user.email}
              </p>
              <p className="text-xs text-slate-400 mt-1">
                لوحة إدارة تطبيقاتك ومتابعة التنزيلات والملفات المرفوعة
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onUploadClick}
            className="h-11 px-5 rounded-2xl bg-[#00995e] hover:bg-[#008250] text-white text-sm font-bold flex items-center justify-center gap-2 shadow-sm shadow-emerald-600/15 transition-all cursor-pointer shrink-0 whitespace-nowrap"
          >
            <Plus className="w-4 h-4 stroke-[2.5]" />
            <span>رفع تطبيق جديد</span>
          </button>
        </div>

        {/* 2-Column Developer Summary Strip */}
        <div className="grid grid-cols-2 gap-3 mt-6 pt-6 border-t border-slate-100 max-w-lg">
          <div className="rounded-2xl bg-slate-50/90 px-4 py-3.5">
            <p className="text-xs text-slate-500 font-medium">تطبيقاتي المنشورة</p>
            <p className="text-2xl font-bold text-slate-900 mt-1 tabular-nums">
              {stats.appsCount}
            </p>
          </div>
          <div className="rounded-2xl bg-slate-50/90 px-4 py-3.5">
            <p className="text-xs text-slate-500 font-medium">إجمالي التنزيلات</p>
            <p className="text-2xl font-bold text-slate-900 mt-1 tabular-nums">
              {stats.totalDownloads}
            </p>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-slate-900">تطبيقاتي المرفوعة</h2>
        <span className="text-xs text-slate-400 tabular-nums">{myApps.length} تطبيق</span>
      </div>

      {myApps.length === 0 ? (
        <div className="bg-white rounded-3xl border border-slate-200/80 py-14 px-6 text-center">
          <p className="text-lg font-bold text-slate-900">لم تقم برفع أي تطبيقات بعد</p>
          <p className="text-sm text-slate-500 mt-2 max-w-md mx-auto">
            ارفع ملف الـ APK الخاص بك ليتم حفظه كما هو بدون أي تعديل، وتابع تنزيلاته وتعديله من هنا.
          </p>
          <button
            type="button"
            onClick={onUploadClick}
            className="mt-6 h-11 px-6 rounded-2xl bg-[#00995e] hover:bg-[#008250] text-white text-sm font-bold inline-flex items-center gap-2 transition-colors cursor-pointer"
          >
            <Plus className="w-4 h-4 stroke-[2.5]" />
            <span>رفع تطبيقك الأول</span>
          </button>
        </div>
      ) : (
        <div className="space-y-3.5">
          {myApps.map((app) => {
            const publishedDate = app.createdAt ? app.createdAt.toDate() : null;
            const isConfirming = confirmDeleteId === app.id;
            const isDeleting = deletingId === app.id;

            return (
              <article
                key={app.id}
                className="bg-white rounded-2xl border border-slate-200/80 p-4 sm:p-5 space-y-4"
              >
                <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                  <div className="flex items-start gap-3.5 min-w-0">
                    <img
                      src={app.iconDataUrl}
                      alt={app.name}
                      referrerPolicy="no-referrer"
                      className="w-16 h-16 rounded-2xl object-cover bg-slate-50 border border-slate-100 shrink-0"
                    />
                    <div className="min-w-0 flex-1">
                      <h3 className="text-base sm:text-lg font-bold text-slate-900 truncate">
                        {app.name}
                      </h3>
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500 mt-1 tabular-nums">
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
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-400 mt-1">
                        <span className="truncate max-w-[220px]" dir="ltr">
                          {app.fileName}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>نُشر {formatRelativeDate(publishedDate)}</span>
                        {app.fileSha256 && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="inline-flex items-center gap-1 text-emerald-700">
                              <ShieldCheck className="w-3.5 h-3.5" />
                              ملف أصلي مطابق
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Action Controls */}
                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => onEditApp(app)}
                      className="h-9 px-3.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                      <span>تعديل</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => onDownloadApp(app)}
                      disabled={downloadingAppId !== null}
                      className="h-9 px-3.5 rounded-xl bg-emerald-50 hover:bg-[#00995e] text-[#008250] hover:text-white text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-70"
                    >
                      {downloadingAppId === app.id ? (
                        <>
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          <span className="tabular-nums">{downloadPercent}%</span>
                        </>
                      ) : (
                        <>
                          <Download className="w-3.5 h-3.5" />
                          <span>تحميل</span>
                        </>
                      )}
                    </button>

                    <button
                      type="button"
                      onClick={() => onPreviewApp(app)}
                      className="h-9 w-9 rounded-xl border border-slate-200 hover:bg-slate-50 text-slate-600 flex items-center justify-center transition-colors cursor-pointer"
                      title="عرض صفحة التطبيق"
                      aria-label="عرض صفحة التطبيق"
                    >
                      <ExternalLink className="w-4 h-4" />
                    </button>

                    {!isConfirming ? (
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(app.id)}
                        className="h-9 w-9 rounded-xl border border-slate-200 hover:bg-rose-50 hover:border-rose-200 text-rose-600 flex items-center justify-center transition-colors cursor-pointer"
                        title="حذف التطبيق"
                        aria-label="حذف التطبيق"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    ) : (
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(null)}
                          disabled={isDeleting}
                          className="h-9 px-3 rounded-xl bg-slate-100 text-slate-700 text-xs font-semibold cursor-pointer"
                        >
                          إلغاء
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleConfirmDelete(app)}
                          disabled={isDeleting}
                          className="h-9 px-3 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold flex items-center gap-1 cursor-pointer disabled:opacity-60"
                        >
                          {isDeleting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                          <span>تأكيد الحذف</span>
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                {app.description && (
                  <p className="text-sm text-slate-600 leading-relaxed line-clamp-2 pt-2 border-t border-slate-100">
                    {app.description}
                  </p>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
