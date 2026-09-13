import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { ArrowDownLeft, ArrowUpRight, ArrowLeftRight, CreditCard, Snowflake, ShieldCheck, Copy, Download, Search, Plus, UserRound, Trash2, Clock3, ScanLine, Upload, ReceiptText } from 'lucide-react';
import { useBank } from '../bank';
import { yuan, tail, date, formValues, statusLabel } from '../api';
import { AccountSelect, Amount, Empty, Field, Notice, PinField, Row, Section, Submit, Brand } from '../ui';
import type { Ledger } from '../types';

export function Accounts() {
  const { data, navigate, openModal, closeModal, mutate, hidden } = useBank();
  return <div className="page-content"><Section title="我的银行卡" action={`${data.accounts.length} 张`}>{data.accounts.map(a => <div key={a.id} className={`bank-card ${a.status === 'frozen' ? 'frozen' : ''}`}><div className="bank-card-top"><Brand light /><span className="card-type">银联 · 储蓄卡</span></div><div className="card-number">{a.number.replace(/(.{4})/g, '$1 ')}</div><div className="bank-card-bottom"><span>{data.user.name}</span><span>{a.status === 'frozen' ? '已冻结' : 'Ⅰ类账户 · 状态正常'}</span></div></div>)}</Section>
    {data.accounts.map(a => <section className="surface account-details" key={a.id}><div className="detail-pair"><span>账户余额</span><strong>{hidden ? '••••' : '¥ ' + yuan(a.balance)}</strong></div><div className="detail-pair"><span>可用余额</span><strong>{hidden ? '••••' : '¥ ' + yuan(a.available)}</strong></div><div className="detail-pair"><span>待确认交易预留</span><strong>{hidden ? '••••' : '¥ ' + yuan(a.held)}</strong></div><div className="divider" /><Row icon={ReceiptText} title="账户明细" subtitle={`尾号 ${tail(a.number)}`} onClick={() => navigate('ledger')} /><Row icon={Snowflake} title={a.status === 'active' ? '冻结银行卡' : '解冻银行卡'} subtitle="冻结后将暂停该卡的交易操作" onClick={() => openModal(a.status === 'active' ? '冻结银行卡' : '解冻银行卡', <form className="stack-form" onSubmit={async e => { const f = formValues(e); if (await mutate(`/accounts/${a.id}`, { pin: f.pin, status: a.status === 'active' ? 'frozen' : 'active' }, '银行卡状态已更新', 'PATCH')) closeModal(); }}><Notice>操作对象：尾号 {tail(a.number)} 的储蓄卡。冻结后，待确认交易也无法完成扣款。</Notice><PinField /><Submit>确认{a.status === 'active' ? '冻结' : '解冻'}</Submit></form>)} /></section>)}
    <button className="primary full" onClick={() => navigate('transfer')}>转账汇款<ArrowUpRight size={18} /></button><Notice>本地模拟账户，开户无需真实身份认证。请勿填写真实银行卡资料。</Notice></div>;
}

export function Transfer() {
  const { data, begin, navigate } = useBank();
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const [name, setName] = useState(params.get('name') || '');
  const [number, setNumber] = useState(params.get('account') || '');
  const [bank, setBank] = useState(params.get('bank') || data.payees.find(p => p.number === params.get('account'))?.bank || '澄川银行');
  return <div className="page-content"><div className="transfer-intro"><span className="large-icon"><ArrowLeftRight size={29} /></span><div><h2>转给重要的人</h2><p>行内实时到账 · 跨行模拟转账</p></div></div>
    {data.payees.length > 0 && <Section title="常用收款人" action="管理" onAction={() => navigate('payees')}><div className="payee-chips">{data.payees.map(p => <button key={p.id} className={number === p.number ? 'selected' : ''} onClick={() => { setName(p.name); setNumber(p.number); setBank(p.bank); }}><span>{p.name.slice(-1)}</span><strong>{p.name}</strong><small>尾号 {tail(p.number)}</small></button>)}</div></Section>}
    <form className="surface padded stack-form" data-testid="transfer-form" onSubmit={e => { const f = formValues(e); void begin({ ...f, type: 'transfer' }); }}><Field label="收款人姓名"><input name="recipientName" placeholder="请输入收款人姓名" value={name} onChange={e => setName(e.target.value)} required minLength={2} maxLength={40} /></Field><Field label="收款卡号"><input name="recipientAccount" inputMode="numeric" placeholder="请输入16至19位银行卡号" value={number} onChange={e => setNumber(e.target.value.replace(/\s/g, ''))} required pattern="[0-9]{16,19}" /></Field><Field label="收款银行"><select name="bank" value={bank} onChange={e => setBank(e.target.value)}>{['澄川银行', '中国工商银行', '中国建设银行', '中国农业银行', '中国银行', '招商银行', '交通银行', '其他银行'].map(x => <option key={x}>{x}</option>)}</select></Field><AccountSelect /><Amount label="转账金额（元）" /><Field label="转账附言（选填）"><input name="note" placeholder="例如：生活费、还款" maxLength={100} /></Field><div className="inline-note"><ShieldCheck size={16} />手续费 ¥0.00 · 每日限额 ¥{yuan(data.user.dailyLimit)}</div><Submit id="create-transfer">下一步，核对转账信息</Submit></form><Notice>请核对收款信息。下一步需输入支付密码确认，15分钟内未确认将自动释放预留资金。</Notice></div>;
}

export function LedgerPage() {
  const { data, openModal } = useBank();
  const [q, setQ] = useState(''), [direction, setDirection] = useState('all'), [month, setMonth] = useState('');
  const rows = data.ledger.filter(l => (!q || l.title.includes(q) || l.transaction_id.includes(q)) && (!month || l.created_at.startsWith(month)) && (direction === 'all' || (direction === 'income' ? l.amount > 0 : l.amount < 0)));
  const income = rows.filter(l => l.amount > 0).reduce((s, l) => s + l.amount, 0), expense = -rows.filter(l => l.amount < 0).reduce((s, l) => s + l.amount, 0);
  function detail(l: Ledger) { openModal('收支详情 · 电子回单', <div className="receipt"><span className={`receipt-icon ${l.amount > 0 ? 'teal' : ''}`}>{l.amount > 0 ? <ArrowDownLeft /> : <ArrowUpRight />}</span><h3>{l.title}</h3><div className="receipt-amount">{l.amount > 0 ? '+' : '−'}{yuan(Math.abs(l.amount))}</div><span className="status completed">已入账</span><dl><dt>交易编号</dt><dd className="mono">{l.transaction_id}</dd><dt>入账时间</dt><dd>{new Date(l.created_at).toLocaleString('zh-CN')}</dd><dt>交易账户</dt><dd>储蓄卡（{tail(l.number)}）</dd><dt>交易后余额</dt><dd>¥{yuan(l.balance_after)}</dd><dt>备注</dt><dd>澄川银行模拟电子回单</dd></dl></div>); }
  return <div className="page-content"><div className="statement-summary"><div><span>筛选范围内收入</span><strong className="positive">+{yuan(income)}</strong></div><div><span>筛选范围内支出</span><strong>{yuan(expense)}</strong></div></div><div className="search-bar input-search"><Search size={18} /><input aria-label="搜索收支" placeholder="搜索名称或交易编号" value={q} onChange={e => setQ(e.target.value)} /></div><div className="filter-row"><div className="segmented">{[['all', '全部'], ['income', '收入'], ['expense', '支出']].map(([v, l]) => <button key={v} className={direction === v ? 'active' : ''} onClick={() => setDirection(v)}>{l}</button>)}</div><input type="month" aria-label="筛选月份" value={month} onChange={e => setMonth(e.target.value)} /></div><div className="surface">{rows.map(l => <Row key={l.id} icon={l.amount > 0 ? ArrowDownLeft : ArrowUpRight} title={l.title} subtitle={date(l.created_at)} trailing={<strong className={`money ${l.amount > 0 ? 'positive' : ''}`}>{l.amount > 0 ? '+' : '−'}{yuan(Math.abs(l.amount))}</strong>} onClick={() => detail(l)} />)}{rows.length === 0 && <Empty title="没有符合条件的收支" text="调整搜索关键词、收支类型或月份后再试。" />}</div><a className="secondary full" href="/api/ledger/export" download><Download size={18} />导出全部账户流水</a><p className="page-footnote">页面展示最近500条流水，导出文件包含全部记录。</p></div>;
}

export function Transactions() {
  const { data, showTransaction } = useBank();
  const [filter, setFilter] = useState('all');
  const rows = data.transactions.filter(t => filter === 'all' || t.status === filter);
  return <div className="page-content"><div className="segmented full-tabs">{[['all', '全部'], ['pending', '待确认'], ['completed', '已完成'], ['failed', '失败']].map(([v, l]) => <button key={v} className={filter === v ? 'active' : ''} onClick={() => setFilter(v)}>{l}</button>)}</div><div className="surface">{rows.map(t => <Row key={t.id} icon={t.status === 'pending' ? Clock3 : ReceiptText} title={t.title} subtitle={`${date(t.created_at)} · ¥${yuan(t.amount)}`} trailing={<span className={`status ${t.status}`}>{statusLabel[t.status]}</span>} onClick={() => showTransaction(t)} />)}{!rows.length && <Empty />}</div></div>;
}

export function Payees() {
  const { data, openModal, mutate, closeModal, navigate } = useBank();
  return <div className="page-content"><button className="primary full" onClick={() => openModal('添加收款人', <form className="stack-form" onSubmit={async e => { const f = formValues(e); if (await mutate('/payees', f, '收款人已保存')) closeModal(); }}><Field label="收款人姓名"><input name="name" required minLength={2} maxLength={40} /></Field><Field label="银行卡号"><input name="number" required pattern="[0-9]{16,19}" inputMode="numeric" /></Field><Field label="收款银行"><select name="bank">{['澄川银行', '中国工商银行', '中国建设银行', '招商银行', '其他银行'].map(b => <option key={b}>{b}</option>)}</select></Field><Submit>保存收款人</Submit></form>)}><Plus size={18} />添加收款人</button><div className="surface">{data.payees.map(p => <div className="payee-row" key={p.id}><Row icon={UserRound} title={p.name} subtitle={`${p.bank} · 尾号 ${tail(p.number)}`} onClick={() => navigate(`transfer?name=${encodeURIComponent(p.name)}&account=${p.number}`)} /><button className="icon-button danger" aria-label={`删除收款人${p.name}`} onClick={() => openModal('移除收款人', <div className="stack-form"><p>确认将{p.name}（尾号{tail(p.number)}）从常用收款人中移除？</p><button className="primary full" onClick={async () => { if (await mutate(`/payees/${p.id}`, {}, '收款人已移除', 'DELETE')) closeModal(); }}>确认移除</button></div>)}><Trash2 size={18} /></button></div>)}{!data.payees.length && <Empty title="还没有常用收款人" text="添加后，下次转账可直接选择。" />}</div></div>;
}

export function Receive() {
  const { data, navigate, toast } = useBank();
  const account = data.accounts[0], [qr, setQr] = useState('');
  const url = `bank-sim://transfer?account=${account.number}&name=${encodeURIComponent(data.user.name)}`;
  useEffect(() => { void QRCode.toDataURL(url, { width: 260, margin: 2, color: { dark: '#113981', light: '#ffffff' } }).then(setQr); }, [url]);
  return <div className="page-content"><div className="receive-card"><Brand /><h2>扫一扫，向我转账</h2><p>{data.user.name} · 储蓄卡（{tail(account.number)}）</p>{qr && <img src={qr} alt="澄川银行模拟收款二维码" width="260" height="260" />}<span className="status completed">仅支持澄川银行模拟环境</span><div className="divider" /><p className="mono full-card-number">{account.number}</p><button className="text-button" onClick={async () => { try { await navigator.clipboard.writeText(url); toast('模拟收款链接已复制'); } catch { toast('复制失败，可长按选中卡号复制', true); } }}><Copy size={16} />复制收款链接</button></div>{qr && <a className="secondary full" href={qr} download="澄川银行收款码.png"><Download size={18} />保存收款码</a>}<button className="primary full" onClick={() => navigate('scan')}><ScanLine size={18} />识别他人收款码</button><Notice>这是模拟银行专用二维码，不可用于微信、支付宝或真实银行付款。</Notice></div>;
}

export function Scan() {
  const { navigate, toast } = useBank();
  const [input, setInput] = useState(''), [working, setWorking] = useState(false);
  function accept(value: string) {
    try { const url = new URL(value); if (url.protocol !== 'bank-sim:' || url.hostname !== 'transfer' || !/^\d{16,19}$/.test(url.searchParams.get('account') || '') || !url.searchParams.get('name')) throw new Error(); navigate('transfer?' + url.searchParams.toString()); }
    catch { toast('无法识别，请使用澄川银行模拟收款码或收款链接', true); }
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
    } catch { toast('图片中未识别到清晰的二维码，请重试或粘贴收款链接', true); }
    finally { setWorking(false); }
  }
  return <div className="page-content"><div className="scan-panel"><ScanLine size={78} strokeWidth={1} /><h2>识别模拟收款码</h2><p>选择收款码图片，自动填入转账信息</p><label className="primary"><Upload size={18} />{working ? '识别中…' : '从相册选择'}<input type="file" accept="image/*" aria-label="上传收款码图片" className="sr-only" disabled={working} onChange={e => void readImage(e.target.files?.[0])} /></label></div><form className="surface padded stack-form" onSubmit={e => { e.preventDefault(); accept(input); }}><Field label="或粘贴模拟收款链接"><textarea name="receiveLink" value={input} onChange={e => setInput(e.target.value)} placeholder="bank-sim://transfer?..." rows={3} required /></Field><button className="primary full">识别收款信息</button></form><Notice>选择图片后进行本地识别，不上传图片。识别成功后仍需核对信息并输入支付密码。</Notice></div>;
}
