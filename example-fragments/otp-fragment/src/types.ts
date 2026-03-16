import { z } from "zod";

export const otpTypeSchema = z.string().min(1);
export type OtpType = z.infer<typeof otpTypeSchema>;

export const otpStatusSchema = z.enum(["pending", "confirmed", "expired", "invalidated"]);
export type OtpStatus = z.infer<typeof otpStatusSchema>;

export type OtpErrorCode = "OTP_INVALID" | "OTP_EXPIRED";
