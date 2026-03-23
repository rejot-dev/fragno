type AddFormats = ((ajv: unknown) => unknown) & {
  get?: (name: string, mode?: string) => unknown;
};

const addFormats: AddFormats = (ajv) => ajv;

addFormats.get = () => undefined;

export default addFormats;
