import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import type {
  BackofficeObjectHandle,
  BackofficeObjectRegistry,
} from "@/backoffice-runtime/object-registry";
import type { UploadAdminConfigResponse } from "@/fragno/upload";

type TestScopedObjects<TObject> = {
  singleton(): TObject;
  for(scope: BackofficeContextScope): TObject;
  forOrg(orgId: string): TObject;
  forName(name: string): TObject;
  forUser(input: { userId: string }): TObject;
  forProject(input: { orgId: string; projectId: string }): TObject;
};

const scopedObject = <TObject>(object: TObject | undefined): TestScopedObjects<TObject> => ({
  singleton: () => object as TObject,
  for: () => object as TObject,
  forOrg: () => object as TObject,
  forName: () => object as TObject,
  forUser: () => object as TObject,
  forProject: () => object as TObject,
});

function objectHandle<TCommands>(
  commands: TCommands,
  fetch: (request: Request) => Promise<Response>,
): BackofficeObjectHandle<TCommands> {
  return {
    commands,
    http: {
      fetch,
      fetchAuthorized: async (request) => await fetch(request),
    },
  };
}

export const createFilesTestObjectRegistry = ({
  uploadConfig,
  uploadRuntime,
  resendRuntime,
}: {
  uploadConfig?: UploadAdminConfigResponse | null;
  uploadRuntime?: { fetch(request: Request): Promise<Response> };
  resendRuntime?: { baseUrl?: string; fetch(request: Request): Promise<Response> };
} = {}): BackofficeObjectRegistry =>
  ({
    upload: scopedObject(
      objectHandle(
        { getAdminConfig: async () => uploadConfig ?? null },
        async (request) => await uploadRuntime!.fetch(request),
      ),
    ),
    resend: scopedObject(
      resendRuntime
        ? objectHandle(resendRuntime, async (request) => await resendRuntime.fetch(request))
        : undefined,
    ),
  }) as unknown as BackofficeObjectRegistry;
