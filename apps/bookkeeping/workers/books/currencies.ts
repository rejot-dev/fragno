/** The currencies an administration can keep its books in, with their minor-unit digits. */
export const FUNCTIONAL_CURRENCIES = { EUR: 2, USD: 2, GBP: 2 } as const;
export type FunctionalCurrency = keyof typeof FUNCTIONAL_CURRENCIES;
