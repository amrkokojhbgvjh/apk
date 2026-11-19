import { Loader2, X } from 'lucide-react';
import { useState } from 'react';
import { GoogleGIcon } from './Icons';

interface LoginRequiredModalProps {
  open: boolean;
  onClose: () => void;
  onGoogleLogin: () => Promise<void>;
}

export function LoginRequiredModal({
  open,
  onClose,
  onGoogleLogin,
}: LoginRequiredModalProps) {
  const [signingIn, setSigningIn] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!open) return null;

  async function handleSignIn() {
    setErrorMsg(null);
    setSigningIn(true);
    try {
      await onGoogleLogin();
    } catch (err) {
      const code =
        typeof err === 'object' && err !== null && 'code' in err
          ? String((err as { code?: unknown }).code)
          : '';
      if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
        setErrorMsg('تم إلغاء نافذة تسجيل الدخول. يرجى المحاولة مرة أخرى.');
      } else if (code === 'auth/popup-blocked') {
        setErrorMsg('قام المتصفح بحظر نافذة تسجيل الدخول. يرجى السماح بالنوافذ المنبثقة والمحاولة مجدداً.');
      } else {
        setErrorMsg('تعذر تسجيل الدخول بحساب Google حالياً. يرجى المحاولة مرة أخرى.');
      }
    } finally {
      setSigningIn(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/45 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4 animate-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && !signingIn) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="login-required-title"
    >
      <div className="w-full sm:max-w-md bg-white rounded-t-[28px] sm:rounded-3xl px-6 pt-6 pb-8 shadow-2xl animate-sheet-up">
        {/* Top Row: Title (right in RTL) + Close Button (left in RTL) */}
        <div className="flex items-center justify-between gap-4">
          <h2
            id="login-required-title"
            className="text-xl font-bold text-slate-900"
          >
            تسجيل الدخول مطلوب
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={signingIn}
            className="w-10 h-10 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-600 flex items-center justify-center transition-colors cursor-pointer disabled:opacity-50"
            aria-label="إغلاق"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body Copy */}
        <p className="text-slate-600 text-[15px] leading-relaxed text-center my-7 px-1">
          لا يمكن رفع التطبيقات إلا بعد تسجيل الدخول بحساب Google (جيميل). سجّل الدخول للمتابعة ورفع تطبيقك بسهولة.
        </p>

        {errorMsg && (
          <div className="mb-4 rounded-xl bg-rose-50 border border-rose-200 px-4 py-3 text-sm text-rose-700 text-center">
            {errorMsg}
          </div>
        )}

        {/* Full-Width Dark Google Sign-In CTA */}
        <button
          type="button"
          onClick={handleSignIn}
          disabled={signingIn}
          className="w-full h-14 rounded-2xl bg-[#0f172a] hover:bg-slate-800 active:scale-[0.99] text-white font-bold text-[15px] flex items-center justify-center gap-3 shadow-sm transition-all cursor-pointer disabled:opacity-65"
        >
          {signingIn ? (
            <>
              <Loader2 className="w-5 h-5 animate-spin" />
              <span>جارٍ تسجيل الدخول...</span>
            </>
          ) : (
            <>
              <GoogleGIcon className="w-5 h-5 shrink-0" />
              <span>تسجيل الدخول بحساب Google</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
}
