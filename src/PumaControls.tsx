import { useEffect, useState } from 'react';
import { api, formValues, yuan } from './api';
import { useBank } from './bank';
import { Card, InlineError, Notice, PinField } from './ui';

type Control = { stopped: boolean; epoch: number };
type Relation = { id: string; user_id: string; delegate_user_id: string; role: string; identity_status: string; revoked_at: string | null; delegate_name: string; owner_name: string };
type Confirmation = { id: string; status: string; digest: string; draftStatus: string; amountMinor: number; currency: string; beneficiaryName: string; beneficiaryMasked: string; institution: string; feeMinor: number; memo: string };
const roleNames: Record<string,string> = { TRUSTED_CONTACT: '可信联系人', VOLUNTARY_CO_APPROVER: '自愿共同确认人', LEGAL_GUARDIAN: '经审核的法定监护人' };
export function PumaControls() {
  const { data, refresh } = useBank();
  const [control,setControl]=useState<Control|null>(null),[relations,setRelations]=useState<Relation[]>([]),[confirmations,setConfirmations]=useState<Confirmation[]>([]);
  const [enabled,setEnabled]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  async function load() {
    const [c,r,a,p]=await Promise.all([api<Control>('/agent/control'),api<Relation[]>('/v1/puma/delegates'),api<Confirmation[]>('/v1/puma/delegate-approvals'),api('/v1/puma/config')]);
    setControl(c);setRelations(r);setConfirmations(a);setEnabled(['enabled','monitored_canary'].includes(p.flags.puma_delegate_approval));
  }
  useEffect(()=>{void load().catch(e=>setError(e.message));},[data.user.id]);
  async function act(work:()=>Promise<unknown>,message:string) { setBusy(true);setError('');try{await work();setNotice(message);await load();await refresh();}catch(e){setError((e as Error).message);}finally{setBusy(false);} }
  return <Card title="助手控制与共同保护"><div className="stack-form">
    <InlineError message={error}/>{notice&&<Notice>{notice}</Notice>}
    <p aria-live="polite">{control?.stopped?'助手已停止':'可随时停止助手，撤销尚未执行的助手授权。已提交的交易仍按支付结果显示。'}</p>
    {control&&!control.stopped&&<button className="btn-primary" disabled={busy} onClick={()=>void act(()=>api('/agent/control/stop','POST',{}),'助手已停止，未执行任务已取消。')}>停止全部助手动作</button>}
    {control?.stopped&&<form className="stack-form" onSubmit={e=>{const f=formValues(e);void act(()=>api('/agent/control/resume','POST',{pin:f.pin}),'助手已恢复，原任务不会自动重新执行。');}}><PinField/><button className="btn-primary" disabled={busy}>验证并恢复助手</button></form>}
    <details><summary>个性化使用授权</summary><p>关闭后不再使用个性化资料生成推断，账户与交易安全检查继续运行。</p>
      <button className="btn-text" disabled={busy} onClick={()=>void act(()=>api('/v1/puma/consents','POST',{scope:'personalization',granted:false}),'个性化使用已关闭。')}>关闭个性化</button>
      <form className="stack-form" onSubmit={e=>{const f=formValues(e);void act(()=>api('/v1/puma/consents','POST',{scope:'personalization',granted:true,pin:f.pin}),'已授权未来30天使用个性化资料。');}}><PinField/><button className="btn-text" disabled={busy}>重新授权个性化（30天）</button></form>
    </details>
    {enabled&&<details><summary>添加自愿保护关系</summary><p>可信联系人不能批准付款。共同确认人须独立验证；每笔付款仍须本人批准。</p>
      <form className="stack-form" onSubmit={e=>{const f=formValues(e);void act(()=>api('/v1/puma/delegates','POST',{delegatePhone:f.phone,role:f.role,minAmountMinor:Math.round(Number(f.amount)*100),expiresAt:new Date(Date.now()+30*86400000).toISOString(),pin:f.pin}),'关系已登记，请对方登录并验证。有效期30天。');}}>
        <label>对方在本行登记的手机号<input name="phone" inputMode="tel" pattern="[0-9]{11}" required/></label>
        <label>关系<select name="role"><option value="TRUSTED_CONTACT">可信联系人</option><option value="VOLUNTARY_CO_APPROVER">自愿共同确认人</option></select></label>
        <label>需共同确认的起始金额（元）<input name="amount" type="number" min="0" step="0.01" defaultValue="1000" required/></label>
        <PinField/><button className="btn-primary" disabled={busy}>授权并登记</button>
      </form>
    </details>}
    {relations.filter(r=>!r.revoked_at).map(r=><details key={r.id}><summary>{r.owner_name} → {r.delegate_name} · {roleNames[r.role]}</summary>
      <p>{r.identity_status==='VERIFIED'?'身份已验证':'等待独立验证'}{r.role==='LEGAL_GUARDIAN'?'；请联系人工完成法定权限审核。':''}</p>
      {r.role!=='LEGAL_GUARDIAN'&&<form className="stack-form" onSubmit={e=>{const f=formValues(e);const action=r.user_id===data.user.id?'revoke':'verify';void act(()=>api(`/v1/puma/delegates/${r.id}/${action}`,'POST',{pin:f.pin}),action==='revoke'?'关系已撤销，已依赖该关系的待批付款不会自动放行。':'已完成独立验证。');}}><PinField/><button className="btn-text" disabled={busy}>{r.user_id===data.user.id?'撤销此自愿关系':'验证并接受关系'}</button></form>}
    </details>)}
    {confirmations.filter(c=>c.status==='REQUESTED'&&['RISK_CHECKED','AWAITING_APPROVAL','USER_APPROVED'].includes(c.draftStatus)).map(c=><details key={c.id}><summary>共同核对：{c.beneficiaryName} · {c.currency} {yuan(c.amountMinor)}</summary><p>{c.beneficiaryMasked} · {c.institution} · 费用 {yuan(c.feeMinor)} · {c.memo||'未填写用途'}</p>
      <form className="stack-form" onSubmit={e=>{const f=formValues(e);void act(()=>api(`/v1/puma/delegate-approvals/${c.id}/confirm`,'POST',{digest:c.digest,decision:f.decision,pin:f.pin}),'共同确认结果已记录，付款还须满足本人批准和风控复核。');}}><label>核对结果<select name="decision"><option value="APPROVED">确认交易信息</option><option value="REJECTED">拒绝</option></select></label><PinField/><button className="btn-primary" disabled={busy}>提交核对结果</button></form>
    </details>)}
  </div></Card>;
}
