export type Role = 'user' | 'assistant' | 'system' | 'tool';

export interface ChatTurn {
  role: Role;
  html: string; // raw HTML of the turn (preserves code blocks/tables)
  text: string; // plain text fall-back
}

export interface ConversationExport {
  title: string;
  url: string;
  exportedAt: string; // ISO
  turns: ChatTurn[];
}
