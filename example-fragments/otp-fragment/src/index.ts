import { defineFragment, defineRoute, defineRoutes, instantiate } from "@fragno-dev/core";
import type { FragnoPublicConfigWithDatabase, TxResult } from "@fragno-dev/db";
import { withDatabase } from "@fragno-dev/db";
import { otpSchema, authSchema } from "./schema";
import z from "zod";
import { generateId } from "@fragno-dev/db/schema";

/**
 * OTP Service interface that can be used by other fragments
 */
export interface IOTPService {
  /**
   * Generate and store an OTP code for a user
   * @param userId - User ID to generate OTP for
   * @returns The generated OTP code
   */
  generateOTP(userId: string): TxResult<string>;

  /**
   * Verify an OTP code
   * @param userId - User ID
   * @param code - OTP code to verify
   * @returns true if valid, false otherwise
   */
  verifyOTP(userId: string, code: string): TxResult<boolean>;
}

export interface OTPConfig {
  defaultExpiryMinutes?: number;
}

/**
 * Generate a random 6-digit OTP code
 */
function generateOTPCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

export const otpFragmentDefinition = defineFragment<OTPConfig>("otp-fragment")
  .extend(withDatabase(otpSchema))
  .providesService("otp", ({ defineService }) =>
    defineService({
      generateOTP: function (userId: string) {
        const code = generateOTPCode();
        const expiresAt = new Date();
        expiresAt.setMinutes(expiresAt.getMinutes() + 10); // 10 minutes expiry

        return this.serviceTx(otpSchema)
          .mutate(({ uow }) => {
            uow.create("otp_code", {
              userId,
              code,
              expiresAt,
              verified: false,
            });
            return code;
          })
          .build();
      },
      verifyOTP: function (userId: string, code: string) {
        return this.serviceTx(otpSchema)
          .retrieve((uow) => {
            return uow.find("otp_code", (b) =>
              b
                .whereIndex("idx_otp_user", (eb) => eb("userId", "=", userId))
                .select(["id", "code", "expiresAt", "verified"]),
            );
          })
          .transformRetrieve(([otpCodes]) => {
            // Find the matching OTP code
            type OTPCode = (typeof otpCodes)[number];
            const otpCode = otpCodes.find((otp: OTPCode) => "code" in otp && otp.code === code);
            if (!otpCode || !("code" in otpCode)) {
              return { valid: false, otpCode: null };
            }

            // Check if the code has expired
            if (new Date(otpCode.expiresAt) < new Date()) {
              return { valid: false, otpCode: null };
            }

            // Check if the code has already been verified
            if (otpCode.verified) {
              return { valid: false, otpCode: null };
            }

            return { valid: true, otpCode };
          })
          .mutate(({ uow, retrieveResult }) => {
            if (!retrieveResult.valid || !retrieveResult.otpCode) {
              return false;
            }

            // Mark the code as verified
            uow.update("otp_code", retrieveResult.otpCode.id, (b) => b.set({ verified: true }));

            return true;
          })
          .build();
      },
    }),
  )
  .build();

const otpRoutesFactory = defineRoutes(otpFragmentDefinition).create(({ services, defineRoute }) => {
  return [
    defineRoute({
      method: "POST",
      path: "/otp/verify",
      inputSchema: z.object({
        userId: z.string(),
        code: z.string(),
      }),
      outputSchema: z.object({
        verified: z.boolean(),
      }),
      handler: async function ({ input }, { json }) {
        const { userId, code } = await input.valid();

        const verified = await this.handlerTx()
          .withServiceCalls(() => [services.otp.verifyOTP(userId, code)] as const)
          .transform(({ serviceResult: [result] }) => result)
          .execute();

        return json({ verified });
      },
    }),
  ];
});

export const otpFragmentRoutes = [otpRoutesFactory] as const;

export function createOTPFragment(config: OTPConfig = {}, options: FragnoPublicConfigWithDatabase) {
  return instantiate(otpFragmentDefinition)
    .withConfig(config)
    .withRoutes(otpFragmentRoutes)
    .withOptions(options)
    .build();
}

export interface AuthConfig {
  shouldValidateEmail?: boolean;
}

/**
 * Auth fragment that uses the OTP service for email verification
 */
export const authFragmentDefinition = defineFragment<AuthConfig>("auth-fragment")
  .extend(withDatabase(authSchema))
  .usesOptionalService<"otp", IOTPService>("otp")
  .providesBaseService(({ serviceDeps, defineService }) => {
    return defineService({
      /**
       * Create a user with email verification using OTP
       */
      createUserWithOTP: function (email: string, password: string) {
        // Hash password (simplified - in real app use bcrypt/argon2)
        const passwordHash = `hashed_${password}`;

        const userId = generateId(authSchema, "user");

        return (
          this.serviceTx(authSchema)
            // Generate OTP if service is available
            .withServiceCalls(() => [serviceDeps.otp?.generateOTP(userId.externalId)])
            .mutate(({ uow }) => {
              uow.create("user", {
                id: userId,
                email,
                passwordHash,
                emailVerified: false,
              });

              return {
                userId: userId.valueOf(),
                email,
                emailVerified: false,
              };
            })
            .transform(({ serviceResult: [otpCode], mutateResult }) => {
              return {
                ...mutateResult,
                otpCode,
              };
            })
            .build()
        );
      },

      createUser: function (email: string, password: string) {
        return this.serviceTx(authSchema)
          .mutate(({ uow }) => {
            const userId = uow.create("user", {
              email,
              passwordHash: `hashed_${password}`, // fake hash
              emailVerified: false,
            });

            return {
              id: userId.valueOf(),
              email,
              emailVerified: false,
            };
          })
          .build();
      },

      /**
       * Get user by email
       */
      getUserByEmail: function (email: string) {
        return this.serviceTx(authSchema)
          .retrieve((uow) => {
            return uow.find("user", (b) =>
              b
                .whereIndex("idx_user_email", (eb) => eb("email", "=", email))
                .select(["id", "email", "emailVerified"])
                .pageSize(1),
            );
          })
          .transformRetrieve(([users]) => {
            const user = users[0] ?? null;

            if (!user) {
              return null;
            }

            return {
              id: user.id.valueOf(),
              email: user.email,
              emailVerified: user.emailVerified,
            };
          })
          .build();
      },
    });
  })
  .build();

export const anotherFragmentDefinition = defineFragment<Record<string, never>>("another-fragment")
  .providesService("asd", ({ defineService }) =>
    defineService({
      someMethod: () => "asd",
    }),
  )
  .build();

const routeBasedOnTypeFactory = defineRoutes(authFragmentDefinition).create(
  ({ config, serviceDeps, defineRoute }) => {
    return [
      defineRoute({
        method: "GET",
        path: "/config",
        outputSchema: z.object({
          shouldValidateEmail: z.boolean(),
          otpEnabled: z.boolean(),
        }),
        handler: async (_, { json }) => {
          return json({
            shouldValidateEmail: config.shouldValidateEmail ?? false,
            otpEnabled: serviceDeps.otp !== undefined,
          });
        },
      }),
    ];
  },
);

const authRoutesFactory = defineRoutes(authFragmentDefinition).create(
  ({ services, serviceDeps, defineRoute }) => {
    return [
      defineRoute({
        method: "GET",
        path: "/auth/user",
        queryParameters: ["email"] as const,
        outputSchema: z
          .object({
            id: z.string(),
            email: z.string(),
            emailVerified: z.boolean(),
          })
          .nullable(),
        handler: async function ({ query }, { json, error }) {
          const email = query.get("email");
          if (!email) {
            return error({ message: "Email required", code: "email_required" }, 400);
          }

          const user = await this.handlerTx()
            .withServiceCalls(() => [services.getUserByEmail(email)] as const)
            .transform(({ serviceResult: [result] }) => result)
            .execute();

          if (!user) {
            return error({ message: "User not found", code: "user_not_found" }, 404);
          }

          return json({
            id: user.id,
            email: user.email,
            emailVerified: user.emailVerified,
          });
        },
      }),
      defineRoute({
        method: "POST",
        path: "/auth/sign-up",
        inputSchema: z.object({
          email: z.string(),
          password: z.string(),
        }),
        outputSchema: z.object({
          userId: z.string(),
          email: z.string(),
          emailVerified: z.boolean(),
          otpCode: z.string().nullable(),
        }),
        handler: async function ({ input }, { json }) {
          const { email, password } = await input.valid();

          // Create user first
          const user = await this.handlerTx()
            .withServiceCalls(() => [services.createUser(email, password)] as const)
            .transform(({ serviceResult: [result] }) => result)
            .execute();

          // Then generate OTP if service is available
          let otpCode: string | null = null;
          if (serviceDeps.otp) {
            otpCode = await this.handlerTx()
              .withServiceCalls(() => [serviceDeps.otp!.generateOTP(user.id)] as const)
              .transform(({ serviceResult: [code] }) => code)
              .execute();
          }

          return json({
            userId: user.id,
            email: user.email,
            emailVerified: user.emailVerified,
            otpCode,
          });
        },
      }),
    ];
  },
);

const randomRoute = defineRoute({
  method: "GET",
  path: "/random",
  outputSchema: z.object({
    random: z.number().min(0).max(1000),
  }),
  handler: async function (_, { json }) {
    return json({ random: Math.floor(Math.random() * 1000) });
  },
});

export const authFragmentRoutes = [
  authRoutesFactory,
  randomRoute,
  routeBasedOnTypeFactory,
] as const;

export function createAuthFragmentWithOTP(
  config: AuthConfig = {},
  options: FragnoPublicConfigWithDatabase,
) {
  return instantiate(authFragmentDefinition)
    .withConfig(config)
    .withRoutes(authFragmentRoutes)
    .withOptions(options)
    .build();
}

export { otpSchema, authSchema };
