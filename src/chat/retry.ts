export function withNewMessageId<T extends { id: string; role: string }>(messages: readonly T[], newId: () => string): T[] {
  const last = messages.map(m => m.role).lastIndexOf('user');
  return messages.map((m, i) => i === last ? { ...m, id: newId() } : m);
}

// What the retry button may resend after a failed reply. The server never reruns a message id.
// It answered with an error: that attempt is over, so a retry needs a fresh id.
// No answer: the attempt may still finish, so the same id lets the server dedupe instead of executing twice.
// Already accepted: resending the same id can only repeat this answer, so there is nothing to retry.
export function messagesForRetry<T extends { id: string; role: string }>(messages: readonly T[], failure: { status?: number; code?: string }, newId: () => string): T[] | null {
  if (failure.code === 'REQUEST_ALREADY_ACCEPTED') return null;
  return failure.status ? withNewMessageId(messages, newId) : [...messages];
}
