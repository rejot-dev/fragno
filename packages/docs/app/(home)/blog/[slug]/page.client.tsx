"use client";
import { Check, Twitter, Linkedin, Link as LinkIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { useCopyButton } from "fumadocs-ui/utils/use-copy-button";

export function Control({ url }: { url: string }) {
  const [isChecked, onCopy] = useCopyButton(() => {
    void navigator.clipboard.writeText(`${window.location.origin}${url}`);
  });

  const fullUrl = typeof window !== "undefined" ? `${window.location.origin}${url}` : "";
  const encodedUrl = encodeURIComponent(fullUrl);
  const encodedTitle = encodeURIComponent("Check out this article on Fragno");

  const shareLinks = [
    {
      name: "X",
      icon: Twitter,
      href: `https://twitter.com/intent/tweet?url=${encodedUrl}&text=${encodedTitle}`,
      color:
        "hover:bg-gray-50 hover:text-gray-900 dark:hover:bg-gray-700/50 dark:hover:text-gray-100",
    },
    {
      name: "LinkedIn",
      icon: Linkedin,
      href: `https://www.linkedin.com/sharing/share-offsite/?url=${encodedUrl}`,
      color:
        "hover:bg-gray-50 hover:text-gray-900 dark:hover:bg-gray-700/50 dark:hover:text-gray-100",
    },
  ];

  return (
    <div className="space-y-4">
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
            <Check className="h-4 w-4" />
            Link copied!
          </>
        ) : (
          <>
            <LinkIcon className="h-4 w-4" />
            Copy link
          </>
        )}
      </button>

      {/* Social Share Buttons */}
      <div className="grid grid-cols-2 gap-2">
        {shareLinks.map((link) => (
          <a
            key={link.name}
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
              "flex items-center justify-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-600 transition-all duration-200 dark:border-gray-700 dark:bg-gray-800/60 dark:text-gray-300",
              link.color,
            )}
          >
            <link.icon className="h-4 w-4" />
            <span className="hidden sm:inline">{link.name}</span>
          </a>
        ))}
      </div>
    </div>
  );
}
