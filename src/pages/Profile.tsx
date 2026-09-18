import { useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { useBank } from '../bank';
import { IcoWallet, IcoShield, IcoBell, IcoPerson, IcoRecord, IcoHeadset, IcoCode, IcoLock, IcoSliders, IcoKeypad, IcoDoc, IcoActivity, IcoTerminal, IcoTransfer, IcoHelp, IcoClock } from '../icons';
import { api, date, formValues, yuan } from '../api';
import { Card, Row, Empty, Field, PinField, Submit, Notice, Amount, AccountSelect, Avatar, CircleIcon } from '../ui';

export function Profile() {
  const { data, navigate, logout, openModal, closeModal } = useBank();
  const unread = data.notifications.filter(n => !n.is_read).length;
  return <div className="page">
    <section className="card profile-card"><Avatar size={56} /><div className="profile-text"><strong>{data.user.name}</strong><small>{data.user.phone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2')}</small></div><em className="tag gray">Ⅰ类账户</em></section>
    <section className="card stats"><button onClick={() => navigate('accounts')}><strong>{data.accounts.length}</strong><span>银行卡</span></button><button onClick={() => navigate('wealth')}><strong>{data.holdings.length}</strong><span>持有产品</span></button><button onClick={() => navigate('messages')}><strong>{unread}</strong><span>未读消息</span></button></section>
    <Card>
      <Row icon={IcoWallet} tone="blue" title="银行卡" onClick={() => navigate('accounts')} />
      <Row icon={IcoRecord} tone="coral" title="交易进度" subtitle="待确认、已完成与失败的交易" onClick={() => navigate('transactions')} />
      <Row icon={IcoPerson} tone="orange" title="收款人管理" onClick={() => navigate('payees')} />
      <Row icon={IcoBell} tone="red" title="消息中心" trailing={unread > 0 ? <em className="badge">{unread}</em> : undefined} onClick={() => navigate('messages')} />
    </Card>
    <Card>
      <Row icon={IcoShield} tone="blue" title="安全中心" subtitle="登录密码、支付密码、转账限额" onClick={() => navigate('security')} />
      <Row icon={IcoHeadset} tone="gold" title="帮助与客服" onClick={() => navigate('support')} />
      <Row icon={IcoCode} tone="coral" title="开发者中心" subtitle="API、能力清单与操作记录" onClick={() => navigate('agent')} />
      <Row icon={IcoHelp} tone="gray" title="关于澄川银行" trailing={<span className="muted">v1.0.0</span>} onClick={() => openModal('关于澄川银行', <div className="stack-form"><p className="body-copy">澄川银行是面向银行业务体验与 Agent 开发的中文手机银行模拟环境，使用虚拟账户、虚拟资金和可追踪的业务状态。</p><Notice>本项目不是持牌银行，不接入真实支付、短信、征信或金融产品服务。</Notice><button className="pill full" onClick={closeModal}>我知道了</button></div>)} />
    </Card>
    <button className="card cell-button" onClick={logout}>退出登录</button>
    <p className="footnote">澄川银行 v1.0.0</p>
  </div>;
}

export function Security() {
  const { data, openModal, closeModal, mutate, navigate } = useBank();
  const edit = (kind: string) => openModal({ limit: '每日转账限额', password: '修改登录密码', pin: '修改支付密码' }[kind]!, <form className="stack-form" onSubmit={async e => { const f = formValues(e); if (await mutate('/settings', f, '设置已更新', 'PATCH')) closeModal(); }}>{kind === 'limit' && <Field label="每日转账限额（元）" hint="最高 500,000 元，按 UTC 日期统计"><input name="dailyLimit" type="number" min="0.01" step="0.01" max="500000" defaultValue={data.user.dailyLimit / 100} required /></Field>}{kind === 'password' && <><Field label="原登录密码"><input name="oldPassword" type="password" autoComplete="current-password" required /></Field><Field label="新登录密码" hint="8至72位，须包含字母和数字"><input name="newPassword" type="password" autoComplete="new-password" minLength={8} maxLength={72} required /></Field></>}{kind === 'pin' && <Field label="新支付密码"><input name="newPin" type="password" inputMode="numeric" autoComplete="new-password" pattern="[0-9]{6}" maxLength={6} required /></Field>}<PinField label={kind === 'pin' ? '原支付密码' : '支付密码'} /><Submit>确认修改</Submit></form>);
  return <div className="page">
    <section className="card split"><div><CircleIcon icon={IcoShield} tone="blue" size={30} glyph={16} /><span>支付验证</span><b>已开启</b></div><div><CircleIcon icon={IcoClock} tone="orange" size={30} glyph={16} /><span>会话有效期</span><b>24小时</b></div></section>
    <Card title="密码与验证">
      <Row icon={IcoLock} tone="blue" title="登录密码" subtitle="修改后其他设备需重新登录" onClick={() => edit('password')} />
      <Row icon={IcoKeypad} tone="coral" title="支付密码" subtitle="资金操作前验证6位数字密码" onClick={() => edit('pin')} />
    </Card>
    <Card title="交易保护">
      <Row icon={IcoSliders} tone="orange" title="每日转账限额" trailing={<b className="amount">¥{yuan(data.user.dailyLimit)}</b>} onClick={() => edit('limit')} />
      <Row icon={IcoWallet} tone="coral" title="银行卡冻结与解冻" onClick={() => navigate('accounts')} />
      <Row icon={IcoActivity} tone="gold" title="操作记录" onClick={() => navigate('agent')} />
    </Card>
    <Notice>连续8次密码验证失败后，该验证入口暂停15分钟。修改密码时不会将原始密码写入操作日志。</Notice>
  </div>;
}

export function Messages() {
  const { data, mutate } = useBank();
  return <div className="page">
    <Card title="账户通知" action="全部已读" onAction={() => void mutate('/notifications/read', {}, '全部消息已读')}>
      {data.notifications.map(n => <article className={`message${n.is_read ? ' read' : ''}`} key={n.id}><CircleIcon icon={IcoBell} tone={n.is_read ? 'gray' : 'blue'} size={40} glyph={20} /><div><h3>{n.title}{!n.is_read && <i className="dot" />}</h3><p>{n.body}</p><small>{date(n.created_at)}</small></div></article>)}
      {!data.notifications.length && <Empty title="暂无消息" />}
    </Card>
  </div>;
}

type AuditRow = { id: number; action: string; resource_id: string; created_at: string; detail: Record<string, unknown> };
export function AgentCenter() {
  const { data, openModal, begin } = useBank();
  const [logs, setLogs] = useState<AuditRow[]>([]), [error, setError] = useState('');
  useEffect(() => { api<AuditRow[]>('/audit').then(setLogs).catch(e => setError(e.message)); }, [data]);
  const link = (href: string, icon: typeof IcoDoc, title: string) => <a className="row" href={href} target="_blank" rel="noreferrer"><CircleIcon icon={icon} tone="blue" size={44} glyph={22} /><span className="row-body"><span className="row-line"><strong className="row-title">{title}</strong></span><span className="row-line row-sub"><small className="row-subtitle mono">{href}</small></span></span><ChevronRight size={18} className="chevron" /></a>;
  return <div className="page">
    <section className="card stats"><div><strong>{data.transactions.length}</strong><span>最近交易</span></div><div><strong>{logs.length}</strong><span>最近操作</span></div><div><strong>SQLite</strong><span>持久化存储</span></div></section>
    <Card title="接口与能力">{link('/api/openapi.json', IcoDoc, 'OpenAPI 接口定义')}{link('/api/agent/manifest', IcoTerminal, 'Agent 能力清单')}</Card>
    <Card title="交易流程"><div className="flow-steps"><span>创建交易</span><ChevronRight size={14} /><span>核对确认</span><ChevronRight size={14} /><span>查询结果</span></div><p className="body-copy">网页操作与 API 共用业务状态和数据库。创建时传入 Idempotency-Key，金额输入使用“元”字符串，返回值使用整数“分”。待确认交易预留资金，15分钟自动过期；确认时校验支付密码。</p><pre className="code-snippet">POST /api/transactions{'\n'}POST /api/transactions/:id/confirm{'\n'}GET  /api/transactions/:id</pre></Card>
    <Card title="模拟异常场景"><Row icon={IcoTransfer} tone="red" title="模拟跨行转账失败" subtitle="验证失败状态与预留资金释放" onClick={() => openModal('模拟收款行拒绝', <form className="stack-form" onSubmit={e => { const f = formValues(e); void begin({ ...f, type: 'transfer', recipientName: '模拟收款人', recipientAccount: '6222000000000012345', bank: '其他银行', scenario: 'bank_rejected' }); }}><Notice>向虚构的外部收款账户发起转账。确认后收款行将模拟拒绝入账，交易标记为失败并释放预留资金。</Notice><AccountSelect /><Amount defaultValue="100.00" /><Submit>创建失败场景交易</Submit></form>)} /></Card>
    <Card title="操作记录"><div className="audit-list">{error && <Notice>{error}</Notice>}{logs.slice(0, 30).map(l => <div className="audit-row" key={l.id}><span className="audit-point" /><div><strong>{l.action}</strong><small>{date(l.created_at)}</small>{l.resource_id && <code>{l.resource_id}</code>}</div></div>)}{!logs.length && !error && <Empty />}</div></Card>
    <Notice>仅展示当前用户的操作记录，不提供跨用户访问或真实银行连接。</Notice>
  </div>;
}
