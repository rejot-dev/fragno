/** What people read when an access code keeps them from creating an account. */
export const ACCESS_CODE_ERROR_CONTENT = {
  access_code_required: {
    title: "An access code is required",
    message: "Creating a Backoffice account needs an access code. Ask an administrator for one.",
  },
  access_code_invalid: {
    title: "This access code is not valid",
    message: "Check the code in your sign-up link, or ask an administrator for a new one.",
  },
  access_code_expired: {
    title: "This access code has expired",
    message: "Ask an administrator for a new access code.",
  },
} as const;
