export type OtpIssueErrorCode = "OTP_ID_EMPTY" | "OTP_ID_TOO_LONG" | "OTP_ID_CONFLICT";

export class OtpIssueError extends Error {
  readonly code: OtpIssueErrorCode;

  constructor(code: OtpIssueErrorCode, message: string) {
    super(message);
    this.name = "OtpIssueError";
    this.code = code;
  }
}
