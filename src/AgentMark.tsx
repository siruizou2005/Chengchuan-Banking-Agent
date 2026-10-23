/** Shared Agent identity: a central core with organic paths to four nodes. */
export function AgentMark({ size = 26, className = '', active = false }: { size?: number; className?: string; active?: boolean }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`agent-mark ${className}`}>
    <path d="M12 8.5C12 5.5 8 7 6 4.5M15.5 12c3 0 1.5-4 4-6M12 15.5c0 3 4 1.5 6 4M8.5 12c-3 0-1.5 4-4 6" />
    <circle cx="12" cy="12" r="3.5" fill={active ? 'currentColor' : 'none'} />
    <circle cx="5" cy="3.5" r="1.5" /><circle cx="20.5" cy="5" r="1.5" /><circle cx="19" cy="20.5" r="1.5" /><circle cx="3.5" cy="19" r="1.5" />
  </svg>;
}
