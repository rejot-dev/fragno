import { BACKOFFICE_STATUS_TONES } from "@fragno-private/design-system/feedback/status-tone";
import { z } from "zod";

export const backofficeUiToneSchema = z.enum(BACKOFFICE_STATUS_TONES);
