import { Link } from "react-router";

interface LayoutProps {
  children: React.ReactNode;
  activeTab: "search" | "sources" | "connections";
}

export function Layout({ children, activeTab }: LayoutProps): React.JSX.Element {
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-green-50 px-4 py-12 dark:from-gray-900 dark:to-gray-800">
      <main className="mx-auto max-w-4xl">
        {/* Header */}
        <div className="mb-8 text-center">
          <h1 className="mb-3 bg-gradient-to-r from-green-600 to-emerald-600 bg-clip-text text-5xl font-bold text-transparent">
            Airweave Search
          </h1>
          <p className="text-lg text-gray-600 dark:text-gray-300">Semantic search powered by AI</p>
        </div>

        {/* Navigation */}
        <div className="mb-8">
          <div className="flex items-center justify-center gap-2 rounded-2xl bg-white p-2 shadow-lg dark:bg-gray-800">
            <Link
              to="/"
              className={`flex-1 rounded-xl px-6 py-3 text-center font-semibold transition-all ${
                activeTab === "search"
                  ? "bg-gradient-to-r from-green-600 to-emerald-600 text-white"
                  : "text-gray-600 hover:bg-green-50 hover:text-green-600 dark:text-gray-300 dark:hover:bg-gray-700 dark:hover:text-green-400"
              }`}
            >
              Search
            </Link>
            <Link
              to="/sources"
              className={`flex-1 rounded-xl px-6 py-3 text-center font-semibold transition-all ${
                activeTab === "sources"
                  ? "bg-gradient-to-r from-green-600 to-emerald-600 text-white"
                  : "text-gray-600 hover:bg-green-50 hover:text-green-600 dark:text-gray-300 dark:hover:bg-gray-700 dark:hover:text-green-400"
              }`}
            >
              Sources
            </Link>
            <Link
              to="/connections"
              className={`flex-1 rounded-xl px-6 py-3 text-center font-semibold transition-all ${
                activeTab === "connections"
                  ? "bg-gradient-to-r from-green-600 to-emerald-600 text-white"
                  : "text-gray-600 hover:bg-green-50 hover:text-green-600 dark:text-gray-300 dark:hover:bg-gray-700 dark:hover:text-green-400"
              }`}
            >
              Connections
            </Link>
          </div>
        </div>

        {/* Page Content */}
        {children}
      </main>

      {/* Footer */}
      <footer className="mt-16 flex items-center justify-center gap-2 text-center text-gray-600 dark:text-gray-400">
        <a
          href="https://airweave.ai/"
          target="_blank"
          rel="noopener noreferrer"
          className="transition-colors hover:text-green-600 dark:hover:text-green-400"
        >
          Airweave
        </a>
        <span>×</span>
        <a
          href="https://fragno.dev/"
          target="_blank"
          rel="noopener noreferrer"
          className="transition-colors hover:text-green-600 dark:hover:text-green-400"
        >
          Fragno
        </a>
      </footer>
    </div>
  );
}
