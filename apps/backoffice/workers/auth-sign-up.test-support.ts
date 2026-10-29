import type { createInMemoryBackofficeRuntime } from "@/backoffice-runtime/in-memory-runtime";

type InMemoryBackofficeRuntime = Awaited<ReturnType<typeof createInMemoryBackofficeRuntime>>;

/** Creates the real access code that an in-memory Better Auth sign-up request needs. */
export async function issueTestAccessCode(
  runtime: InMemoryBackofficeRuntime,
): Promise<{ accessCode: string }> {
  const created = await runtime.objects.otp.singleton().commands.createAccessCode({
    label: "Test sign-up",
    codeSource: "random",
    expiresInDays: null,
  });
  if (!created.ok) {
    throw new Error("A random test access code was already taken.");
  }
  return { accessCode: created.accessCode.code };
}
