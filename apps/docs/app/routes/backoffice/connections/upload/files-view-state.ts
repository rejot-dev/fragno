export const DELETED_SELECTED_FILE_MESSAGE = "The selected file has been deleted.";

type VisibleSelectedFileErrorOptions = {
  selectedFileError: string | null;
  actionOk: boolean;
  actionIntent?: string;
  actionFileKey?: string;
  actionProvider?: string;
  selectedFileKey: string | null;
  selectedFileProvider: string | null;
};

export const getVisibleSelectedFileError = ({
  selectedFileError,
  actionOk,
  actionIntent,
  actionFileKey,
  actionProvider,
  selectedFileKey,
  selectedFileProvider,
}: VisibleSelectedFileErrorOptions) => {
  if (
    actionOk &&
    actionIntent === "delete-file" &&
    actionFileKey === selectedFileKey &&
    actionProvider === selectedFileProvider &&
    selectedFileError === DELETED_SELECTED_FILE_MESSAGE
  ) {
    return null;
  }

  return selectedFileError;
};
