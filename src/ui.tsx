import { useContext, useEffect, useId, useRef, useState, type ReactNode, type ComponentType } from 'react';
import { ChevronRight, X, Landmark, LoaderCircle, Inbox, CircleAlert } from 'lucide-react';
import { BankContext, useBank } from './bank';

export type Icon = ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
export function Brand({ light = false }: { light?: boolean }) { return <div className={`brand ${light ? 'light' : ''}`}><span className="brand-mark"><Landmark size={23} strokeWidth={2.2} /></span><span><strong>澄川银行</strong><small>CHENGCHUAN BANK</small></span></div>; }
export function Section({ title, action, onAction, children }: { title: string; action?: string; onAction?: () => void; children: ReactNode }) { return <section className="section"><div className="section-heading"><h2>{title}</h2>{action && <button className="text-button muted" onClick={onAction}>{action}<ChevronRight size={15} /></button>}</div>{children}</section>; }
export function Tile({ icon: Icon, label, onClick, tone = 'blue', id }: { icon: Icon; label: string; onClick: () => void; tone?: string; id?: string }) { return <button className={`service-tile ${tone}`} onClick={onClick} data-testid={id}><span><Icon size={25} strokeWidth={1.8} /></span><span>{label}</span></button>; }
export function Row({ icon: Icon, title, subtitle, trailing, onClick, tone = 'blue' }: { icon?: Icon; title: string; subtitle?: string; trailing?: ReactNode; onClick?: () => void; tone?: string }) {
  const content = <>{Icon && <span className={`row-icon ${tone}`}><Icon size={22} strokeWidth={1.8} /></span>}<span className="row-copy"><strong>{title}</strong>{subtitle && <small>{subtitle}</small>}</span>{trailing && <span className="row-trailing">{trailing}</span>}{onClick && <ChevronRight size={17} className="chevron" />}</>;
  return onClick ? <button className="list-row" onClick={onClick}>{content}</button> : <div className="list-row">{content}</div>;
}
export function Empty({ title = '暂时没有记录', text = '完成一笔业务后，记录会出现在这里。' }: { title?: string; text?: string }) { return <div className="empty"><Inbox size={32} strokeWidth={1.3} /><strong>{title}</strong><p>{text}</p></div>; }
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) { return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>; }
export function Amount({ defaultValue, label = '金额（元）', max, min = '0.01' }: { defaultValue?: string; label?: string; max?: string; min?: string }) { return <Field label={label}><div className="amount-input"><b>¥</b><input name="amount" aria-label={label} type="number" inputMode="decimal" min={min} max={max} step="0.01" placeholder="0.00" defaultValue={defaultValue} required /></div></Field>; }
export function AccountSelect() { const { data } = useBank(); return <Field label="交易账户"><select name="accountId" aria-label="交易账户">{data.accounts.map(a => <option key={a.id} value={a.id}>{a.name}（{a.number.slice(-4)}）· 可用 ¥{(a.available / 100).toFixed(2)}{a.status === 'frozen' ? ' · 已冻结' : ''}</option>)}</select></Field>; }
const isPinError = (code?: string) => code === 'INVALID_PIN' || code === 'RATE_LIMITED';
export function InlineError({ message, id, testId }: { message: string; id?: string; testId?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (message) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' }); }, [message]);
  if (!message) return null;
  return <div ref={ref} className="inline-error field-error" id={id} role="alert" aria-live="assertive" data-testid={testId}><CircleAlert size={18} /><span>{message}</span></div>;
}
export function PinField({ label = '支付密码' }: { label?: string }) {
  const bank = useContext(BankContext), errorId = useId(), input = useRef<HTMLInputElement>(null);
  const [inputError, setInputError] = useState('');
  const error = (isPinError(bank?.formError?.code) ? bank!.formError!.message : '') || inputError;
  useEffect(() => { if (error) { input.current?.focus({ preventScroll: true }); input.current?.select(); } }, [error]);
  return <Field label={label}><input ref={input} type="password" name="pin" aria-label={label} aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined} autoComplete="off" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} minLength={6} placeholder="请输入6位支付密码" onChange={() => { setInputError(''); bank?.clearFormError(); }} onInvalid={event => { event.preventDefault(); setInputError('支付密码须为6位数字'); }} required /><InlineError id={errorId} message={error} testId="pin-error" /></Field>;
}
export function Submit({ children, id }: { children: ReactNode; id?: string }) { const { busy } = useBank(); return <button className="primary full" type="submit" disabled={busy} data-testid={id}>{busy && <LoaderCircle size={18} className="spin" />}{children}</button>; }
export function Notice({ children }: { children: ReactNode }) { return <div className="notice">{children}</div>; }
export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const bank = useContext(BankContext);
  const error = bank?.formError && !isPinError(bank.formError.code) ? bank.formError.message : '';
  useEffect(() => { ref.current?.showModal(); const dialog = ref.current; return () => dialog?.close(); }, []);
  return <dialog ref={ref} className="modal" aria-labelledby="modal-title" onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === ref.current) onClose(); }}><div className="modal-heading"><h2 id="modal-title">{title}</h2><button aria-label="关闭弹窗" className="icon-button" onClick={onClose}><X size={22} /></button></div><div className="modal-body">{children}<InlineError message={error} testId="modal-error" /></div></dialog>;
}
