import type { User } from 'firebase/auth';
import { LogOut, Plus, Store, UserRound } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { AndroidMascotIcon, GoogleGIcon } from './Icons';

interface HeaderProps {
  user: User | null;
  authLoading: boolean;
  activeView: 'store' | 'profile';
  myAppsCount: number;
  onHomeClick: () => void;
  onProfileClick: () => void;
  onLoginClick: () => void;
  onLogoutClick: () => void;
  onUploadClick: () => void;
}

export function Header({
  user,
  authLoading,
  activeView,
  myAppsCount,
  onHomeClick,
  onProfileClick,
  onLoginClick,
  onLogoutClick,
  onUploadClick,
}: HeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [avatarFailed, setAvatarFailed] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setAvatarFailed(false);
  }, [user?.photoURL]);

  useEffect(() => {
    if (!menuOpen) return;
    function handleOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleOutside);
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [menuOpen]);

  const userInitial = (user?.displayName || user?.email || 'م').trim().charAt(0).toUpperCase();

  return (
    <header className="sticky top-0 z-30 bg-white/95 backdrop-blur-md border-b border-slate-100">
      <div className="max-w-6xl mx-auto px-3 sm:px-6 h-[64px] flex items-center justify-between gap-2 sm:gap-4">
        {/* Right Zone (RTL): Brand APK + Green Android Square + Store Icon Button */}
        <div className="flex items-center gap-2.5 sm:gap-3 shrink-0">
          <button
            type="button"
            onClick={onHomeClick}
            className="flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 rounded-xl cursor-pointer group"
            aria-label="الصفحة الرئيسية لمتجر APK"
          >
            <span className="w-10 h-10 rounded-xl bg-[#00995e] text-white flex items-center justify-center shadow-xs group-hover:bg-[#008652] transition-colors">
              <AndroidMascotIcon className="w-6 h-6" />
            </span>
            <span className="font-brand font-extrabold text-[19px] tracking-tight text-slate-900 whitespace-nowrap">
              APK
            </span>
          </button>

          <button
            type="button"
            onClick={onHomeClick}
            className={`w-10 h-10 rounded-xl flex items-center justify-center transition-colors cursor-pointer shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
              activeView === 'store'
                ? 'bg-emerald-50 text-[#008f57] hover:bg-emerald-100/80'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200/70'
            }`}
            title="المتجر"
            aria-label="عرض جميع التطبيقات المنشورة"
          >
            <Store className="w-5 h-5" />
          </button>
        </div>

        {/* Left Zone (RTL): Google Login / User Avatar + Upload CTA */}
        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          {authLoading ? (
            <div className="w-10 h-10 rounded-full bg-slate-100 animate-pulse" />
          ) : user ? (
            <div className="relative" ref={menuRef}>
              <button
                type="button"
                onClick={() => setMenuOpen((prev) => !prev)}
                className={`w-10 h-10 rounded-full overflow-hidden ring-2 transition-all flex items-center justify-center bg-indigo-600 text-white font-bold text-sm cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
                  activeView === 'profile'
                    ? 'ring-[#00995e]'
                    : 'ring-slate-200/80 hover:ring-emerald-400'
                }`}
                title={user.displayName || 'الملف الشخصي'}
                aria-label="قائمة الملف الشخصي"
                aria-expanded={menuOpen}
              >
                {user.photoURL && !avatarFailed ? (
                  <img
                    src={user.photoURL}
                    alt={user.displayName || 'صورة المستخدم'}
                    referrerPolicy="no-referrer"
                    onError={() => setAvatarFailed(true)}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <span>{userInitial}</span>
                )}
              </button>

              {menuOpen && (
                <div className="absolute left-0 mt-2 w-64 bg-white rounded-2xl border border-slate-200 shadow-xl shadow-slate-900/10 py-2 z-50">
                  <div className="px-4 py-2.5 border-b border-slate-100">
                    <p className="text-sm font-bold text-slate-900 truncate">
                      {user.displayName || 'مستخدم Google'}
                    </p>
                    <p className="text-xs text-slate-500 truncate mt-0.5" dir="ltr">
                      {user.email}
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpen(false);
                      onProfileClick();
                    }}
                    className="w-full px-4 py-2.5 text-sm font-semibold text-slate-800 hover:bg-slate-50 flex items-center justify-between gap-2 transition-colors cursor-pointer"
                  >
                    <span className="flex items-center gap-2">
                      <UserRound className="w-4 h-4 text-[#00995e]" />
                      <span>الملف الشخصي وإدارة تطبيقاتي</span>
                    </span>
                    <span className="text-xs text-slate-400 tabular-nums">{myAppsCount}</span>
                  </button>

                  <div className="my-1 border-t border-slate-100" />

                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpen(false);
                      onLogoutClick();
                    }}
                    className="w-full px-4 py-2.5 text-sm font-semibold text-rose-600 hover:bg-rose-50 flex items-center gap-2 transition-colors cursor-pointer"
                  >
                    <LogOut className="w-4 h-4" />
                    <span>تسجيل الخروج</span>
                  </button>
                </div>
              )}
            </div>
          ) : (
            <button
              type="button"
              onClick={onLoginClick}
              className="h-10 px-3.5 sm:px-4 rounded-full border border-slate-200 bg-white hover:bg-slate-50 active:scale-[0.98] text-slate-800 text-sm font-semibold flex items-center gap-2 transition-all cursor-pointer whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
            >
              <GoogleGIcon className="w-[18px] h-[18px] shrink-0" />
              <span>دخول</span>
            </button>
          )}

          <button
            type="button"
            onClick={onUploadClick}
            className="h-10 px-4 sm:px-5 rounded-full bg-[#00995e] hover:bg-[#008250] active:scale-[0.98] text-white text-sm font-bold flex items-center gap-1.5 shadow-sm shadow-emerald-600/15 transition-all cursor-pointer whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2"
          >
            <Plus className="w-4 h-4 stroke-[2.5] shrink-0" />
            <span>رفع تطبيقك</span>
          </button>
        </div>
      </div>
    </header>
  );
}
