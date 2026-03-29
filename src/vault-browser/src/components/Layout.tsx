import { ReactNode } from "react";

interface LayoutProps {
  children: ReactNode;
  onNavigateHome: () => void;
  onLogout: () => void;
}

export default function Layout({ children, onNavigateHome, onLogout }: LayoutProps) {
  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 flex flex-col">
      <header className="border-b border-gray-800 bg-gray-900/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-[1600px] mx-auto px-4 h-12 flex items-center justify-between">
          <button
            onClick={onNavigateHome}
            className="flex items-center gap-2 text-white font-semibold hover:text-blue-400 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
            </svg>
            ContextVault
          </button>
          <button
            onClick={onLogout}
            className="text-gray-400 hover:text-white text-sm transition-colors"
          >
            Disconnect
          </button>
        </div>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}
