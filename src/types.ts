// types.ts
export type Role = 'user' | 'assistant' | 'system' | 'tool';
export interface ChatTurn { role: Role; html: string; text: string; }
export interface ConversationExport { title: string; url: string; exportedAt: string; turns: ChatTurn[]; }
export type NoteMode = 'single' | 'multi' | 'auto';

export interface ExportTurn {
  role: 'user' | 'assistant' | 'system' | 'tool';
  time?: string;      // ISO string if available
  text: string;       // raw plain text
}

export interface ExportNoteMetadata {
  noteId: string;           // "ext-<uuid>"
  source: 'chatgpt';
  chatId?: string;
  chatTitle?: string;
  pageUrl: string;
  exportedAt: string;       // ISO
  model?: string;

  subject?: string;
  topic?: string;

  // ↓ new/extended fields so content.ts can assign them without ignores
  summary?: string | null;
  tags?: string[];
  autoGenerate?: { summary: boolean; tags: boolean };

  noteMode?: NoteMode;
  turnCount?: number;
  splitHints?: string[];

  author?: string;
  visibility?: 'private' | 'shared' | 'public';
}
