"use client";
import { useEffect, useMemo, useState } from "react";
import { Check, Link as LinkIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { useCopyButton } from "fumadocs-ui/utils/use-copy-button";
import { TwitterXLogo } from "@/components/logos/twitter-x";

type ControlProps = {
  url: string;
  author?: string;
};

export function Control({ url, author }: ControlProps) {
  const [shareUrl, setShareUrl] = useState("");
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    setShareUrl(`${window.location.origin}${url}`);
  }, [url]);

  const [isChecked, onCopy] = useCopyButton(() => {
    if (shareUrl === "") {
      return;
    }
    void navigator.clipboard.writeText(shareUrl);
  });

  const authorXUrl = useMemo(() => {
    if (!author) {
      return null;
    }
    const normalized = author.toLowerCase();
    if (normalized.includes("wilco")) {
      return "https://x.com/wilcokr";
    }
    if (normalized.includes("jan")) {
      return "https://x.com/jan_schutte";
    }
    return null;
  }, [author]);

  return (
    <div className="space-y-4">
      {authorXUrl ? (
        <a
          href={authorXUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(
            "flex w-full items-center justify-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm font-medium text-gray-700 transition-all duration-200 hover:border-gray-300 hover:bg-gray-50 hover:text-gray-900 dark:border-gray-700 dark:bg-gray-800/60 dark:text-gray-200 dark:hover:border-gray-600 dark:hover:bg-gray-700/50 dark:hover:text-gray-100",
          )}
        >
          <TwitterXLogo className="size-4" />
          Follow
        </a>
      ) : null}
      {/* Copy Link Button */}
      <button
        type="button"
        className={cn(
          "flex w-full items-center justify-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm font-medium text-gray-700 transition-all duration-200 hover:border-gray-300 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800/60 dark:text-gray-200 dark:hover:border-gray-600 dark:hover:bg-gray-700",
          isChecked &&
            "border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-900/20 dark:text-green-400",
        )}
        onClick={onCopy}
      >
        {isChecked ? (
          <>
            <Check className="size-4" />
            Link ready to share
          </>
        ) : (
          <>
            <LinkIcon className="size-4" />
            Copy Article Link
          </>
        )}
      </button>
    </div>
  );
}
