import type { ForkContext } from './types.js';
export declare class ContextBridge {
    private filePath;
    private data;
    constructor(stateDir: string);
    private load;
    private save;
    createFork(parentLabel: string, childLabel: string, contextSummary: string, mergeWindowMinutes: number): ForkContext;
    checkMerge(currentTopicLabel: string, switchToLabel: string): ForkContext | null;
    markMerged(fork: ForkContext): void;
    getContextForChild(childLabel: string): string | null;
    cleanup(): void;
}
