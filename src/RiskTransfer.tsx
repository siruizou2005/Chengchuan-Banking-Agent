import { useEffect, useRef, useState } from 'react';
import { Check, CircleAlert } from 'lucide-react';
import { api, formValues, transferAmountMinor, yuan } from './api';
import { useBank } from './bank';
import { Card, InlineError, Notice, PinField } from './ui';
import { Verify } from './Verify';
import './risk-transfer.css';

type Draft = { id: string; paymentId?: string | null; version: number; payloadHash: string; status: string; sourceAccountRef: string; beneficiaryRef: string; beneficiaryName: string; beneficiaryMasked: string; institution: string; amountMinor: number; currency: string; memo: string; feeMinor: number; delegateApprovals?: { id: string; status: string }[]; risk: { action: string; tier?: 'L0' | 'L1' | 'L2' | 'L3'; messages: string[]; offers: string[] } };
type Intent = { challengeId: string; version: number; payloadHash: string; verificationActionId: string | null; smsOnly?: boolean; draft: Draft };
const statuses: Record<string, string> = { RISK_CHECKED: '尚未授权', AWAITING_APPROVAL: '等待本人批准', USER_APPROVED: '已批准，尚未支付', PRE_EXECUTION_CHECK: '执行前复核中', HOLD_REVIEW: '草稿未提交，待复核', BLOCKED: '草稿未提交', SUBMITTING: '正在提交', PENDING: '渠道处理中，尚未确认成功', SETTLED: '模拟支付已完成', FAILED: '模拟支付失败', CANCELLED: '已取消', EXPIRED: '已过期' };
const editable = ['RISK_CHECKED', 'AWAITING_APPROVAL', 'USER_APPROVED', 'HOLD_REVIEW', 'BLOCKED'];
export function RiskTransfer() {
  const { data, route, refresh, navigate, navigatePage, toast } = useBank();
  const draftId = new URLSearchParams(route.split('?')[1] || '').get('id');
  const [draft, setDraft] = useState<Draft | null>(null), [intent, setIntent] = useState<Intent | null>(null);
  const [token, setToken] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [large, setLarge] = useState(false);
  const [flags, setFlags] = useState<{ id: string; scope_ref: string; status: string }[]>([]), [appealed, setAppealed] = useState(false);
  const [saved, setSaved] = useState<Draft[]>([]);
  // Announce the result once, when this page sees the draft reach it (also covers a payment that settles while polling).
  const lastStatus = useRef('');
  useEffect(() => {
    const status = draft?.status || '';
    if (lastStatus.current && lastStatus.current !== status) { if (status === 'SETTLED') toast('模拟转账已完成'); if (status === 'FAILED') toast('模拟转账未成功，预留资金已释放', true); }
    lastStatus.current = status;
  }, [draft?.status]);
  const load = async (id: string) => { setDraft(await api(`/v1/transfers/drafts/${id}`)); setFlags(await api('/v1/risk/flags')); };
  useEffect(() => { setDraft(null); setIntent(null); setToken(''); if (draftId) load(draftId).catch(e => setError(e.message)); }, [draftId]);
  useEffect(() => { if (!draftId) api<Draft[]>('/v1/transfers/drafts').then(setSaved).catch(e => setError(e.message)); }, [draftId, data.user.id]);
  useEffect(() => {
    if (!draft || !['PENDING', 'SUBMITTING', 'USER_APPROVED'].includes(draft.status)) return;
    const timer = setInterval(() => { load(draft.id).catch(e => setError(e.message)); }, 3000);
    return () => clearInterval(timer);
  }, [draft?.id, draft?.status]);
  async function act(work: () => Promise<void>) { setBusy(true); setError(''); try { await work(); await refresh(); } catch (e) { setError((e as Error).message); if (draft) await load(draft.id).catch(() => {}); if ((e as { code?: string }).code !== 'INVALID_PIN') { setIntent(null); setToken(''); } } finally { setBusy(false); } }
  // Leaving the verification only abandons this attempt; the draft stays until it is cancelled or expires.
  if (draft && intent?.verificationActionId && !token) return <Verify actionId={intent.verificationActionId} smsOnly={intent.smsOnly} onVerified={setToken} onCancel={() => setIntent(null)} />;
  const account = draft && data.accounts.find(a => a.id === draft.sourceAccountRef);
  const tier = draft?.risk?.tier;
  const payable = draft && editable.includes(draft.status) && !['BLOCKED', 'HOLD_REVIEW'].includes(draft.status) && tier !== 'L3';
  async function startIntent(d: Draft) {
    const i = await api<Intent>(`/v1/transfers/drafts/${d.id}/approval-intents`, 'POST', { version: d.version, payloadHash: d.payloadHash });
    setDraft(i.draft); setIntent(i); setToken(''); return i;
  }
  function cancelDraft(d: Draft) {
    void act(async () => { setDraft(await api(`/v1/transfers/drafts/${d.id}/cancel`, 'POST', {})); setIntent(null); setToken(''); });
  }
  if (draft?.status === 'SETTLED') return <div className={`page risk-transfer${large ? ' risk-large' : ''}`}><Card testId="risk-transfer-done">
    <div className="risk-done" aria-live="polite"><span className="risk-done-icon"><Check size={30} /></span><h3>{statuses.SETTLED}</h3><p className="risk-done-amount">¥{yuan(draft.amountMinor)}</p></div>
    <dl className="risk-details"><dt>收款人</dt><dd>{draft.beneficiaryName}</dd><dt>收款账户</dt><dd>{draft.beneficiaryMasked} · {draft.institution}</dd><dt>付款账户</dt><dd>{account?.name} · 尾号 {account?.number.slice(-4)}</dd><dt>用途</dt><dd>{draft.memo || '未填写'}</dd>{draft.paymentId && <><dt>流水号</dt><dd className="mono">{draft.paymentId}</dd></>}</dl>
    <div className="risk-done-actions"><button className="pill" onClick={() => navigate('ledger')}>查看交易记录</button><button className="pill primary" data-testid="risk-back-chat" onClick={() => navigatePage('assistant')}>回到对话</button></div>
  </Card></div>;
  return <div className={`page risk-transfer${large ? ' risk-large' : ''}`}><Card>
    <Notice>所有资金均为模拟。请在此核对银行服务端返回的信息；聊天中的“同意”不会批准付款。</Notice>
    <label className="risk-accessibility"><input type="checkbox" checked={large} onChange={e => setLarge(e.target.checked)} />大字与高对比显示</label>
    <InlineError message={error} />
    {!draftId && saved.length > 0 && <div aria-label="已有转账草稿">{saved.map(d => <button className="agent-list-row" key={d.id} onClick={() => navigate(`risk-transfer?id=${d.id}`)}>{d.beneficiaryName} · CNY {yuan(d.amountMinor)} · {statuses[d.status]}</button>)}</div>}
    {draft && <div aria-live="polite"><h3 className="risk-status">{statuses[draft.status] || draft.status}</h3><dl className="risk-details">
      <dt>付款账户</dt><dd>{account?.name} · 尾号 {account?.number.slice(-4)}</dd>
      <dt>收款人</dt><dd>{draft.beneficiaryName}</dd><dt>收款账户</dt><dd>{draft.beneficiaryMasked}</dd><dt>金融机构</dt><dd>{draft.institution}</dd>
      <dt>金额</dt><dd>{draft.currency} {yuan(draft.amountMinor)}</dd><dt>费用</dt><dd>{draft.currency} {yuan(draft.feeMinor)}</dd><dt>用途</dt><dd>{draft.memo || '未填写'}</dd>
    </dl>{draft.risk && draft.risk.messages.length > 0 && <div className="risk-alert" data-testid="risk-alert" role="note"><CircleAlert size={18} /><div><strong>付款前请再核对一下</strong><ul>{draft.risk.messages.map(m => <li key={m}>{m}</li>)}</ul></div></div>}
      {draft.delegateApprovals?.some(c=>c.status!=='APPROVED')&&<Notice>本笔转账还需完成已设置的共同确认，尚未提交付款。若关系过期、撤销或存在利益冲突，请取消此草稿并联系人工核实。</Notice>}
      {draft.risk?.offers.includes('INDEPENDENT_VERIFICATION_OFFER') && <Notice>可通过自己保存的电话或官方客服独立核实收款用途，不使用对方临时发来的联系方式。</Notice>}
      {draft.risk?.offers.includes('ACCESSIBLE_ASSISTANCE_OFFER') && <Notice>需要协助时可自愿联系人工客服；您无需添加家属或让他人代为批准。</Notice>}
    </div>}
    {(!draftId || draft && editable.includes(draft.status)) && !intent && <details className="risk-edit" key={draft?.version || 'new'} open={!draft}><summary>{draft ? '修改转账信息' : '填写转账信息'}</summary><form className="stack-form" onSubmit={e => {
      const values = formValues(e); void act(async () => {
        const body = { sourceAccountRef: values.sourceAccountRef, beneficiaryRef: values.beneficiaryRef, amountMinor: transferAmountMinor(values.amount), currency: 'CNY', memo: values.memo };
        const updated = await api<Draft>(draft ? `/v1/transfers/drafts/${draft.id}` : '/v1/transfers/drafts', draft ? 'PATCH' : 'POST', { ...body, ...(draft ? { version: draft.version } : {}) });
        setDraft(updated); navigate(`risk-transfer?id=${updated.id}`);
      });
    }}>
      <label>付款账户<select name="sourceAccountRef" defaultValue={draft?.sourceAccountRef || data.accounts[0]?.id}>{data.accounts.filter(a => a.type === 'debit').map(a => <option key={a.id} value={a.id}>{a.name} · {a.number.slice(-4)}</option>)}</select></label>
      <label>收款对象<select name="beneficiaryRef" defaultValue={draft?.beneficiaryRef} required>{draft && !data.payees.some(p => p.id === draft.beneficiaryRef) && <option value={draft.beneficiaryRef}>{draft.beneficiaryName} · {draft.beneficiaryMasked}</option>}{data.payees.map(p => <option key={p.id} value={p.id}>{p.name} · {p.number.slice(-4)}</option>)}</select></label>
      <label>金额（元）<input name="amount" inputMode="decimal" defaultValue={draft ? (draft.amountMinor / 100).toFixed(2) : ''} required /></label>
      <label>用途<input name="memo" maxLength={100} defaultValue={draft?.memo || ''} /></label>
      <button className="btn-primary" disabled={busy}>{draft ? '保存修改并重新核对' : '生成草稿'}</button>
    </form></details>}
    {draft && editable.includes(draft.status) && tier && <Notice>{{ L0: '请核对转账信息，输入一次交易密码即可确认。', L1: '为保障账户安全，本笔转账需要额外验证。', L2: '请独立核实收款人及用途，并完成所需的额外保护步骤。', L3: '本笔转账暂无法执行，可联系官方客服。' }[tier]}</Notice>}
    {payable && tier !== 'L0' && !intent && <button className="btn-primary" disabled={busy} onClick={() => void act(async () => { await startIntent(draft); })}>信息无误，开始本人验证</button>}
    {payable && (intent || tier === 'L0') && <form className="stack-form" onSubmit={e => { const f = formValues(e); void act(async () => {
      const i = intent || await startIntent(draft);
      if (i.verificationActionId && !token) return;
      setDraft(await api(`/v1/transfers/drafts/${draft.id}/approve`, 'POST', { challengeId: i.challengeId, version: i.version, payloadHash: i.payloadHash, pin: f.pin, ...(token ? { verificationToken: token } : {}) })); setIntent(null); setToken('');
    }); }}><PinField /><button className="btn-primary" disabled={busy}>本人批准此笔模拟转账</button></form>}
    {draft && editable.includes(draft.status) && <button className="btn-text" disabled={busy} onClick={() => cancelDraft(draft)}>取消草稿</button>}
    {draft && flags.some(f => f.scope_ref === draft.id) && <details className="risk-edit"><summary>风险提示有误？申请复核</summary><form className="stack-form" onSubmit={e => { const f = formValues(e); void act(async () => { await api('/v1/risk/appeals', 'POST', { flagId: flags.find(x => x.scope_ref === draft.id)!.id, rationale: f.rationale }); setAppealed(true); }); }}><label>申请人工复核<input name="rationale" minLength={5} maxLength={1000} required placeholder="请说明需要核实或纠正的情况" /></label><button className="btn-primary" disabled={busy || appealed}>{appealed ? '复核请求已登记' : '提交复核请求'}</button></form></details>}
    <button className="btn-text" onClick={() => navigate('support')}>帮助与客服（自愿）</button>
  </Card></div>;
}
