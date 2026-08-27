// otp tools
type OtpCodemodeProvider = {
  /** Create a short-lived identity claim URL for the trusted external initiator. */
  createIdentityClaim(input: OtpCreateIdentityClaimInput): Promise<OtpCreateIdentityClaimOutput>;
};
declare const otp: OtpCodemodeProvider;

type OtpCreateIdentityClaimInput = {
  ttlMinutes?: number;
};
type OtpCreateIdentityClaimOutput = {
  url: string;
  otpId: string;
  externalId: string;
  code: string;
  actor: {
    scope: "external";
    source: string;
    type: string;
    id: string;
  };
  type?: string;
  expiresAt?: string;
};
