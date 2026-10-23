import { useBank } from '../bank';
import { AgentMark } from '../AgentMark';
import { BotanicalArt, ThemeGlyph } from '../Botanical';
import { ChevronRight } from 'lucide-react';
import { IcoDrop, IcoBolt, IcoFlame, IcoPhone, IcoWifi, IcoBuilding, IcoCalendar, IcoHeadset, IcoTicket, IcoBell, IcoShield } from '../icons';
import { formValues, date, yuan } from '../api';
import { Card, Tile, Row, Field, Amount, AccountSelect, Submit, Notice, Empty, type Tone } from '../ui';

export function Life() {
  const { begin, openModal, navigate, data } = useBank();
  const bills: { id: string; title: string; icon: typeof IcoDrop; tone: Tone }[] = [{ id: 'water', title: '水费', icon: IcoDrop, tone: 'blue' }, { id: 'electricity', title: '电费', icon: IcoBolt, tone: 'orange' }, { id: 'gas', title: '燃气费', icon: IcoFlame, tone: 'red' }, { id: 'mobile', title: '手机充值', icon: IcoPhone, tone: 'blue' }, { id: 'broadband', title: '宽带费', icon: IcoWifi, tone: 'blue' }, { id: 'property', title: '物业费', icon: IcoBuilding, tone: 'gold' }];
  const recent = data.transactions.filter(t => t.type === 'payment' && t.status === 'completed');
  return <div className="page oak-page life-page satin-life">
    <header className="oak-intro"><span className="oak-eyebrow"><ThemeGlyph theme="life" size={15} />日常 · 生活服务</span><h2>让日常，轻一点。</h2><p>把琐事安顿好，留些时间给生活。</p></header>
    <section className="life-service-hero life-editorial surface-satin finish-apricot"><div className="life-story"><span className="oak-eyebrow">到店之前，先预约</span><h2>为重要的事<br />留好时间</h2><p>选择网点、日期<br />与办理业务。</p><button className="pill primary" onClick={() => navigate('appointments')}>网点预约<ChevronRight size={16} /></button></div><figure className="life-art"><BotanicalArt theme="life" /><figcaption>从容，始于妥当的安排。</figcaption></figure></section>
    <button className="life-concierge" onClick={() => navigate('assistant')} data-testid="life-assistant"><AgentMark size={22} /><span>想办理什么？和我说说<small>智能助手，帮你理清办理流程</small></span><ChevronRight size={16} /></button>
    <Card title="便民缴费" className="life-payments"><div className="life-bills">{bills.map(b => <Tile key={b.id} icon={b.icon} label={b.title} tone={b.tone} onClick={() => openModal(b.title, <form className="stack-form" onSubmit={e => { const f = formValues(e); void begin({ ...f, type: 'payment', billType: b.id }); }}><Field label={b.id === 'mobile' ? '充值手机号' : '缴费户号'}><input name="billNumber" inputMode="numeric" placeholder={b.id === 'mobile' ? '请输入11位手机号' : '请输入6至30位户号'} pattern={b.id === 'mobile' ? '1[0-9]{10}' : '[0-9A-Za-z-]{6,30}'} required /></Field><AccountSelect /><Amount label="缴费金额（元）" /><Notice>确认后从付款账户实时扣款并生成缴费记录。</Notice><Submit>下一步</Submit></form>)} />)}</div></Card>
    <Card title="最近缴费" className="life-recent" action={recent.length ? '全部' : undefined} onAction={() => navigate('transactions')}>{recent.slice(0, 5).map(t => <Row key={t.id} icon={IcoTicket} tone="gold" title={t.title} subtitle={date(t.created_at)} trailing={<b className="amount">-{yuan(t.amount)}</b>} />)}{!recent.length && <Empty title="暂无缴费记录" />}</Card>
    <Card title="更多服务" className="life-services">
      <Row icon={IcoCalendar} tone="blue" title="网点预约" subtitle="预约后凭手机号到店办理" onClick={() => navigate('appointments')} />
      <Row icon={IcoHeadset} tone="orange" title="帮助与客服" subtitle="常见问题、问题反馈" onClick={() => navigate('support')} />
      <Row icon={IcoBell} tone="coral" title="消息中心" subtitle="账户变动与业务通知" onClick={() => navigate('messages')} />
      <Row icon={IcoShield} tone="gold" title="安全中心" subtitle="密码、限额与银行卡管理" onClick={() => navigate('security')} />
    </Card>
  </div>;
}

export function Appointments() {
  const { data, mutate, openModal, closeModal } = useBank();
  const today = new Date().toISOString().slice(0, 10);
  return <div className="page">
    <form className="card form-card stack-form" onSubmit={async e => { const f = formValues(e); await mutate('/appointments', f, '预约成功'); }}>
      <Field label="选择网点"><select name="branch"><option>澄川银行 城中支行</option><option>澄川银行 滨江支行</option><option>澄川银行 科创支行</option></select></Field>
      <Field label="办理业务"><select name="service"><option>账户咨询</option><option>银行卡业务</option><option>贷款咨询</option><option>理财咨询</option></select></Field>
      <Field label="预约日期"><input type="date" name="date" min={today} max={new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10)} required /></Field>
      <Submit>确认预约</Submit>
    </form>
    <Card title="我的预约">{data.appointments.map(a => <Row key={a.id} icon={IcoCalendar} tone={a.status === 'reserved' ? 'blue' : 'gray'} title={a.branch} subtitle={`${a.date} ${a.service}`} trailing={<span className={`status ${a.status === 'reserved' ? 'completed' : 'cancelled'}`}>{a.status === 'reserved' ? '已预约' : '已取消'}</span>} onClick={a.status === 'reserved' ? () => openModal('取消预约', <div className="stack-form"><p className="body-copy">确认取消 {a.date} 在{a.branch}的{a.service}预约？</p><button className="btn-primary" onClick={async () => { if (await mutate(`/appointments/${a.id}/cancel`, {}, '预约已取消')) closeModal(); }}>确认取消</button></div>) : undefined} />)}{!data.appointments.length && <Empty title="暂无预约" />}</Card>
  </div>;
}

export function Support() {
  const { data, mutate } = useBank();
  const faq = [['转账为什么显示“待确认”？', '提交转账后资金会暂时预留。请在“交易进度”中打开该笔交易，核对收款信息并输入支付密码；15分钟未确认会自动过期并释放预留资金。'], ['演示账户的密码是什么？', '两个内置演示账户的初始登录密码均为 Bank123456，支付密码为 123456。若已修改请使用新密码，新注册用户使用注册时设置的密码。'], ['转账失败了，资金会退回吗？', '交易失败、取消或过期后，预留资金会释放，可用余额恢复。可在交易详情和交易记录中核对。'], ['理财收益和贷款利息如何计算？', '当前版本以本金交易流程为主。产品利率为模拟示例，存款和理财按本金结算，贷款只模拟本金借还。'], ['可以转到真实银行卡吗？', '不可以。全部交易仅发生在模拟数据库，跨行转账也只是模拟资金流向。']];
  return <div className="page">
    <Card title="常见问题"><div className="faq">{faq.map(([q, a]) => <details key={q}><summary>{q}</summary><p>{a}</p></details>)}</div></Card>
    <form className="card form-card stack-form" onSubmit={async e => { const el = e.currentTarget, f = formValues(e); if (await mutate('/support', f, '反馈已提交')) el.reset(); }}>
      <h2 className="card-title">问题反馈</h2>
      <Field label="问题类型"><select name="subject"><option>账户与银行卡</option><option>转账与支付</option><option>存款与理财</option><option>贷款与信用卡</option><option>其他问题</option></select></Field>
      <Field label="问题描述"><textarea name="content" rows={4} placeholder="请描述遇到的问题，可附上交易编号" required minLength={5} maxLength={2000} /></Field>
      <Submit>提交</Submit>
    </form>
    <Card title="我的反馈">{data.tickets.map(t => <Row key={t.id} icon={IcoTicket} tone="blue" title={t.subject} subtitle={`${date(t.created_at)} ${t.content}`} trailing={<span className="status pending">已提交</span>} />)}{!data.tickets.length && <Empty title="暂无反馈" />}</Card>
  </div>;
}
