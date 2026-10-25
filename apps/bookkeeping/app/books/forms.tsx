import { Button, type ButtonVariant } from "@fragno-private/design-system/button";
import { Dialog } from "@fragno-private/design-system/dialog";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Form, useNavigation } from "react-router";

import type { FormResult } from "./books.server";

/** The refusal of the form submitted with `intent`, under that form. */
export function FormError({ result, intent }: { result: FormResult | undefined; intent: string }) {
  if (result?.intent !== intent || result.error === null) {
    return null;
  }
  return (
    <p role="alert" className="text-sm text-pretty text-[var(--bo-failed)]">
      {result.error}
    </p>
  );
}

/**
 * A ref for the form submitted with `intent` that empties it once its submission succeeds, so the
 * next record starts blank; a refused submission keeps what was typed.
 */
export function useFormReset(result: FormResult | undefined, intent: string) {
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (result?.intent === intent && result.error === null) {
      form.current?.reset();
    }
  }, [result, intent]);
  return form;
}

/**
 * A button opening a form in a dialog. The form submits `intent`, and its result answers to
 * `resultIntent`: the dialog shows a refusal and closes once the submission succeeds. Each opening
 * starts from a blank form.
 */
export function FormDialog({
  label,
  variant,
  title,
  description,
  intent,
  resultIntent,
  submit,
  result,
  children,
}: {
  label: string;
  variant: ButtonVariant;
  title: string;
  description: string | null;
  intent: string;
  resultIntent: string;
  submit: string;
  result: FormResult | undefined;
  children: ReactNode;
}) {
  const navigation = useNavigation();
  const [open, setOpened] = useState(false);
  // What the page answered before this opening belongs to an earlier submission.
  const [answeredBefore, setAnsweredBefore] = useState(result);
  const answered = result !== answeredBefore && result?.intent === resultIntent;
  if (open && answered && result?.error === null) {
    setOpened(false);
  }
  const setOpen = (next: boolean) => {
    setAnsweredBefore(result);
    setOpened(next);
  };
  return (
    <>
      <Button
        variant={variant}
        onClick={() => {
          setOpen(true);
        }}
      >
        {label}
      </Button>
      <Dialog open={open} onOpenChange={setOpen} title={title} description={description}>
        <Form method="post" className="space-y-5">
          <input type="hidden" name="intent" value={intent} />
          <input type="hidden" name="resultIntent" value={resultIntent} />
          {children}
          {answered ? <FormError result={result} intent={resultIntent} /> : null}
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                setOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" variant="solid" disabled={navigation.state !== "idle"}>
              {submit}
            </Button>
          </div>
        </Form>
      </Dialog>
    </>
  );
}
