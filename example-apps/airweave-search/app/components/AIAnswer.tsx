import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
interface AIAnswerProps {
  content: string;
}

// Transform 【n】 or [[n]] references into markdown links [n](#result-n)
function transformReferences(text: string): string {
  // First, match CJK corner brackets with numbers: 【1】, 【2】, etc.
  let result = text.replace(/【(\d+)】/g, (_, num) => `[${num}](#result-${num})`);
  // Also match double square brackets: [[1]], [[2]], etc.
  result = result.replace(/\[\[(\d+)\]\]/g, (_, num) => `[${num}](#result-${num})`);
  return result;
}

// Custom link component for ReactMarkdown
function LinkComponent({ href, children }: { href?: string; children?: React.ReactNode }) {
  return (
    <a
      href={href}
      className="rounded border border-green-300 font-semibold text-green-600 hover:underline dark:border-green-600 dark:text-green-400"
    >
      {children}
    </a>
  );
}

export function AIAnswer({ content }: AIAnswerProps): React.JSX.Element {
  const transformedContent = transformReferences(content);
  console.log("after", transformedContent);

  return (
    <div className="mb-8 rounded-xl border-2 border-green-200 bg-gradient-to-r from-green-50 to-emerald-50 p-6 dark:border-green-700 dark:from-green-900/30 dark:to-emerald-900/30">
      <h3 className="mb-3 flex items-center gap-2 text-xl font-bold text-green-900 dark:text-green-100">
        <svg
          className="h-6 w-6"
          viewBox="0 0 64 64"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
          role="img"
        >
          <path
            d="M22.625 2c0 15.834-8.557 30-20.625 30c12.068 0 20.625 14.167 20.625 30c0-15.833 8.557-30 20.625-30c-12.068 0-20.625-14.166-20.625-30"
            fill="currentColor"
          ></path>
          <path
            d="M47 32c0 7.918-4.277 15-10.313 15C42.723 47 47 54.084 47 62c0-7.916 4.277-15 10.313-15C51.277 47 47 39.918 47 32z"
            fill="currentColor"
          ></path>
          <path
            d="M51.688 2c0 7.917-4.277 15-10.313 15c6.035 0 10.313 7.084 10.313 15c0-7.916 4.277-15 10.313-15c-6.036 0-10.313-7.083-10.313-15"
            fill="currentColor"
          ></path>
        </svg>
        AI Answer
      </h3>
      <div className="prose prose-gray dark:prose-invert prose-headings:text-gray-900 dark:prose-headings:text-gray-100 prose-p:text-gray-800 dark:prose-p:text-gray-200 prose-p:leading-relaxed prose-strong:text-gray-900 dark:prose-strong:text-gray-100 prose-code:text-green-700 dark:prose-code:text-green-300 prose-code:bg-green-100 dark:prose-code:bg-green-900/50 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:before:content-none prose-code:after:content-none prose-pre:bg-gray-800 dark:prose-pre:bg-gray-950 prose-pre:text-gray-100 dark:prose-pre:text-gray-200 prose-ul:text-gray-800 dark:prose-ul:text-gray-200 prose-ol:text-gray-800 dark:prose-ol:text-gray-200 prose-li:text-gray-800 dark:prose-li:text-gray-200 max-w-none">
        {
          Markdown({
            children: transformedContent,
            remarkPlugins: [remarkGfm],
            components: {
              a: LinkComponent,
            },
          }) as React.ReactNode
        }
      </div>
    </div>
  );
}
