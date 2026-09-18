export type Message = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  welcome?: boolean;
  sources?: string[];
  asOf?: string;
  truncated?: boolean;
  overview?: { available: number; recentEntries: number };
};

export interface ChatAdapter {
  reply(messages: readonly Message[], signal: AbortSignal, userId: string): Promise<Omit<Message, 'id' | 'role'>>;
}

export class ChatError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export const liveAdapter: ChatAdapter = {
  async reply(messages, signal, userId) {
    // Bound the history to the server's request budget; never send welcome/demo content.
    const history: { role: string; content: string }[] = [];
    let size = 0;
    for (const message of messages.filter(m => !m.welcome).slice(-24).reverse()) {
      if (size + message.text.length > 12000) break;
      history.unshift({ role: message.role, content: message.text });
      size += message.text.length;
    }
    while (history[0]?.role === 'assistant') history.shift();
    const response = await fetch('/api/chat', {
      method: 'POST', credentials: 'same-origin', signal,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: history, expectedUserId: userId }),
    });
    const data = await response.json();
    if (!response.ok) throw new ChatError(data.error?.message || '回复暂时未能送达，请重试。', response.status);
    return data;
  },
};

export function initialMessages(): Message[] {
  return [{ id: 'welcome', role: 'assistant', welcome: true, text: '你好，我是澄川智能助手。我可以结合你的账户、收支和个人资料，帮你了解本站服务，也可以陪你聊聊。' }];
}
