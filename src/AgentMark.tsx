import { MARK } from './icons';
/** One Agent identity across home, chat, plans and cards: the brand logo on a brand-blue gradient. */
export function AgentMark({ size = 26, className = '' }: { size?: number; className?: string }) {
  return <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className={`agent-mark ${className}`}><rect width="32" height="32" rx="9" fill="url(#cc-agent)" /><g stroke="#fff" strokeWidth="3.2" strokeLinecap="round" fill="none">{MARK.map(d => <path key={d} d={d} />)}</g></svg>;
}
