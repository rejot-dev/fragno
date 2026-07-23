import { z } from "zod";

export const normalizeAuthEmail = (email: string): string => email.trim().toLowerCase();

export const authEmailSchema = z.string().trim().toLowerCase().pipe(z.email().max(191));
