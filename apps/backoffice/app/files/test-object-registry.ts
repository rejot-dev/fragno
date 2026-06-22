import type { BackofficeContextScope } from "@/backoffice-runtime/context";
import type { BackofficeObjectRegistry } from "@/backoffice-runtime/object-registry";
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
    upload: scopedObject({
      getAdminConfig: async () => uploadConfig ?? null,
      fetch: async (request: Request) => uploadRuntime!.fetch(request),
    }),
    resend: scopedObject(resendRuntime),
  }) as Partial<BackofficeObjectRegistry> as BackofficeObjectRegistry;
