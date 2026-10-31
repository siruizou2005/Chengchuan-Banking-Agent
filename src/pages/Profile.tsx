import { useEffect, useState } from 'react';
import { BotanicalArt } from '../Botanical';
import { ChevronRight } from 'lucide-react';
import { useBank } from '../bank';
import { IcoWallet, IcoShield, IcoBell, IcoPerson, IcoRecord, IcoHeadset, IcoCode, IcoLock, IcoSliders, IcoKeypad, IcoDoc, IcoActivity, IcoTerminal, IcoTransfer, IcoHelp, IcoClock } from '../icons';
import { Markdown } from '../chat/Markdown';
import { DecisionTrace } from '../chat/cards';
import type { AgentRun } from '../types';
import { api, date, formValues, yuan } from '../api';
import { Card, Row, Empty, Field, PinField, Submit, Notice, Amount, AccountSelect, UserAvatar, CircleIcon, InlineError } from '../ui';

export function Profile() {
  const { data, navigate, logout, openModal, closeModal } = useBank();
  const unread = data.notifications.filter(n => !n.is_read).length;
  return <div className="page oak-page profile-page satin-profile">
    <section className="card profile-card"><span className="profile-identity-art"><BotanicalArt theme="profile" /><UserAvatar size={34} /></span><div className="profile-text"><span className="profile-kicker">树心 · 个人空间</span><strong>{data.user.name}</strong><small>{data.user.phone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2')}{data.user.email ? ` · ${data.user.email}` : ''}</small></div></section>
    <Card title="安全与授权" className="profile-settings" material="matte">
      <Row icon={IcoShield} tone="green" title="安全中心" subtitle="密码、验证与转账限额" onClick={() => navigate('security')} />
      <Row icon={IcoSliders} tone="orange" title="个性化与记忆" subtitle="回答偏好、长期记忆与候选确认" onClick={() => navigate('personalization')} />
      <Row icon={IcoBell} tone="gray" title="消息渠道绑定" subtitle="管理飞书、微信绑定与渠道设置" onClick={() => navigate('channels')} />
      <Row icon={IcoClock} tone="gray" title="智能助手操作与计划" subtitle="查看操作、确认请求与执行状态" onClick={() => navigate('tasks')} />
    </Card>
    <Card title="账户与消息" className="profile-settings" material="matte">
      <Row icon={IcoWallet} tone="blue" title="银行卡" onClick={() => navigate('accounts')} />
      <Row icon={IcoWallet} tone="gray" title="持有产品" trailing={`${data.holdings.length} 笔`} onClick={() => navigate('wealth')} />
      <Row icon={IcoRecord} tone="coral" title="交易进度" subtitle="待确认、已完成与失败的交易" onClick={() => navigate('transactions')} />
      <Row icon={IcoPerson} tone="orange" title="收款人管理" onClick={() => navigate('payees')} />
      <Row icon={IcoBell} tone="red" title="消息中心" trailing={unread > 0 ? <em className="badge">{unread}</em> : undefined} onClick={() => navigate('messages')} />
    </Card>
    <Card title="帮助与其他" className="profile-settings" material="matte">
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
  const edit = (kind: string) => openModal({ limit: '每日转账限额', password: '修改登录密码', pin: '修改支付密码' }[kind]!, <form className="stack-form" onSubmit={async e => { const f = formValues(e); if (await mutate('/settings', f, '设置已更新', 'PATCH')) closeModal(); }}>{kind === 'limit' && <Field label="每日转账限额（元）" hint="最高 500,000 元，按 UTC 日期统计"><input name="dailyLimit" type="number" min="0.01" step="0.01" max="500000" defaultValue={data.user.dailyLimit / 100} required /></Field>}{kind === 'password' && <><Field label="原登录密码"><input name="oldPassword" type="password" autoComplete="current-password" required /></Field><Field label="新登录密码" hint="8至72位，须包含字母和数字"><input name="newPassword" type="password" autoComplete="new-password" minLength={8} maxLength={72} required /></Field></>}{kind === 'pin' && <Field label="新支付密码"><input name="newPin" type="password" inputMode="numeric" autoComplete="new-password" pattern="[0-9]{6}" maxLength={6} required /></Field>}<Notice>下一步核对操作，高风险修改需完成人脸模拟、模拟手机验证码和支付密码验证。</Notice><Submit>下一步</Submit></form>);
  return <div className="page">
    <section className="card split"><div><CircleIcon icon={IcoShield} tone="blue" size={30} glyph={16} /><span>支付验证</span><b>已开启</b></div><div><CircleIcon icon={IcoClock} tone="orange" size={30} glyph={16} /><span>会话有效期</span><b>24小时</b></div></section>
    <Card title="密码与验证">
      <Row icon={IcoLock} tone="blue" title="登录密码" subtitle="修改后其他设备需重新登录" onClick={() => edit('password')} />
      <Row icon={IcoKeypad} tone="coral" title="支付密码" subtitle="资金操作前验证6位数字密码" onClick={() => edit('pin')} />
    </Card>
    <Card title="智能助手安全">
      <Row icon={IcoActivity} tone="blue" title="智能助手服务" subtitle={data.agent?.status === 'enabled' ? `已开通${data.agent.enabledAt ? ` · ${date(data.agent.enabledAt)}` : ''}` : data.agent?.status === 'reconsent_required' ? '协议已更新，待重新同意' : '未开通'} trailing={data.agent?.status === 'enabled' ? <span className="muted">关闭</span> : <span className="muted">去开通</span>} onClick={() => data.agent?.status === 'enabled' ? openModal('关闭智能助手', <CloseAssistant />) : navigate('assistant')} testId="agent-service" />
      <Row icon={IcoBell} tone="blue" title="消息渠道绑定" subtitle="飞书 / 微信 ClawBot" onClick={() => navigate('channels')} />
      <Row icon={IcoClock} tone="orange" title="智能助手操作与计划" onClick={() => navigate('tasks')} />
      <Row icon={IcoShield} tone="coral" title="智能助手安全" subtitle={data.agentLockedUntil && data.agentLockedUntil > new Date().toISOString() ? `已锁定至 ${date(data.agentLockedUntil)}` : '已开启 · 按操作需要确认与验证'} onClick={() => openModal('解除智能助手锁定', <form className="stack-form" onSubmit={async e => { const f = formValues(e); if (await mutate('/agent/unlock', f, '智能助手已解锁')) closeModal(); }}><PinField /><Submit>解除锁定</Submit></form>)} />
      <Row icon={IcoKeypad} tone="gold" title="验证方式" subtitle="摄像头人脸演示 + 模拟手机验证码 + 支付密码" />
    </Card>
    <Card title="交易保护">
      <Row icon={IcoSliders} tone="orange" title="每日转账限额" trailing={<b className="amount">¥{yuan(data.user.dailyLimit)}</b>} onClick={() => edit('limit')} />
      <Row icon={IcoWallet} tone="coral" title="银行卡冻结与解冻" onClick={() => navigate('accounts')} />
      <Row icon={IcoActivity} tone="gold" title="操作记录" onClick={() => navigate('agent')} />
    </Card>
    <Notice>连续8次密码验证失败后，该验证入口暂停15分钟。修改密码时不会将原始密码写入操作日志。</Notice>
  </div>;
}

// 关闭智能助手：只停用不需要密码；同时解绑渠道或清空数据不可撤销，需支付密码。
function CloseAssistant() {
  const { data, refresh, closeModal, toast } = useBank();
  const [unbind, setUnbind] = useState(false), [clear, setClear] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const bound = data.bindings.filter(b => b.status === 'active').length, needsPin = unbind || clear;
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    const f = formValues(e); if (busy) return;
    setBusy(true); setError('');
    try {
      const result = await api<{ cancelledActions: number; unboundChannels: number }>('/agent/enrollment/disable', 'POST', { unbindChannels: unbind, clearData: clear, ...(needsPin ? { pin: f.pin } : {}) });
      closeModal(); await refresh();
      toast(['智能助手已关闭', result.cancelledActions ? `取消${result.cancelledActions}笔待确认操作` : '', result.unboundChannels ? `解绑${result.unboundChannels}个渠道` : '', clear ? '已清空记忆与对话' : ''].filter(Boolean).join('，'));
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  return <form className="stack-form" onSubmit={submit}>
    <p className="body-copy">关闭后，App、飞书、微信和外部接口都不再受理对话，尚未确认的对话操作会被取消。已确认的定时转账、联动计划和订阅代扣照常执行，可在「智能助手操作与计划」中取消。</p>
    <label className="check-option"><input type="checkbox" checked={unbind} onChange={e => setUnbind(e.target.checked)} data-testid="close-unbind" /><span><strong>同时解绑飞书、微信</strong><small>{bound ? `当前已绑定 ${bound} 个渠道；` : '当前没有绑定渠道；'}不解绑则保留绑定，重新开通后可继续使用</small></span></label>
    <label className="check-option"><input type="checkbox" checked={clear} onChange={e => setClear(e.target.checked)} data-testid="close-clear" /><span><strong>同时清空个性化记忆与对话历史</strong><small>清空后不可恢复；操作审计与决策记录依规保留</small></span></label>
    {needsPin && <PinField />}
    <InlineError message={error} />
    <button className="btn-primary danger" disabled={busy} data-testid="close-submit">{needsPin ? '验证并关闭' : '确认关闭'}</button>
    <p className="footnote">重新开通需再次阅读并同意服务协议。</p>
  </form>;
}

export function Messages() {
  const { data, mutate, route, navigate, refresh } = useBank();
  const selected = new URLSearchParams(route.split('?')[1] || '').get('id');
  const message = selected ? data.notifications.find(n => n.id === selected) : undefined;
  // Opening one message reads only that one; a failed mark is harmless and retried the next time it opens.
  useEffect(() => { if (message && !message.is_read) void api(`/notifications/${encodeURIComponent(message.id)}/read`, 'POST', {}).then(() => refresh()).catch(() => {}); }, [message?.id]);
  if (selected) return <div className="page">
    <Card className="message-detail" testId="message-detail">
      {message ? <><h2>{message.title}</h2><small>{new Date(message.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}</small><p>{message.body}</p></> : <Empty title="消息不存在或已过期" />}
      <button className="btn-text center" onClick={() => navigate('messages')}>返回消息列表</button>
    </Card>
  </div>;
  return <div className="page">
    <Card title="账户通知" action="全部已读" onAction={() => void mutate('/notifications/read', {}, '全部消息已读')}>
      {data.notifications.map(n => <button className={`message message-row${n.is_read ? ' read' : ''}`} key={n.id} data-testid="message-row" onClick={() => navigate(`messages?id=${encodeURIComponent(n.id)}`)}><CircleIcon icon={IcoBell} tone={n.is_read ? 'gray' : 'blue'} size={40} glyph={20} /><div><h3>{n.title}{!n.is_read && <i className="dot" />}</h3><p>{n.body}</p><small>{date(n.created_at)}</small></div><ChevronRight size={17} className="chevron" /></button>)}
      {!data.notifications.length && <Empty title="暂无消息" />}
    </Card>
  </div>;
}

type AuditRow = { id: number; action: string; resource_id: string; created_at: string; detail: Record<string, unknown> };
export function AgentCenter() {
  const { data, openModal, begin } = useBank();
  const [runs, setRuns] = useState<AgentRun[]>([]);
  useEffect(() => { api<AgentRun[]>('/agent/runs').then(setRuns).catch(() => {}); }, [data]);
  const [logs, setLogs] = useState<AuditRow[]>([]), [error, setError] = useState('');
  useEffect(() => { api<AuditRow[]>('/audit').then(setLogs).catch(e => setError(e.message)); }, [data]);
  const link = (href: string, icon: typeof IcoDoc, title: string) => <a className="row" href={href} target="_blank" rel="noreferrer"><CircleIcon icon={icon} tone="blue" size={44} glyph={22} /><span className="row-body"><span className="row-line"><strong className="row-title">{title}</strong></span><span className="row-line row-sub"><small className="row-subtitle mono">{href}</small></span></span><ChevronRight size={18} className="chevron" /></a>;
  return <div className="page">
    <section className="card stats"><div><strong>{data.transactions.length}</strong><span>最近交易</span></div><div><strong>{logs.length}</strong><span>最近操作</span></div><div><strong>SQLite</strong><span>持久化存储</span></div></section>
    <Card title="接口与能力">{link('/api/openapi.json', IcoDoc, 'OpenAPI 接口定义')}{link('/api/agent/manifest', IcoTerminal, 'Agent 能力清单')}</Card>
    <Card title="交易流程"><div className="flow-steps"><span>创建交易</span><ChevronRight size={14} /><span>核对确认</span><ChevronRight size={14} /><span>查询结果</span></div><p className="body-copy">网页操作与 API 共用业务状态和数据库。创建时传入 Idempotency-Key，金额输入使用“元”字符串，返回值使用整数“分”。待确认交易预留资金，15分钟自动过期；确认时校验支付密码。</p><pre className="code-snippet">POST /api/transactions{'\n'}POST /api/transactions/:id/confirm{'\n'}GET  /api/transactions/:id</pre></Card>
    <Card title="模拟异常场景"><Row icon={IcoTransfer} tone="red" title="模拟跨行转账失败" subtitle="验证失败状态与预留资金释放" onClick={() => openModal('模拟收款行拒绝', <form className="stack-form" onSubmit={e => { const f = formValues(e); void begin({ ...f, type: 'transfer', recipientName: '模拟收款人', recipientAccount: '6222000000000012345', bank: '其他银行', scenario: 'bank_rejected' }); }}><Notice>向虚构的外部收款账户发起转账。确认后收款行将模拟拒绝入账，交易标记为失败并释放预留资金。</Notice><AccountSelect /><Amount defaultValue="100.00" /><Submit>创建失败场景交易</Submit></form>)} /></Card>
    <Card title="智能体决策链路">{runs.map(r => <div className="form-card" key={r.id}><strong>{r.input}</strong><p className="data-note">{r.channel} · {date(r.created_at)} · {r.duration_ms}ms · {r.tokens} tokens{r.injection.length ? ' · 检测到注入特征' : ''}</p><DecisionTrace trace={r.trace} /><Markdown text={r.output} /></div>)}{!runs.length && <Empty title="尚无智能体调用记录" />}</Card>
    <Card title="操作记录"><div className="audit-list">{error && <Notice>{error}</Notice>}{logs.slice(0, 30).map(l => <div className="audit-row" key={l.id}><span className="audit-point" /><div><strong>{l.action}</strong><small>{date(l.created_at)}</small>{l.resource_id && <code>{l.resource_id}</code>}</div></div>)}{!logs.length && !error && <Empty />}</div></Card>
    <Notice>仅展示当前用户的操作记录，不提供跨用户访问或真实银行连接。</Notice>
  </div>;
}
