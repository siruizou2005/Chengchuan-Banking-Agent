import { useContext, useEffect, useId, useRef, useState, type ReactNode, type ComponentType } from 'react';
import { ChevronRight, X, LoaderCircle, CircleAlert } from 'lucide-react';
import { BankContext, useBank } from './bank';
import { Logo } from './icons';
import { ThemeGlyph } from './Botanical';
import { InlineSurface, useInlinePresentation } from './InlineSurface';

export type Icon = ComponentType<{ size?: number; className?: string }>;
export type Tone = 'blue' | 'cyan' | 'coral' | 'red' | 'orange' | 'green' | 'purple' | 'gold' | 'gray';
export type Material = 'matte' | 'satin' | 'signature';
/* 宫格轮换只用五个常用色系，避免彩虹感。 */
export const tones: Tone[] = ['blue', 'orange', 'coral', 'red', 'gold'];

/* 品牌：方形水纹标 + 行名，可附带副标题（登录页“手机银行”）。 */
export function Brand({ light = false, sub, size = 28, mark = true }: { light?: boolean; sub?: string; size?: number; mark?: boolean }) {
  return <div className={`brand${light ? ' light' : ''}`}>{mark && <Logo size={size} light={light} />}<span className="brand-name">澄川银行</span>{sub && <><i className="brand-sep" /><span className="brand-sub">{sub}</span></>}</div>;
}

/* 默认头像：人形剪影。 */
export function Avatar({ size = 44 }: { name?: string; size?: number }) {
  const g = Math.round(size * 0.58);
  return <span className="avatar" style={{ width: size, height: size }} aria-hidden="true"><svg width={g} height={g} viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="8.5" r="4.3" /><path d="M3.5 21c0-4.6 3.8-7.2 8.5-7.2s8.5 2.6 8.5 7.2z" /></svg></span>;
}

/* 渐变圆图标：可放面性图标，或放一个汉字（如“存”“贷”）。 */
export function CircleIcon({ icon: I, text, tone = 'blue', size = 44, glyph = 22 }: { icon?: Icon; text?: string; tone?: Tone; size?: number; glyph?: number }) {
  return <span className={`circle-icon ${tone}${text ? ' text' : ''}`} style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}>{text ?? (I && <I size={glyph} />)}</span>;
}

/* 白卡：标题下带蓝色短横条，右侧可放“全部 >”。也可用 head 传入 Tabs。 */
export function Card({ title, action, onAction, children, className = '', head, testId, material }: { title?: string; action?: ReactNode; onAction?: () => void; children: ReactNode; className?: string; head?: ReactNode; testId?: string; material?: Material }) {
  return <section className={`card ${className}${material ? ` surface-${material}` : ''}`} data-testid={testId}>{(title || head || action) && <header className="card-head">{head ?? <h2 className="card-title"><span className="card-theme-icon"><ThemeGlyph size={19} /></span>{title}</h2>}{action && (onAction ? <button className="card-action" onClick={onAction}>{action}<ChevronRight size={16} /></button> : <span className="card-action">{action}</span>)}</header>}{children}</section>;
}

/* 下划线 tab：激活项加粗放大，下方蓝色横条。 */
export function Tabs({ items, value, onChange, grow = false }: { items: { id: string; label: string }[]; value: string; onChange: (id: string) => void; grow?: boolean }) {
  return <div className={`tabs${grow ? ' grow' : ''}`} role="tablist">{items.map(t => <button key={t.id} role="tab" aria-selected={t.id === value} className={`tab${t.id === value ? ' active' : ''}`} onClick={() => onChange(t.id)}>{t.label}</button>)}</div>;
}

/* 入口方块：header 变体用于蓝底头部（白方块彩色图标），flat 变体为无底色平面渐变图标（功能宫格），circle 变体为渐变圆（分类入口）。 */
export function Tile({ icon: I, label, onClick, variant = 'flat', tone = 'blue', id, badge }: { icon: Icon; label: string; onClick: () => void; variant?: 'header' | 'circle' | 'flat'; tone?: Tone; id?: string; badge?: string }) {
  const glyph = variant === 'header' ? <span className={`tile-square ${tone}`}><I size={24} /></span> : variant === 'flat' ? <span className={`tile-flat ${tone}`}><I size={40} /></span> : <CircleIcon icon={I} tone={tone} size={46} glyph={24} />;
  return <button className={`tile ${variant}`} onClick={onClick} data-testid={id}>{glyph}{badge && <em className="tile-badge">{badge}</em>}<span className="tile-label">{label}</span></button>;
}

/* 列表行：左图标，标题/副标题，右侧金额与小字，可选胶囊操作。带 action 时整行不可点击，避免按钮嵌套。 */
export function Row({ icon: I, glyph, tone = 'blue', title, subtitle, trailing, trailingSub, action, onClick, avatar, chevron = true, testId }: { icon?: Icon; glyph?: string; tone?: Tone; title: ReactNode; subtitle?: ReactNode; trailing?: ReactNode; trailingSub?: ReactNode; action?: ReactNode; onClick?: () => void; avatar?: ReactNode; chevron?: boolean; testId?: string }) {
  const content = <>
    {avatar ?? ((I || glyph) && <CircleIcon icon={I} text={glyph} tone={tone} size={44} glyph={22} />)}
    <span className="row-body">
      <span className="row-line"><strong className="row-title">{title}</strong>{trailing !== undefined && <span className="row-trailing">{trailing}</span>}</span>
      {(subtitle || trailingSub) && <span className="row-line row-sub">{subtitle ? <small className="row-subtitle">{subtitle}</small> : <span />}{trailingSub && <span className="row-trailing-sub">{trailingSub}</span>}</span>}
      {action && <span className="row-action">{action}</span>}
    </span>
    {onClick && !action && chevron && <ChevronRight size={18} className="chevron" />}
  </>;
  return onClick && !action ? <button className="row" onClick={onClick} data-testid={testId}>{content}</button> : <div className="row" data-testid={testId}>{content}</div>;
}

export function Pill({ children, primary = false, small = false, onClick, type = 'button', disabled, id, className = '' }: { children: ReactNode; primary?: boolean; small?: boolean; onClick?: () => void; type?: 'button' | 'submit'; disabled?: boolean; id?: string; className?: string }) {
  return <button type={type} className={`pill${primary ? ' primary' : ''}${small ? ' small' : ''} ${className}`} onClick={onClick} disabled={disabled} data-testid={id}>{children}</button>;
}

/* 红色大号利率。 */
export function Rate({ value, caption, size = 'lg' }: { value: number | string | null; caption: string; size?: 'lg' | 'md' | 'xl' }) {
  if (value === null) return <span className={`rate ${size} muted`}><strong>--</strong><span>{caption}</span></span>;
  return <span className={`rate ${size}${typeof value === 'number' && value < 0 ? ' down' : ''}`}><strong>{typeof value === 'number' ? value.toFixed(2) : value}<small>%</small></strong><span>{caption}</span></span>;
}

/* 推广卡：浅蓝渐变，标题 + 利率 + 胶囊按钮。 */
export function Promo({ title, subtitle, rate, caption, action, onClick, note }: { title: string; subtitle?: string; rate: number | null; caption: string; action: string; onClick: () => void; note?: string }) {
  return <button className="promo" onClick={onClick}><span className="promo-title">{title}</span>{subtitle && <span className="promo-sub">{subtitle}</span>}<span className="promo-foot"><Rate value={rate} caption={caption} /><span className="pill primary small">{action}</span></span>{note && <span className="promo-note">{note}</span>}</button>;
}

export function Empty({ title = '暂无记录', text }: { title?: string; text?: string }) { return <div className="empty"><span className="empty-botanical"><ThemeGlyph size={30} /></span><strong>{title}</strong>{text && <p>{text}</p>}</div>; }

/* 表单 cell：标签在上、输入在下，行间细分隔线。 */
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) { return <label className="field"><span className="field-label">{label}</span>{children}{hint && <small className="field-hint">{hint}</small>}</label>; }
export function Amount({ defaultValue, label = '金额（元）', max, min = '0.01' }: { defaultValue?: string; label?: string; max?: string; min?: string }) { return <Field label={label}><div className="amount-input"><b>¥</b><input name="amount" aria-label={label} type="number" inputMode="decimal" min={min} max={max} step="0.01" placeholder="0.00" defaultValue={defaultValue} required /></div></Field>; }
export function AccountSelect() { const { data } = useBank(); return <Field label="付款账户"><select name="accountId" aria-label="付款账户">{data.accounts.map(a => <option key={a.id} value={a.id}>{a.name}（{a.number.slice(-4)}）可用 ¥{(a.available / 100).toFixed(2)}{a.status === 'frozen' ? ' 已冻结' : ''}</option>)}</select></Field>; }
const isPinError = (code?: string) => code === 'INVALID_PIN' || code === 'RATE_LIMITED';
export function InlineError({ message, id, testId }: { message: string; id?: string; testId?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (message) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' }); }, [message]);
  if (!message) return null;
  return <div ref={ref} className="inline-error" id={id} role="alert" aria-live="assertive" data-testid={testId}><CircleAlert size={16} /><span>{message}</span></div>;
}
export function PinField({ label = '支付密码' }: { label?: string }) {
  const bank = useContext(BankContext), errorId = useId(), input = useRef<HTMLInputElement>(null);
  const [inputError, setInputError] = useState('');
  const error = (isPinError(bank?.formError?.code) ? bank!.formError!.message : '') || inputError;
  useEffect(() => { if (error) { input.current?.focus({ preventScroll: true }); input.current?.select(); } }, [error]);
  return <Field label={label}><input ref={input} type="password" name="pin" aria-label={label} aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined} autoComplete="off" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} minLength={6} placeholder="请输入6位支付密码" onChange={() => { setInputError(''); bank?.clearFormError(); }} onInvalid={event => { event.preventDefault(); setInputError('支付密码须为6位数字'); }} required /><InlineError id={errorId} message={error} testId="pin-error" /></Field>;
}
export function Submit({ children, id }: { children: ReactNode; id?: string }) { const { busy } = useBank(); return <button className="btn-primary" type="submit" disabled={busy} data-testid={id}>{busy && <LoaderCircle size={18} className="spin" />}{children}</button>; }
export function Notice({ children }: { children: ReactNode }) { return <div className="notice">{children}</div>; }
export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const inline = useInlinePresentation(), titleId = useId();
  const bank = useContext(BankContext);
  const error = bank?.formError && !isPinError(bank.formError.code) ? bank.formError.message : '';
  useEffect(() => { if (!inline) ref.current?.showModal(); const dialog = ref.current; return () => dialog?.close(); }, [inline]);
  if (inline) return <InlineSurface title={title} onClose={onClose}>{children}<InlineError message={error} testId="modal-error" /></InlineSurface>;
  return <dialog ref={ref} className="modal" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === ref.current) onClose(); }}><div className="modal-heading"><h2 id={titleId}>{title}</h2><button aria-label="关闭" className="icon-button modal-close" onClick={onClose}><X size={22} /></button></div><div className="modal-body">{children}<InlineError message={error} testId="modal-error" /></div></dialog>;
}
