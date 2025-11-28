export interface MailingListConfig {
  // Add any server-side configuration here if needed
  onSubscribe?: (email: string) => Promise<void>;
}

export interface MailingListServices {
  subscribe: (email: string) => Promise<{
    id: string;
    email: string;
    subscribedAt: Date;
    alreadySubscribed: boolean;
  }>;
  getSubscribers: () => Promise<
    Array<{
      id: string;
      email: string;
      subscribedAt: Date;
    }>
  >;
}
