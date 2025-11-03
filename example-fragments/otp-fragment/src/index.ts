import { defineFragmentWithDatabase, defineServices } from "@fragno-dev/db/fragment";
import { otpSchema, authSchema } from "./schema";
import { defineFragment, defineRoute, defineRoutes } from "@fragno-dev/core";
import z from "zod";

/**
 * OTP Service interface that can be used by other fragments
 */
export interface IOTPService {
  /**
   * Generate and store an OTP code for a user
   * @param userId - User ID to generate OTP for
   * @returns The generated OTP code
   */
  generateOTP(userId: string): string;

  /**
   * Verify an OTP code
   * @param userId - User ID
   * @param code - OTP code to verify
   * @returns true if valid, false otherwise
   */
  verifyOTP(userId: string, code: string): Promise<boolean>;
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

export const otpFragmentDefinition = defineFragmentWithDatabase<OTPConfig>("otp-fragment")
  .withDatabase(otpSchema)
  .providesService("otp", {
    generateOTP: function (userId: string): string {
      const uow = this.getUnitOfWork(otpSchema);
      const code = generateOTPCode();
      const expiresAt = new Date();
      expiresAt.setMinutes(expiresAt.getMinutes() + 10); // 10 minutes expiry

      uow.create("otp_code", {
        userId,
        code,
        expiresAt,
        verified: false,
      });

      return code;
    },
    verifyOTP: async function (userId: string, code: string): Promise<boolean> {
      const uow = this.getUnitOfWork(otpSchema).find("otp_code", (b) =>
        b
          .whereIndex("idx_otp_user", (eb) => eb("userId", "=", userId))
          .select(["id", "code", "expiresAt", "verified"]),
      );

      // Wait for retrieval phase to complete and get the typed results
      const [otpCodes] = await uow.retrievalPhase;

      // Find the matching OTP code
      type OTPCode = (typeof otpCodes)[number];
      const otpCode = otpCodes.find((otp: OTPCode) => "code" in otp && otp.code === code);
      if (!otpCode || !("code" in otpCode)) {
        return false;
      }

      // Check if the code has expired
      if (new Date(otpCode.expiresAt) < new Date()) {
        return false;
      }

      // Check if the code has already been verified
      if (otpCode.verified) {
        return false;
      }

      // Mark the code as verified
      uow.update("otp_code", otpCode.id, (b) => b.set({ verified: true }));

      return true;
    },
  });

const otpRoutes = defineRoutes(otpFragmentDefinition).create(({ services }) => {
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

        // Schedule the verification operation (returns immediately)
        const verifyPromise = services.otp.verifyOTP(userId, code);

        // Execute UOW phases
        const uow = this.getUnitOfWork(otpSchema);
        await uow.executeRetrieve();
        await uow.executeMutations();

        // Now await the result
        const verified = await verifyPromise;
        return json({ verified });
      },
    }),
  ];
});

export const otpFragmentRoutes = [otpRoutes] as const;

export interface AuthConfig {
  shouldValidateEmail?: boolean;
}

/**
 * Auth fragment that uses the OTP service for email verification
 */
export const authFragmentDefinition = defineFragmentWithDatabase<AuthConfig>("auth-fragment")
  .withDatabase(authSchema)
  .usesService<"otp", IOTPService>("otp", { optional: true })
  .withServices(({ orm, deps }) => {
    return defineServices({
      /**
       * Create a user with email verification using OTP
       */
      createUserWithOTP: async function (email: string, password: string) {
        // Get UOW from context
        const uow = this.getUnitOfWork(authSchema);

        // Hash password (simplified - in real app use bcrypt/argon2)
        const passwordHash = `hashed_${password}`;

        const userId = uow.create("user", {
          email,
          passwordHash,
          emailVerified: false,
        });

        // Generate OTP if service is available
        let otpCode: string | null = null;
        if (deps.otp) {
          // Cross-schema UOW: the OTP service will use the same UOW context
          // The promise will resolve after the handler executes phases
          otpCode = await deps.otp.generateOTP(userId.toString());
        }

        return {
          userId: userId.valueOf(),
          email,
          emailVerified: false,
          otpCode, // In real app, send via email instead of returning
        };
      },

      createUser: function (email: string, password: string) {
        const uow = this.getUnitOfWork(authSchema);
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
      },

      /**
       * Get user by email
       */
      getUserByEmail: async (email: string) => {
        const user = await orm.findFirst("user", (b) =>
          b
            .whereIndex("idx_user_email", (eb) => eb("email", "=", email))
            .select(["id", "email", "emailVerified"]),
        );

        if (!user) {
          return null;
        }

        return {
          id: user.id.valueOf(),
          email: user.email,
          emailVerified: user.emailVerified,
        };
      },
    });
  });

export const anotherFragmentDefinition = defineFragment<{}>("another-fragment").providesService(
  "asd",
  {
    someMethod: () => "asd",
  },
);

const routeBasedOnType = defineRoutes<typeof authFragmentDefinition>().create(
  ({ config, deps }) => {
    return [
      defineRoute({
        method: "GET",
        path: "/config",
        outputSchema: z.object({
          shouldValidateEmail: z.boolean(),
          otpEnabled: z.boolean(),
        }),
        handler: async function (_, { json }) {
          return json({
            shouldValidateEmail: config.shouldValidateEmail ?? false,
            otpEnabled: deps.otp !== undefined,
          });
        },
      }),
    ];
  },
);

const authRoutes = defineRoutes(authFragmentDefinition).create(({ services, deps }) => {
  return [
    defineRoute({
      method: "GET",
      path: "/auth/user",
      queryParameters: ["email"],
      outputSchema: z
        .object({
          id: z.string(),
          email: z.string(),
          emailVerified: z.boolean(),
        })
        .nullable(),
      handler: async ({ query }, { json, error }) => {
        const email = query.get("email");
        if (!email) {
          return error({ message: "Email required", code: "email_required" }, 400);
        }

        const user = await services.getUserByEmail(email);

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

        // Schedule operations (don't await yet)
        const user = services.createUser(email, password);
        const otpCode = deps.otp?.generateOTP(user.id) ?? null;

        // Execute UOW phases once - the UOW handles all schemas together
        const uow = this.getUnitOfWork();
        await uow.executeRetrieve();
        await uow.executeMutations();

        // Now await the results
        // const otpCode = (await otpCodePromise) ?? null;

        console.log("otpCode", otpCode);

        return json({
          userId: user.id,
          email: user.email,
          emailVerified: user.emailVerified,
          otpCode,
        });
      },
    }),
  ];
});

const randomRoute = defineRoute({
  method: "GET",
  path: "/random",
  outputSchema: z.object({
    random: z.number().min(0).max(1000),
  }),
  handler: async function (_, { json }) {
    console.log("random route", this);
    return json({ random: Math.floor(Math.random() * 1000) });
  },
});

export const authFragmentRoutes = [authRoutes, randomRoute, routeBasedOnType] as const;

export { otpSchema, authSchema };
