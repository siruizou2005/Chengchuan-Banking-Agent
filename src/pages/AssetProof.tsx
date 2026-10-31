import { useState } from 'react';
import { Eye, EyeOff, Printer } from 'lucide-react';
import { yuan, tail } from '../api';
import { useBank } from '../bank';

const maskName = (name: string) => name.length <= 1 ? name : `${name[0]}${'*'.repeat(name.length - 1)}`;
const beijingNow = () => new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });

// A summary for reading on screen or printing. The watermark and notice state plainly that it proves nothing.
export function AssetProof() {
  const { data, hidden, toggleHidden } = useBank();
  const [issuedAt] = useState(beijingNow);
  const mask = (n: number) => hidden ? '******' : `¥${yuan(n)}`;
  const gain = (n: number) => hidden ? '******' : `${n < 0 ? '-' : ''}¥${yuan(Math.abs(n))}`;
  const accounts = data.accounts.filter(a => a.type !== 'system'), balance = accounts.reduce((s, a) => s + a.balance, 0), holdings = data.holdings.reduce((s, h) => s + h.value, 0);
  return <div className="page asset-proof-page">
    <section className="card asset-proof" data-testid="asset-proof">
      <div className="asset-proof-mark" aria-hidden="true">{Array.from({ length: 12 }, (_, i) => <span key={i}>模拟环境 · 不具证明效力</span>)}</div>
      <header><h2>资产证明</h2><p>澄川银行 · 模拟演示环境</p></header>
      <dl className="asset-proof-meta"><div><dt>户名</dt><dd>{maskName(data.user.name)}</dd></div><div><dt>截止时间</dt><dd>{issuedAt}</dd></div></dl>
      <h3>储蓄账户</h3>
      <div className="asset-proof-list">{accounts.map(a => <div key={a.id}><span>{a.name}（尾号 {tail(a.number)}）</span><b>{mask(a.balance)}</b></div>)}</div>
      <h3>理财与存款</h3>
      <div className="asset-proof-list">{data.holdings.map(h => <div key={h.id}><span>{h.product.name}<small>本金 {mask(h.principal)} · 累计收益 {gain(h.earnings)}</small></span><b>{mask(h.value)}</b></div>)}{!data.holdings.length && <div><span>暂无持有产品</span><b>{mask(0)}</b></div>}</div>
      <div className="asset-proof-total"><span>资产合计</span><strong data-testid="asset-proof-total">{mask(balance + holdings)}</strong></div>
      <p className="asset-proof-note">本页由模拟系统生成，所有资金和产品均为虚拟数据，不具有任何证明效力，不能用于签证、贷款或其他真实用途。</p>
    </section>
    <div className="asset-proof-actions"><button className="pill" onClick={toggleHidden}>{hidden ? <EyeOff size={16} /> : <Eye size={16} />}{hidden ? '显示金额' : '隐藏金额'}</button><button className="pill primary" onClick={() => window.print()}><Printer size={16} />打印</button></div>
  </div>;
}
