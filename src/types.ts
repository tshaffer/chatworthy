
export type Role = 'user' | 'assistant' | 'system' | 'tool';
export interface ChatTurn { role: Role; html: string; text: string; }
export interface ConversationExport { title: string; url: string; exportedAt: string; turns: ChatTurn[]; }
