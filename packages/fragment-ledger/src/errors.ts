/** Every way the ledger refuses an operation, with the HTTP status its routes answer. */
const ledgerErrorStatuses = {
  LEDGER_NOT_OPEN: 409,
  LEDGER_ALREADY_OPEN: 409,
  CURRENCY_NOT_FOUND: 404,
  CURRENCY_TAKEN: 409,

  FISCAL_YEAR_NOT_FOUND: 404,
  FISCAL_YEAR_NAME_TAKEN: 409,
  FISCAL_YEAR_NOT_CONTIGUOUS: 422,
  PERIOD_NOT_FOUND: 404,
  PERIOD_TRANSITION_INVALID: 409,

  ACCOUNT_NOT_FOUND: 404,
  ACCOUNT_CODE_TAKEN: 409,
  JOURNAL_NOT_FOUND: 404,
  JOURNAL_CODE_TAKEN: 409,
  DIMENSION_NOT_FOUND: 404,
  DIMENSION_CODE_TAKEN: 409,
  DIMENSION_VALUE_NOT_FOUND: 404,
  DIMENSION_VALUE_CODE_TAKEN: 409,
  PARTY_NOT_FOUND: 404,
  PARTY_ACCOUNT_NOT_FOUND: 404,
  PARTY_ACCOUNT_CODE_TAKEN: 409,
  PARTY_ROLE_TAKEN: 409,
  CONTROL_ACCOUNT_INVALID: 422,

  ENTRY_NOT_FOUND: 404,
  ENTRY_UNBALANCED: 422,
  ENTRY_ALREADY_REVERSED: 409,
  ENTRY_REFERENCE_TAKEN: 409,
  POSTING_PERIOD_NOT_OPEN: 422,
  AMOUNT_OUT_OF_RANGE: 422,
  LINE_AMOUNT_ZERO: 422,
  LINE_FUNCTIONAL_AMOUNT_MISMATCH: 422,
  ACCOUNT_INACTIVE: 422,
  ACCOUNT_CURRENCY_MISMATCH: 422,
  OPEN_ITEM_REQUIRED: 422,
  OPEN_ITEM_NOT_ALLOWED: 422,
  PARTY_ACCOUNT_MISMATCH: 422,
  DIMENSION_REPEATED: 422,
  DIMENSION_RULE_VIOLATED: 422,

  OPEN_ITEM_NOT_FOUND: 404,
  ALLOCATION_NOT_FOUND: 404,
  ALLOCATION_SIDES_INVALID: 422,
  ALLOCATION_ITEMS_MISMATCH: 422,
  ALLOCATION_EXCEEDS_OUTSTANDING: 422,
  ALLOCATION_AMOUNT_ZERO: 422,
  ALLOCATION_NOTHING_OUTSTANDING: 422,
  ALLOCATION_ALREADY_REVERSED: 409,
} as const;

export type LedgerErrorCode = keyof typeof ledgerErrorStatuses;

export const ledgerErrorCodes = Object.keys(ledgerErrorStatuses) as LedgerErrorCode[];

/**
 * Thrown by services when an operation breaks a ledger rule. Throwing aborts the whole
 * transaction, including operations composed with it.
 */
export class LedgerError extends Error {
  readonly code: LedgerErrorCode;

  constructor(code: LedgerErrorCode, message: string) {
    super(message);
    this.name = "LedgerError";
    this.code = code;
  }

  get status(): (typeof ledgerErrorStatuses)[LedgerErrorCode] {
    return ledgerErrorStatuses[this.code];
  }
}
