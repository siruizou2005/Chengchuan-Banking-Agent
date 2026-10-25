import { createContext, useContext, useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

// Existing dialogs can render in document flow without duplicating their forms,
// authorization logic, or API calls. Only the home workspace opts into this.
export const InlinePresentation = createContext(false);
export const useInlinePresentation = () => useContext(InlinePresentation);
export function InlineSurface({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const id = useId(), heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }, []);
  return <section className="inline-surface" aria-labelledby={id}>
    <header><h3 id={id} ref={heading} tabIndex={-1}>{title}</h3><button className="icon-button" aria-label={`关闭${title}`} onClick={onClose}><X size={19} /></button></header>
    <div className="inline-surface-body">{children}</div>
  </section>;
}
