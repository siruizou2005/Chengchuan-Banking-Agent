/** One supplied Agent identity across home, chat, plans, and navigation. */
export function AgentMark({ size = 26, className = '', active = false }: { size?: number; className?: string; active?: boolean }) {
  return <img src="/chengchuan/agent-orb.png" width={size} height={size} alt="" aria-hidden="true" draggable={false} className={`agent-mark${active ? ' active' : ''} ${className}`} />;
}
