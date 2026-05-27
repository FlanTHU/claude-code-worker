export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
    timestamp: number;
}
export declare class ConversationStore {
    private dir;
    private cache;
    private dirty;
    private flushTimer;
    constructor(stateDir: string);
    getMessages(label: string): ChatMessage[];
    appendMessage(label: string, msg: ChatMessage): void;
    clear(label: string): void;
    flushSync(): void;
    private getOrLoad;
    private scheduleFlush;
    private filePath;
    private readFromDisk;
    private writeToDisk;
}
