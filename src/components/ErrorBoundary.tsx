import React from 'react';

interface ErrorBoundaryState {
  hasError: boolean;
  errorMessage: string;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, errorMessage: '' };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      errorMessage: error?.message || 'حدث خطأ غير متوقع في التطبيق.',
    };
  }

  componentDidCatch(error: Error) {
    console.error('App ErrorBoundary caught:', error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          dir="rtl"
          className="min-h-screen bg-[#f8fafc] flex items-center justify-center p-6"
        >
          <div className="w-full max-w-md bg-white rounded-3xl border border-slate-200 p-7 text-center shadow-sm">
            <h2 className="text-xl font-bold text-slate-900">حدث خطأ غير متوقع</h2>
            <p className="text-sm text-slate-600 mt-3 leading-relaxed">
              واجه المتجر مشكلة مؤقتة أثناء عرض البيانات. يرجى إعادة تحميل الصفحة للمتابعة.
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-6 w-full h-12 rounded-2xl bg-[#00995e] hover:bg-[#008250] text-white font-bold text-sm transition-colors cursor-pointer"
            >
              إعادة تحميل الصفحة
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
