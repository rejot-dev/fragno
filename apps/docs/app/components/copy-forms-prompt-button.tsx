"use client";

import { useState, useCallback } from "react";
import { Copy, Check } from "lucide-react";

const LLM_PROMPT = `Add Fragno Forms to my application following docs on https://fragno.dev/docs/forms
For examples on how to use client hooks see: https://fragno.dev/docs/forms/hooks
Key steps:
- Server: Re-use or initialize a Fragno DB adapter, create fragment instance, mount api routes
- Database: Generate schema for this fragment using fragno-cli, generate a db schema migration once generated
- Client: Create client instance, use hooks (useForm, useSubmitForm)
- Render forms with JSON Schema + JSONForms UI Schema

Check with me the following:
- What path to mount the api routes (default /api/forms)
- What JSONforms Renderer to use (default shadcn/ui: https://fragno.dev/docs/forms/shadcn-renderer)
- Whether I want the visual Form Builder component installed (shadcn/ui only):
  pnpm dlx shadcn@latest add https://fragno.dev/forms/form-builder.json
`;

export function CopyFormsPromptButton() {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(LLM_PROMPT);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, []);

  return (
    <button
      onClick={handleCopy}
      className="flex items-center gap-2 rounded-lg border border-gray-300 px-6 py-3 font-semibold text-gray-700 shadow-sm transition-colors hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
    >
      {copied ? (
        <>
          <Check className="size-4" />
          Prompt Copied!
        </>
      ) : (
        <>
          <Copy className="size-4" />
          Copy Install Prompt
        </>
      )}
    </button>
  );
}
