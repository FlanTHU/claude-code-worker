export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
    timestamp: number;
}
export declare class ConversationStore {
    private dir;
    constructor(stateDir: string);
    getMessages(label: string): ChatMessage[];
    appendMessage(label: string, msg: ChatMessage): void;
    clear(label: string): void;
    private filePath;
    private load;
    private save;
}
