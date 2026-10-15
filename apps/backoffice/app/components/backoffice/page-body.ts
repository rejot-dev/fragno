import { backofficePageColumnClassName } from "@fragno-private/design-system/tab-header";

/**
 * The content under a page's tab header. Its padding lines content up with the header's first tab.
 * Explorers and chats, which use every pixel, do not use it.
 */
export const backofficePageBodyClassName = `${backofficePageColumnClassName} p-4 sm:p-6`;
