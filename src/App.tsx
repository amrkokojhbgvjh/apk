import { onAuthStateChanged } from 'firebase/auth';
import type { User } from 'firebase/auth';
import { CheckCircle2, Download, Loader2, Search, Store, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { AppDetailsModal } from './components/AppDetailsModal';
import { EditAppModal } from './components/EditAppModal';
import { Header } from './components/Header';
import { LoginRequiredModal } from './components/LoginRequiredModal';
import { UploadApkModal } from './components/UploadApkModal';
import { UserProfileView } from './components/UserProfileView';
import { auth } from './firebase';
import {
  downloadExactApkFile,
  ensureUserProfile,
  signInWithGoogle,
  signOutUser,
  subscribePublishedApps,
  subscribeStoreStats,
} from './services/storeService';
import type { AppEntry } from './types/store';
import { formatFileSize, formatRelativeDate } from './utils/imageUtils';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [apps, setApps] = useState<AppEntry[]>([]);
  const [appsLoading, setAppsLoading] = useState(true);
  const [registeredUsersCount, setRegisteredUsersCount] = useState<number>(0);

  const [activeView, setActiveView] = useState<'store' | 'profile'>('store');
  const [loginModalOpen, setLoginModalOpen] = useState(false);
  const [openUploadAfterLogin, setOpenUploadAfterLogin] = useState(false);
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [selectedApp, setSelectedApp] = useState<AppEntry | null>(null);
  const [editingApp, setEditingApp] = useState<AppEntry | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [downloadingAppId, setDownloadingAppId] = useState<string | null>(null);
  const [downloadPercent, setDownloadPercent] = useState(0);

  // Auth listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setAuthLoading(false);
      if (!currentUser) {
        setActiveView('store');
      } else if (currentUser.emailVerified) {
        void ensureUserProfile(currentUser).catch((err) => {
          console.error('Failed to sync user profile:', err);
        });
      }
    });
    return () => unsubscribe();
  }, []);

  // Real-time public published apps subscription
  useEffect(() => {
    const unsubscribe = subscribePublishedApps(
      (publishedList) => {
        setApps(publishedList);
        setAppsLoading(false);
      },
      () => {
        setAppsLoading(false);
      }
    );
    return () => unsubscribe();
  }, []);

  // Real-time public registered users count subscription
  useEffect(() => {
    const unsubscribe = subscribeStoreStats((count) => {
      setRegisteredUsersCount(count);
    });
    return () => unsubscribe();
  }, []);

  // Keep selectedApp synchronized with real-time updates (downloads, ratings, edits)
  useEffect(() => {
    if (!selectedApp) return;
    const updated = apps.find((a) => a.id === selectedApp.id);
    if (updated) {
      setSelectedApp(updated);
    }
  }, [apps, selectedApp]);

  // Auto-hide toast notification
  useEffect(() => {
    if (!toastMessage) return;
    const timer = setTimeout(() => setToastMessage(null), 4000);
    return () => clearTimeout(timer);
  }, [toastMessage]);

  const myApps = useMemo(() => {
    if (!user) return [];
    return apps.filter((app) => app.uploaderId === user.uid);
  }, [apps, user]);

  const filteredApps = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return apps;
    return apps.filter(
      (app) =>
        app.name.toLowerCase().includes(q) ||
        app.description.toLowerCase().includes(q) ||
        app.packageName.toLowerCase().includes(q) ||
        app.uploaderName.toLowerCase().includes(q)
    );
  }, [apps, searchQuery]);

  async function handleDirectGoogleLogin() {
    try {
      await signInWithGoogle();
    } catch (err) {
      console.error('Google sign-in failed:', err);
    }
  }

  async function handleModalGoogleLogin() {
    await signInWithGoogle();
    setLoginModalOpen(false);
    if (openUploadAfterLogin) {
      setOpenUploadAfterLogin(false);
      setUploadModalOpen(true);
    }
  }

  function handleUploadClick() {
    if (!user) {
      setOpenUploadAfterLogin(true);
      setLoginModalOpen(true);
      return;
    }
    setUploadModalOpen(true);
  }

  async function handleDirectDownload(app: AppEntry) {
    if (downloadingAppId) return;
    setDownloadingAppId(app.id);
    setDownloadPercent(1);
    try {
      await downloadExactApkFile(app, (pct) => {
        setDownloadPercent(pct);
      });
      setToastMessage(`تم تحميل "${app.fileName}" بنجاح.`);
    } catch (err) {
      setToastMessage(
        err instanceof Error
          ? err.message
          : 'تعذر بدء تحميل التطبيق. يرجى المحاولة مرة أخرى.'
      );
    } finally {
      setDownloadingAppId(null);
      setDownloadPercent(0);
    }
  }

  return (
    <div dir="rtl" className="min-h-screen bg-[#f8fafc] text-slate-900 flex flex-col">
      <Header
        user={user}
        authLoading={authLoading}
        activeView={activeView}
        myAppsCount={myApps.length}
        onHomeClick={() => {
          setActiveView('store');
          setSearchQuery('');
          setSelectedApp(null);
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }}
        onProfileClick={() => {
          if (!user) {
            setOpenUploadAfterLogin(false);
            setLoginModalOpen(true);
            return;
          }
          setSelectedApp(null);
          setActiveView('profile');
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }}
        onLoginClick={() => void handleDirectGoogleLogin()}
        onLogoutClick={() => {
          setActiveView('store');
          void signOutUser();
        }}
        onUploadClick={handleUploadClick}
      />

      {/* Toast Feedback */}
      {toastMessage && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-40 max-w-sm w-[calc(100%-2rem)]">
          <div className="bg-slate-900 text-white px-4 py-3 rounded-2xl shadow-xl flex items-center justify-between gap-3 text-sm font-semibold">
            <div className="flex items-center gap-2 min-w-0">
              <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
              <span className="truncate">{toastMessage}</span>
            </div>
            <button
              type="button"
              onClick={() => setToastMessage(null)}
              className="text-slate-400 hover:text-white cursor-pointer shrink-0"
              aria-label="إغلاق الإشعار"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Main Content */}
      <main className="flex-1 w-full max-w-6xl mx-auto px-4 sm:px-6 py-8 sm:py-10">
        {activeView === 'profile' && user ? (
          <UserProfileView
            user={user}
            myApps={myApps}
            downloadingAppId={downloadingAppId}
            downloadPercent={downloadPercent}
            onBackToStore={() => setActiveView('store')}
            onUploadClick={handleUploadClick}
            onEditApp={(app) => setEditingApp(app)}
            onPreviewApp={(app) => setSelectedApp(app)}
            onDownloadApp={(app) => void handleDirectDownload(app)}
            onDeletedApp={(appName) => setToastMessage(`تم حذف "${appName}" من المتجر.`)}
            onLogout={() => {
              setActiveView('store');
              void signOutUser();
            }}
          />
        ) : appsLoading ? (
          <div className="min-h-[55vh] flex flex-col items-center justify-center text-center">
            <div className="w-16 h-16 rounded-2xl bg-slate-100 animate-pulse" />
            <div className="h-6 w-44 bg-slate-200/80 rounded-lg mt-5 animate-pulse" />
            <div className="h-4 w-60 bg-slate-100 rounded-lg mt-3 animate-pulse" />
          </div>
        ) : apps.length === 0 ? (
          /* Exact Empty Store State matching Screenshot 1 */
          <section className="min-h-[58vh] flex flex-col items-center justify-center text-center px-4">
            <div className="w-16 h-16 rounded-2xl bg-[#eef2f6] text-slate-400 flex items-center justify-center">
              <Store className="w-7 h-7 stroke-[1.75]" />
            </div>
            <h1 className="text-[22px] sm:text-2xl font-bold text-slate-900 mt-5">
              التطبيقات المنشورة
            </h1>
            <p className="text-slate-500 text-[15px] sm:text-base mt-2 max-w-md leading-relaxed">
              لا توجد تطبيقات منشورة في المتجر حتى الآن.
            </p>
            <p className="text-slate-400 text-sm mt-4 tabular-nums">
              المستخدمون المسجلون: {registeredUsersCount}
            </p>
          </section>
        ) : (
          /* Published Apps Catalog */
          <section className="space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
              <div>
                <h1 className="text-2xl sm:text-[26px] font-bold text-slate-900">
                  التطبيقات المنشورة
                </h1>
                <div className="flex items-center gap-2 text-sm text-slate-500 mt-1 tabular-nums">
                  <span>{apps.length} تطبيق متاح</span>
                  <span aria-hidden="true">·</span>
                  <span>المستخدمون المسجلون: {registeredUsersCount}</span>
                </div>
              </div>

              <div className="relative w-full sm:w-72">
                <Search className="w-4 h-4 text-slate-400 absolute right-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="ابحث عن تطبيق..."
                  className="w-full h-11 pr-10 pl-4 rounded-xl border border-slate-200 bg-white text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-[#00995e] focus:ring-2 focus:ring-emerald-500/15 transition-all"
                />
              </div>
            </div>

            {filteredApps.length === 0 ? (
              <div className="bg-white rounded-2xl border border-slate-200/80 py-14 px-6 text-center">
                <p className="text-base font-bold text-slate-900">
                  لا توجد نتائج مطابقة لـ "{searchQuery}"
                </p>
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="mt-3 text-sm font-semibold text-[#00995e] hover:underline cursor-pointer"
                >
                  عرض جميع التطبيقات
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {filteredApps.map((app) => {
                  const publishedDate = app.createdAt ? app.createdAt.toDate() : null;

                  return (
                    <article
                      key={app.id}
                      onClick={() => setSelectedApp(app)}
                      className="bg-white rounded-2xl border border-slate-200/80 hover:border-emerald-300 hover:shadow-md hover:shadow-slate-900/5 transition-all p-4 flex flex-col justify-between gap-4 cursor-pointer group"
                    >
                      <div>
                        <div className="flex items-start gap-3.5">
                          <img
                            src={app.iconDataUrl}
                            alt={app.name}
                            referrerPolicy="no-referrer"
                            className="w-16 h-16 rounded-2xl object-cover bg-slate-50 border border-slate-100 shrink-0"
                          />
                          <div className="min-w-0 flex-1 pt-0.5">
                            <h2 className="text-base font-bold text-slate-900 group-hover:text-[#008f57] transition-colors truncate">
                              {app.name}
                            </h2>
                            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-slate-500 mt-1 tabular-nums">
                              <span>{formatFileSize(app.fileSize)}</span>
                              {app.versionName && (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <span>v{app.versionName}</span>
                                </>
                              )}
                              <span aria-hidden="true">·</span>
                              <span>{app.downloadsCount} تنزيل</span>
                            </div>
                          </div>
                        </div>

                        {app.description && (
                          <p className="text-sm text-slate-600 leading-relaxed mt-3 line-clamp-2">
                            {app.description}
                          </p>
                        )}
                      </div>

                      <div className="pt-3 border-t border-slate-100 flex items-center justify-between gap-3">
                        <div className="min-w-0 text-xs text-slate-400 truncate">
                          <span>{app.uploaderName}</span>
                          <span className="mx-1.5" aria-hidden="true">·</span>
                          <span>{formatRelativeDate(publishedDate)}</span>
                        </div>

                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleDirectDownload(app);
                          }}
                          disabled={downloadingAppId !== null}
                          className="h-9 px-3.5 rounded-xl bg-emerald-50 hover:bg-[#00995e] text-[#008250] hover:text-white text-xs font-bold flex items-center gap-1.5 transition-colors shrink-0 cursor-pointer disabled:opacity-70"
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
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        )}
      </main>

      {/* Modals */}
      <LoginRequiredModal
        open={loginModalOpen}
        onClose={() => {
          setLoginModalOpen(false);
          setOpenUploadAfterLogin(false);
        }}
        onGoogleLogin={handleModalGoogleLogin}
      />

      <UploadApkModal
        open={uploadModalOpen}
        user={user}
        onClose={() => setUploadModalOpen(false)}
        onPublished={(appName) => {
          setUploadModalOpen(false);
          setToastMessage(`تم نشر "${appName}" في المتجر بنجاح.`);
        }}
      />

      <EditAppModal
        app={editingApp}
        user={user}
        onClose={() => setEditingApp(null)}
        onSaved={(appName) => {
          setToastMessage(`تم حفظ تعديلات "${appName}" بنجاح.`);
        }}
      />

      <AppDetailsModal
        app={selectedApp}
        currentUser={user}
        onClose={() => setSelectedApp(null)}
        onEditApp={(app) => setEditingApp(app)}
        onDeleted={(appName) => {
          setToastMessage(`تم حذف "${appName}" من المتجر.`);
        }}
      />
    </div>
  );
}
