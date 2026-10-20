import type { ComponentProps, ReactNode } from "react";

import { InlineAlert } from "./inline-alert";

/** Introduces an agent before its first turn, centered over the prompt that starts it. */
export function ChatStartPanel({
  title,
  description,
  details,
  children,
}: {
  title: string;
  description: string;
  /** Facts that shape the conversation, such as the agent's permissions. */
  details: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="backoffice-scroll h-full overflow-y-auto">
      <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col justify-center px-4 py-8 sm:px-8">
        <h2 className="text-xl font-semibold tracking-[-0.02em] text-balance text-[var(--bo-fg)] sm:text-2xl">
          {title}
        </h2>
        <p className="mt-2 text-sm text-pretty text-[var(--bo-muted)]">{description}</p>
        <div className="mt-2 mb-5">{details}</div>
        {children}
      </div>
    </div>
  );
}

/** A roomy labelled textarea for writing a first message. */
export function ChatPromptField({
  id,
  label,
  ...props
}: Omit<ComponentProps<"textarea">, "className" | "id"> & { id: string; label: string }) {
  return (
    <div className="bo-input">
      <label
        htmlFor={id}
        className="block px-4 pt-3 text-[10px] font-semibold tracking-[0.14em] text-[var(--bo-muted-2)] uppercase"
      >
        {label}
      </label>
      <textarea
        id={id}
        {...props}
        className="block min-h-28 w-full resize-none bg-transparent px-4 pt-2 pb-4 text-base leading-7 text-[var(--bo-fg)] outline-none placeholder:text-[var(--bo-muted-2)] sm:min-h-32"
      />
    </div>
  );
}

/** A note about the first turn, such as who pays for it, beside the action that sends it. */
export function ChatStartFooter({
  note,
  action,
  alert,
}: {
  note: string;
  action: ReactNode;
  alert: string | null;
}) {
  return (
    <>
      <div className="gap-x-gutter mt-3 grid gap-y-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
        <p className="text-xs text-[var(--bo-muted)]">{note}</p>
        {action}
      </div>
      {alert === null ? null : (
        <div className="mt-3">
          <InlineAlert>{alert}</InlineAlert>
        </div>
      )}
    </>
  );
}
