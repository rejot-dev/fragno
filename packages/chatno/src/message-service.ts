export interface MessageService {
  setData: (messageKey: string, message: string) => Promise<void>;
  getData: (messageKey: string) => Promise<string | undefined>;
}

const inMemoryMessageStore: Record<string, string> = {};
export const inMemoryMessageService: MessageService = {
  setData: async (messageKey: string, message: string) => {
    inMemoryMessageStore[messageKey] = message;
  },
  getData: async (messageKey: string) => {
    return inMemoryMessageStore[messageKey];
  },
};

inMemoryMessageService.setData("default", "Hello World");
