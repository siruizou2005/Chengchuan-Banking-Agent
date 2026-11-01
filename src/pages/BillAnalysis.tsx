import { CalendarDays, CarFront, ChevronRight, House, CircleEllipsis, Cloud, Eye, Info, Lightbulb, MonitorPlay, Music, ShoppingCart, Utensils, Wallet } from 'lucide-react';
import { useBank } from '../bank';
import { change, money, percent, type BillData, type BillEntry } from './billData';

export function EntryDetail({ row, masked }: { row: BillEntry; masked: boolean }) {
  return <div className="bill-detail"><strong>{money(row.amount, masked)}</strong><p>{row.title}</p><dl>
    <dt>交易日期（北京时间）</dt><dd>{row.bj_time}</dd><dt>收支分类</dt><dd>{row.tag}</dd>
    {row.merchant && <><dt>商户</dt><dd>{row.merchant}</dd></>}<dt>流水编号</dt><dd>{row.transaction_id}</dd>
  </dl></div>;
}

function Bar({ share }: { share: number }) {
  return <span className="bill-bar"><i style={{ width: percent(Math.max(0, Math.min(1, share))) }} /></span>;
}

export function HiddenAnalysis({ bill }: { bill: BillData }) {
  const { hidden: masked, data, openModal } = useBank();
  const { hidden, totals } = bill;
  const subscriptions = data.subscriptions;
  function evidence(group: typeof hidden.groups[number]) {
    const ids = new Set(group.ids);
    openModal(group.name, <div className="bill-evidence"><p>{group.rule}</p>{bill.entries.filter(r => ids.has(r.id)).map(r =>
      <details key={r.id}><summary>{r.bj_time.slice(0, 10)} · {r.title}　{money(-r.amount, masked)}</summary><EntryDetail row={r} masked={masked} /></details>)}</div>);
  }
  return <>
    <section className="bill-panel bill-summary hidden-summary"><div><Eye /><span>本月隐形消费</span><strong>{money(hidden.total, masked)}</strong><small>较上月 {change(hidden.total, bill.previous?.hidden)}</small></div>
      <div><span>占本月支出</span><strong>{totals.consumption > 0 ? percent(hidden.total / totals.consumption) : '—'}</strong></div></section>
    <section className="bill-panel"><h2>隐形消费构成</h2>
      {!hidden.total && <p className="bill-muted">{bill.entries.length ? '当期流水未命中以下规则。' : '该月暂无已入账流水。'}</p>}
      {hidden.groups.map(group => <button className="bill-group" key={group.name} disabled={!group.ids.length} onClick={() => evidence(group)}>
        <span className="bill-spread"><b>{group.name}</b><span>{money(group.amount, masked)}　<small>{hidden.total ? percent(group.amount / hidden.total) : '—'}</small></span></span>
        <small>{group.ids.length} 笔 · {group.name === '小额高频' ? '同商户多次小额消费' : '有订阅标记或周期性记录'}</small><Bar share={hidden.total ? group.amount / hidden.total : 0} />
      </button>)}</section>
    <section className="bill-panel"><h2>我的订阅与自动续费 <small>（当前 {subscriptions.length} 项）</small></h2>
      {!subscriptions.length && <p className="bill-muted">暂无已登记的订阅服务</p>}
      {subscriptions.map(s => { const Icon = /音乐/.test(s.merchant) ? Music : /云/.test(s.merchant) ? Cloud : MonitorPlay;
        const status = s.status === 'active' ? '生效中' : s.status === 'payment_failed' ? '扣款失败' : '已停止';
        return <div key={s.id} className="bill-row"><Icon /><span><b>{s.merchant}</b><small>{money(s.amount, masked)} / 月 · {status}</small></span>
          <button className="bill-outline" onClick={() => openModal('订阅详情', <div className="bill-evidence"><p>{s.merchant} · {status}</p><p>每月费用 {money(s.amount, masked)}</p>
            {s.status === 'active' && <p>下次计划扣费　{new Date(s.next_at).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })}</p>}<p>本页仅查看订阅信息。</p></div>)}>详情</button></div>; })}
    </section>
    <aside className="bill-note"><Info size={16} /><span>按已入账扣款识别，同一笔支出只计一次。周期性记录为规则识别结果。暂无服务使用记录，无法判断订阅是否闲置。</span></aside>
  </>;
}

export function PersonalizedAnalysis({ bill }: { bill: BillData }) {
  const { hidden, openModal } = useBank();
  const { categories, totals, previous } = bill;
  const top = categories.find(c => c.amount > 0);
  const weekday = bill.weekdays.slice(0, 5).reduce((n, b) => n + b.amount, 0);
  const peakHour = [...bill.hours].filter(b => b.amount > 0).sort((a, b) => b.amount - a.amount)[0];
  const frequent = [...categories].sort((a, b) => b.count - a.count)[0];
  const sharesValid = totals.consumption > 0;
  const insight = !totals.count ? '该月暂无已入账流水。' : !top ? '本期暂无可分析的正向分类支出。' :
    `本期消费以${top.name}为主${sharesValid ? '，占净消费的 ' + percent(top.share) : ''}。${previous?.totals.consumption ? '消费较上月同期 ' + change(totals.consumption, previous.totals.consumption) + '。' : '暂无可比的上月消费基数。'}`;
  return <>
    <section className="bill-panel"><button className="bill-insight" onClick={() => openModal('本月洞察依据', <p>{bill.from} 至 {bill.to}，共 {totals.count} 笔流水。消费按支出扣除退款计算，转账及本人账户互转不计入消费。</p>)}>
      <i>AI</i><span><b>AI 账单助手 · 本月洞察</b><small>{insight}</small></span><ChevronRight size={16} /></button></section>
    <section className="bill-panel"><h2>本月分类支出 <small>（对比上月）</small></h2>
      {!categories.length && <p className="bill-muted">暂无分类支出</p>}
      {categories.map(c => { const Icon = /餐饮/.test(c.name) ? Utensils : /购物|超市/.test(c.name) ? ShoppingCart : /交通/.test(c.name) ? CarFront : /住房/.test(c.name) ? House : /其他|未知/.test(c.name) ? CircleEllipsis : Wallet;
        return <div key={c.name} className="bill-category"><Icon size={21} /><div><b>{c.name}</b><Bar share={c.share} /></div>
          <span>{money(c.amount, hidden)}<small>{sharesValid ? percent(c.share) : '—'}</small></span><small>{change(c.amount, previous?.categories.find(p => p.name === c.name)?.amount)}</small></div>; })}
    </section>
    <section className="bill-panel"><h2>我的消费习惯</h2><div className="bill-notes"><CalendarDays /><ul>
      {sharesValid && <li>工作日净消费占 {percent(weekday / totals.consumption)}，周末占 {percent(1 - weekday / totals.consumption)}。</li>}
      {frequent && <li>{frequent.name}的消费与退款记录最频繁，共 {frequent.count} 笔。</li>}
      {peakHour && <li>有明确交易时刻的流水中，{peakHour.key}的净消费最高。</li>}
      {!frequent && !peakHour && <li>当前流水不足以判断消费习惯。</li>}
    </ul></div></section>
    <section className="bill-panel"><h2>可调整建议 <small>（供参考）</small></h2><div className="bill-notes"><Lightbulb /><ul>
      {top && <li>可从金额最高的「{top.name}」开始复核，为下月设定预算。</li>}
      {bill.hidden.total > 0 && <li>可在隐形消费分析中逐笔核对持续性支出，再决定是否调整。</li>}
      {!top && !bill.hidden.total && <li>该月数据不足，暂无针对性建议。</li>}
    </ul></div></section>
  </>;
}
