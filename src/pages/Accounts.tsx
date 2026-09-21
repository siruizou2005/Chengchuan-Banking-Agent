import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { ShieldCheck, Copy, Download, Search, Plus, ScanLine, Upload } from 'lucide-react';
import { useBank } from '../bank';
import { ActionCard } from '../chat/cards';
import type { AgentAction } from '../types';
import { api, yuan, tail, date, formValues, statusLabel } from '../api';
import { AccountSelect, Amount, Empty, Field, Notice, PinField, Row, Card, Submit, Brand, Pill, Tabs, Avatar, CircleIcon } from '../ui';
import { IcoIn, IcoOut, IcoSnow, IcoClock, IcoRecord, IcoQr, Logo } from '../icons';
import type { Ledger } from '../types';

export function Accounts() {
  const { data, navigate, openModal, hidden, refresh, toast } = useBank();
  async function propose(tool: string, args: Record<string, unknown>) { try { const action = await api<AgentAction>('/agent/actions', 'POST', { tool, args }); await refresh(); openModal('核对卡片操作', <ActionCard action={action} />); } catch (e) { toast((e as Error).message, true); } }
  return <div className="page">
    {data.accounts.map(a => <section className="card" key={a.id}>
      <div className={`debit-card${a.status === 'frozen' ? ' frozen' : ''}`}><span className="debit-head"><span>澄川卡</span><em>尾号 {tail(a.number)}</em>{a.status !== 'active' && <em>{a.status === 'lost' ? '已挂失' : '已冻结'}</em>}</span><strong className="debit-balance">{hidden ? '****' : yuan(a.balance)}</strong><span className="debit-caption">余额</span><span className="debit-mark" aria-hidden="true"><Logo size={150} watermark /></span></div>
      <dl className="kv">
        <div><dt>卡号</dt><dd className="mono">{a.number.replace(/(.{4})/g, '$1 ').trim()}</dd></div>
        <div><dt>可用余额</dt><dd>{hidden ? '****' : `¥${yuan(a.available)}`}</dd></div>
        <div><dt>待确认预留</dt><dd>{hidden ? '****' : `¥${yuan(a.held)}`}</dd></div>
        <div><dt>账户类型</dt><dd>Ⅰ类账户 借记卡</dd></div>
        <div><dt>持卡人</dt><dd>{data.user.name}</dd></div>
      </dl>
      <Row icon={IcoRecord} tone="blue" title="交易记录" onClick={() => navigate('ledger')} />
      <Row icon={IcoSnow} tone="coral" title={a.status === 'lost' ? '解挂银行卡' : a.status === 'active' ? '冻结银行卡' : '解冻银行卡'} subtitle="状态变更由服务端分级验证" onClick={() => void propose('propose_card_action', { card: a.id, action: a.status === 'lost' ? 'unlost' : a.status === 'active' ? 'freeze' : 'unfreeze' })} />
      {a.status !== 'lost' && <Row icon={IcoSnow} tone="red" title="挂失银行卡" subtitle="挂失后停止交易并释放待确认预留" onClick={() => void propose('propose_card_action', { card: a.id, action: 'report_lost' })} />}
    </section>)}
    <div className="pill-row"><Pill onClick={() => navigate('receive')}>收款码</Pill><Pill primary onClick={() => navigate('transfer')}>转账汇款</Pill></div>
    <Card title="虚拟卡" action="申请" onAction={() => void propose('propose_virtual_card', { limit: '1000' })}>{data.virtualCards.map(c => <Row key={c.id} title={`虚拟卡 · ${tail(c.number)}`} subtitle={`限额 ¥${yuan(c.card_limit)} · ${c.status}`} />)}{!data.virtualCards.length && <Empty title="暂无虚拟卡" />}</Card>
    <Card title="锁定与预授权资金">{data.reservations.map(r => <Row key={r.id} title={r.purpose} subtitle={`释放时间 ${date(r.until_at)}`} trailing={`¥${yuan(r.amount)}`} />)}{!data.reservations.length && <Empty title="暂无锁定资金" />}</Card>
    <Notice>演示环境账户，请勿填写真实银行卡资料。</Notice>
  </div>;
}

export function Transfer() {
  const { data, begin, navigate } = useBank();
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const [name, setName] = useState(params.get('name') || '');
  const [number, setNumber] = useState(params.get('account') || '');
  const [bank, setBank] = useState(params.get('bank') || data.payees.find(p => p.number === params.get('account'))?.bank || '澄川银行');
  return <div className="page">
    {data.payees.length > 0 && <Card title="常用收款人" action="管理" onAction={() => navigate('payees')}><div className="payee-scroll">{data.payees.map(p => <button key={p.id} className={`payee${number === p.number ? ' selected' : ''}`} onClick={() => { setName(p.name); setNumber(p.number); setBank(p.bank); }}><Avatar size={40} /><strong>{p.name}</strong><small>尾号 {tail(p.number)}</small></button>)}</div></Card>}
    <form className="card form-card stack-form" data-testid="transfer-form" onSubmit={e => { const f = formValues(e); void begin({ ...f, type: 'transfer' }); }}>
      <Field label="收款人姓名"><input name="recipientName" placeholder="请输入收款人姓名" value={name} onChange={e => setName(e.target.value)} required minLength={2} maxLength={40} /></Field>
      <Field label="收款账号"><input name="recipientAccount" inputMode="numeric" placeholder="请输入16至19位银行卡号" value={number} onChange={e => setNumber(e.target.value.replace(/\s/g, ''))} required pattern="[0-9]{16,19}" /></Field>
      <Field label="收款银行"><select name="bank" value={bank} onChange={e => setBank(e.target.value)}>{['澄川银行', '中国工商银行', '中国建设银行', '中国农业银行', '中国银行', '招商银行', '交通银行', '其他银行'].map(x => <option key={x}>{x}</option>)}</select></Field>
      <AccountSelect />
      <Amount label="转账金额（元）" />
      <Field label="附言（选填）"><input name="note" placeholder="例如：生活费、还款" maxLength={100} /></Field>
      <div className="inline-note"><ShieldCheck size={14} />手续费 0.00 元，每日限额 ¥{yuan(data.user.dailyLimit)}</div>
      <Submit id="create-transfer">下一步</Submit>
    </form>
    <Notice>提交后需输入支付密码确认，15分钟内未确认将自动释放预留资金。</Notice>
  </div>;
}

export function LedgerPage() {
  const { data, openModal } = useBank();
  const [q, setQ] = useState(''), [direction, setDirection] = useState('all'), [month, setMonth] = useState('');
  const rows = data.ledger.filter(l => (!q || l.title.includes(q) || l.transaction_id.includes(q)) && (!month || l.created_at.startsWith(month)) && (direction === 'all' || (direction === 'income' ? l.amount > 0 : l.amount < 0)));
  const income = rows.filter(l => l.amount > 0).reduce((s, l) => s + l.amount, 0), expense = -rows.filter(l => l.amount < 0).reduce((s, l) => s + l.amount, 0);
  function detail(l: Ledger) { openModal('电子回单', <div className="receipt"><span className={`receipt-icon ${l.amount > 0 ? 'income' : ''}`}>{l.amount > 0 ? <IcoIn size={28} /> : <IcoOut size={28} />}</span><h3>{l.title}</h3><div className={`receipt-amount${l.amount > 0 ? ' income' : ''}`}>{l.amount > 0 ? '+' : '-'}{yuan(Math.abs(l.amount))}</div><span className="status completed">已入账</span><dl><dt>交易编号</dt><dd className="mono">{l.transaction_id}</dd><dt>入账时间</dt><dd>{new Date(l.created_at).toLocaleString('zh-CN')}</dd><dt>交易账户</dt><dd>储蓄卡（{tail(l.number)}）</dd><dt>交易后余额</dt><dd>¥{yuan(l.balance_after)}</dd><dt>备注</dt><dd>澄川银行电子回单</dd></dl></div>); }
  return <div className="page">
    <section className="card split"><div><span>收入</span><b className="income">+{yuan(income)}</b></div><div><span>支出</span><b>-{yuan(expense)}</b></div></section>
    <div className="search-bar"><Search size={18} /><input aria-label="搜索交易" placeholder="搜索交易名称或编号" value={q} onChange={e => setQ(e.target.value)} /></div>
    <Card head={<Tabs items={[{ id: 'all', label: '全部' }, { id: 'income', label: '收入' }, { id: 'expense', label: '支出' }]} value={direction} onChange={setDirection} />} action={<input type="month" className="month-input" aria-label="筛选月份" value={month} onChange={e => setMonth(e.target.value)} />}>
      {rows.map(l => <Row key={l.id} icon={l.amount > 0 ? IcoIn : IcoOut} tone={l.amount > 0 ? 'red' : 'blue'} title={l.title} subtitle={date(l.created_at)} trailing={<b className={`amount${l.amount > 0 ? ' income' : ''}`}>{l.amount > 0 ? '+' : '-'}{yuan(Math.abs(l.amount))}</b>} trailingSub={`余额 ${yuan(l.balance_after)}`} onClick={() => detail(l)} chevron={false} />)}
      {rows.length === 0 && <Empty title="没有符合条件的交易" />}
    </Card>
    <a className="pill full" href="/api/ledger/export" download><Download size={16} />导出流水</a>
  </div>;
}

export function Transactions() {
  const { data, showTransaction } = useBank();
  const [filter, setFilter] = useState('all');
  const rows = data.transactions.filter(t => filter === 'all' || t.status === filter);
  return <div className="page">
    <Card head={<Tabs grow items={[{ id: 'all', label: '全部' }, { id: 'pending', label: '待确认' }, { id: 'completed', label: '已完成' }, { id: 'failed', label: '失败' }]} value={filter} onChange={setFilter} />}>
      {rows.map(t => <Row key={t.id} icon={t.status === 'pending' ? IcoClock : IcoRecord} tone={t.status === 'pending' ? 'orange' : t.status === 'completed' ? 'blue' : 'gray'} title={t.title} subtitle={date(t.created_at)} trailing={<b className="amount">¥{yuan(t.amount)}</b>} trailingSub={<span className={`status ${t.status}`}>{statusLabel[t.status]}</span>} onClick={() => showTransaction(t)} chevron={false} />)}
      {!rows.length && <Empty />}
    </Card>
  </div>;
}

export function Payees() {
  const { data, openModal, mutate, closeModal, navigate } = useBank();
  const add = () => openModal('添加收款人', <form className="stack-form" onSubmit={async e => { const f = formValues(e); if (await mutate('/payees', f, '收款人已保存')) closeModal(); }}><Field label="收款人姓名"><input name="name" required minLength={2} maxLength={40} placeholder="请输入姓名" /></Field><Field label="银行卡号"><input name="number" required pattern="[0-9]{16,19}" inputMode="numeric" placeholder="请输入16至19位银行卡号" /></Field><Field label="收款银行"><select name="bank">{['澄川银行', '中国工商银行', '中国建设银行', '招商银行', '其他银行'].map(b => <option key={b}>{b}</option>)}</select></Field><Submit>保存</Submit></form>);
  return <div className="page">
    <Card title="收款人" action={<><Plus size={14} />添加</>} onAction={add}>
      {data.payees.map(p => <Row key={p.id} avatar={<Avatar size={44} />} title={p.name} subtitle={`${p.bank} 尾号 ${tail(p.number)}`} action={<><Pill small primary onClick={() => navigate(`transfer?name=${encodeURIComponent(p.name)}&account=${p.number}`)}>转账</Pill><Pill small onClick={() => openModal('删除收款人', <div className="stack-form"><p className="body-copy">确认将{p.name}（尾号 {tail(p.number)}）从常用收款人中删除？</p><button className="btn-primary" onClick={async () => { if (await mutate(`/payees/${p.id}`, {}, '收款人已删除', 'DELETE')) closeModal(); }}>确认删除</button></div>)}>删除</Pill></>} />)}
      {!data.payees.length && <Empty title="暂无常用收款人" />}
    </Card>
  </div>;
}

export function Receive() {
  const { data, navigate, toast } = useBank();
  const account = data.accounts[0], [qr, setQr] = useState('');
  const url = `bank-sim://transfer?account=${account.number}&name=${encodeURIComponent(data.user.name)}`;
  useEffect(() => { void QRCode.toDataURL(url, { width: 260, margin: 2, color: { dark: '#1f2a44', light: '#ffffff' } }).then(setQr); }, [url]);
  return <div className="page">
    <section className="card receive-card"><Brand /><h2>向我转账</h2><p>{data.user.name} 储蓄卡（尾号 {tail(account.number)}）</p>{qr && <img src={qr} alt="澄川银行模拟收款二维码" width="260" height="260" />}<span className="tag gray">澄川银行专用收款码</span><p className="mono full-card-number">{account.number.replace(/(.{4})/g, '$1 ').trim()}</p><button className="btn-text" onClick={async () => { try { await navigator.clipboard.writeText(url); toast('收款链接已复制'); } catch { toast('复制失败，可长按卡号复制', true); } }}><Copy size={15} />复制收款链接</button></section>
    <div className="pill-row">{qr && <a className="pill" href={qr} download="澄川银行收款码.png"><Download size={16} />保存收款码</a>}<Pill primary onClick={() => navigate('scan')}><ScanLine size={16} />扫码付款</Pill></div>
    <Notice>该二维码仅用于澄川银行演示环境内转账，不可用于微信、支付宝或其他银行付款。</Notice>
  </div>;
}

export function Scan() {
  const { navigate, toast } = useBank();
  const [input, setInput] = useState(''), [working, setWorking] = useState(false);
  function accept(value: string) {
    try { const url = new URL(value); if (url.protocol !== 'bank-sim:' || url.hostname !== 'transfer' || !/^\d{16,19}$/.test(url.searchParams.get('account') || '') || !url.searchParams.get('name')) throw new Error(); navigate('transfer?' + url.searchParams.toString()); }
    catch { toast('无法识别，请使用澄川银行收款码或收款链接', true); }
  }
  async function readImage(file?: File) {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) return toast('请选择10MB以内的二维码图片', true);
    setWorking(true);
    try {
      const { default: jsQR } = await import('jsqr');
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas'); canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
      const context = canvas.getContext('2d')!; context.drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      const result = jsQR(pixels.data, pixels.width, pixels.height);
      if (!result) throw new Error(); accept(result.data);
    } catch { toast('未识别到清晰的二维码，请重试或粘贴收款链接', true); }
    finally { setWorking(false); }
  }
  return <div className="page">
    <section className="card scan-panel"><CircleIcon icon={IcoQr} tone="blue" size={64} glyph={30} /><h2>识别收款码</h2><p>选择收款码图片，自动填入转账信息</p><label className="btn-primary"><Upload size={18} />{working ? '识别中…' : '从相册选择'}<input type="file" accept="image/*" aria-label="上传收款码图片" className="sr-only" disabled={working} onChange={e => void readImage(e.target.files?.[0])} /></label></section>
    <form className="card form-card stack-form" onSubmit={e => { e.preventDefault(); accept(input); }}><Field label="或粘贴收款链接"><textarea name="receiveLink" value={input} onChange={e => setInput(e.target.value)} placeholder="bank-sim://transfer?..." rows={3} required /></Field><button className="btn-primary">识别收款信息</button></form>
    <Notice>图片在本地识别，不会上传。识别成功后仍需核对信息并输入支付密码。</Notice>
  </div>;
}
