import { id, now } from '../db.mjs';
import { hash, requireThat } from '../errors.mjs';
export const DELEGATE_ROLES=['TRUSTED_CONTACT','VOLUNTARY_CO_APPROVER','LEGAL_GUARDIAN'];
export function createDelegateRegistry(bank,services,policy,options={}) {
  const enabled=()=>['enabled','monitored_canary'].includes(policy.flags.puma_delegate_approval);
  const reviewers=new Set(options.legalReviewerIds||[]);
  const active=userId=>bank.all("SELECT * FROM puma_delegates WHERE user_id=? AND revoked_at IS NULL AND expires_at>? AND (role<>'LEGAL_GUARDIAN' OR identity_status='VERIFIED')",userId,now());
  const audit=(userId,action,resource,detail={})=>bank.audit(userId,'puma.delegate.'+action,resource,detail);
  function register(user,body) {
    requireThat(enabled(),'共同保护功能尚未启用',409,'DELEGATE_DISABLED');
    services.pin(user,body.pin);
    if(body.delegatePhone){requireThat(typeof body.delegatePhone==='string'&&/^\d{11}$/.test(body.delegatePhone),'联系电话无效',400,'INVALID_DELEGATE');body={...body,delegateUserId:bank.get('SELECT id FROM users WHERE phone=?',body.delegatePhone)?.id};}
    requireThat(Object.keys(body).every(k=>['delegatePhone','delegateUserId','role','minAmountMinor','expiresAt','jurisdiction','pin'].includes(k))&&DELEGATE_ROLES.includes(body.role)&&body.delegateUserId!==user.id&&typeof body.delegateUserId==='string'&&bank.get('SELECT id FROM users WHERE id=?',body.delegateUserId),'保护关系无效',400,'INVALID_DELEGATE');
    requireThat(Number.isSafeInteger(body.minAmountMinor)&&body.minAmountMinor>=0&&Number.isFinite(Date.parse(body.expiresAt))&&Date.parse(body.expiresAt)>Date.now()&&Date.parse(body.expiresAt)<=Date.now()+366*86400000,'保护范围或期限无效',400,'INVALID_DELEGATE');
    requireThat(body.jurisdiction===undefined||typeof body.jurisdiction==='string'&&/^[A-Z-]{2,20}$/.test(body.jurisdiction),'司法辖区无效',400,'INVALID_DELEGATE');
    return bank.atomic(()=>{
      requireThat(!active(user.id).some(r=>r.delegate_user_id===body.delegateUserId&&r.role===body.role),'已有同类有效关系',409,'DELEGATE_EXISTS');
      const delegateId=id('PD');
      bank.run('INSERT INTO puma_delegates VALUES(?,?,?,?,?,?,?,?,?,?,0,1,NULL,?)',delegateId,user.id,body.delegateUserId,body.role,'PENDING','transfer',body.minAmountMinor,new Date(body.expiresAt).toISOString(),body.jurisdiction||null,null,now());
      audit(user.id,'registered',delegateId,{role:body.role});return {id:delegateId,status:'PENDING',role:body.role};
    });
  }
  function verify(user,delegateId,body) {
    services.pin(user,body.pin);
    return bank.atomic(()=>{
      const r=bank.get('SELECT * FROM puma_delegates WHERE id=? AND delegate_user_id=?',delegateId,user.id);
      requireThat(r&&!r.revoked_at&&r.expires_at>now(),'保护关系不可验证',403,'DELEGATE_FORBIDDEN');
      requireThat(r.role!=='LEGAL_GUARDIAN','法定权限须独立法律审核',403,'LEGAL_REVIEW_REQUIRED');
      bank.run("UPDATE puma_delegates SET identity_status='VERIFIED',version=version+1 WHERE id=?",r.id);
      bank.run("UPDATE puma_delegate_requirements SET status='CONFLICT' WHERE delegate_id=?",r.id);
      // Drafts already waiting on this relationship get a challenge bound to the new version right away.
      for(const d of bank.all("SELECT DISTINCT d.* FROM risk_drafts d JOIN puma_delegate_requirements c ON c.draft_id=d.id AND c.draft_version=d.version WHERE c.delegate_id=? AND d.status IN ('RISK_CHECKED','AWAITING_APPROVAL','USER_APPROVED')",r.id))sync(d);
      audit(r.user_id,'verified',r.id);return {id:r.id,status:'VERIFIED'};
    });
  }
  function legalReview(reviewer,delegateId,body) {
    requireThat(reviewers.has(reviewer.id),'无独立法律审核权限',403,'REVIEW_FORBIDDEN');
    services.pin(reviewer,body.pin);
    const r=bank.get("SELECT * FROM puma_delegates WHERE id=? AND role='LEGAL_GUARDIAN' AND revoked_at IS NULL",delegateId);
    const doc=options.legalDocuments?.find(d=>d.ref===body.documentRef&&d.userId===r?.user_id&&d.delegateUserId===r?.delegate_user_id);
    requireThat(r&&reviewer.id!==r.user_id&&reviewer.id!==r.delegate_user_id&&doc?.independentlyVerified===true&&doc.expiresAt>now()&&doc.scope==='transfer'&&doc.jurisdiction===r.jurisdiction,'法定材料无效、过期或未经独立验证',403,'INVALID_LEGAL_AUTHORITY');
    const revoked=doc.action==='REVOKE';
    bank.atomic(()=>{
      bank.run("UPDATE puma_delegates SET identity_status='VERIFIED',legal_review_ref=?,expires_at=?,revoked_at=?,version=version+1 WHERE id=?",hash(doc.ref),[r.expires_at,doc.expiresAt].sort()[0],revoked?now():null,r.id);
      bank.run("UPDATE puma_delegate_requirements SET status='CONFLICT' WHERE delegate_id=?",r.id);
      audit(r.user_id,revoked?'legal_revoked':'legal_reviewed',r.id,{reviewerId:reviewer.id,documentRef:hash(doc.ref)});
    });
    return {id:r.id,status:revoked?'REVOKED':'VERIFIED'};
  }
  function revoke(user,delegateId,body) {
    services.pin(user,body.pin);
    return bank.atomic(()=>{
      const r=bank.get('SELECT * FROM puma_delegates WHERE id=? AND user_id=?',delegateId,user.id);
      requireThat(r,'保护关系不存在',403,'DELEGATE_FORBIDDEN');
      requireThat(r.role!=='LEGAL_GUARDIAN','法定监护变更须独立审核流程',403,'LEGAL_REVIEW_REQUIRED');
      bank.run('UPDATE puma_delegates SET revoked_at=?,version=version+1 WHERE id=?',now(),r.id);
      bank.run("UPDATE puma_delegate_requirements SET status='CONFLICT' WHERE delegate_id=?",r.id);
      audit(user.id,'revoked',r.id);return {id:r.id,status:'REVOKED'};
    });
  }
  function conflict(r,payload) {
    return Boolean(r.conflict||bank.get('SELECT id FROM accounts WHERE user_id=? AND id=?',r.delegate_user_id,payload.targetId)||bank.all('SELECT number FROM accounts WHERE user_id=?',r.delegate_user_id).some(a=>hash(a.number)===payload.beneficiaryToken));
  }
  function sync(d) {
    const payload=JSON.parse(d.payload);
    // Accepted obligations survive a flag rollback. Pending enrollment also blocks until verified.
    const previous=bank.all('SELECT DISTINCT r.* FROM puma_delegates r JOIN puma_delegate_requirements c ON c.delegate_id=r.id WHERE c.draft_id=?',d.id);
    const required=new Map([...active(d.user_id).filter(r=>r.role!=='TRUSTED_CONTACT'&&d.amount_minor>=r.min_amount),...previous].map(r=>[r.id,r]));
    for(const r of required.values()){
      const status=r.revoked_at||r.expires_at<=now()||conflict(r,payload)?'CONFLICT':'REQUESTED';
      bank.run('INSERT OR IGNORE INTO puma_delegate_requirements VALUES(?,?,?,?,?,?,?,?,?,?,?)',id('PDC'),d.user_id,d.id,d.version,d.payload_hash,r.id,r.version,status,[d.expires_at,r.expires_at].sort()[0],null,now());
    }
  }
  function status(d) {
    const payload=JSON.parse(d.payload);
    // Each relationship change adds a row; only the newest speaks for the delegate, or a superseded CONFLICT would block the draft forever.
    return bank.all(`SELECT c.* FROM puma_delegate_requirements c WHERE c.draft_id=? AND c.draft_version=? AND c.delegate_version=(SELECT MAX(x.delegate_version)
      FROM puma_delegate_requirements x WHERE x.draft_id=c.draft_id AND x.draft_version=c.draft_version AND x.delegate_id=c.delegate_id)`,d.id,d.version).map(c=>{
      const r=bank.get('SELECT * FROM puma_delegates WHERE id=?',c.delegate_id);
      const state=c.expires_at<=now()?'EXPIRED':!r||r.revoked_at||r.version!==c.delegate_version||conflict(r,payload)?'CONFLICT':c.status;
      return {id:c.id,delegateId:c.delegate_id,status:state,digest:c.digest,expiresAt:c.expires_at};
    });
  }
  function ready(d) {sync(d);return status(d).every(c=>c.status==='APPROVED');}
  function confirm(user,challengeId,body) {
    requireThat(Object.keys(body).every(k=>['digest','decision','pin'].includes(k))&&['APPROVED','REJECTED'].includes(body.decision),'共同确认参数无效',400,'INVALID_DELEGATE_APPROVAL');
    services.pin(user,body.pin);
    return bank.atomic(()=>{
      const c=bank.get('SELECT * FROM puma_delegate_requirements WHERE id=?',challengeId),r=c&&bank.get('SELECT * FROM puma_delegates WHERE id=?',c.delegate_id);
      requireThat(r?.delegate_user_id===user.id&&r.role!=='TRUSTED_CONTACT'&&r.identity_status==='VERIFIED','没有交易共同确认权限',403,'DELEGATE_FORBIDDEN');
      const d=bank.get('SELECT * FROM risk_drafts WHERE id=?',c.draft_id);
      requireThat(d&&['RISK_CHECKED','AWAITING_APPROVAL','USER_APPROVED'].includes(d.status)&&d.version===c.draft_version&&d.payload_hash===body.digest&&c.digest===body.digest,'共同确认交易已变化',409,'DELEGATE_DIGEST_MISMATCH');
      requireThat(status(d).find(s=>s.id===c.id)?.status==='REQUESTED','共同确认已处理、过期或有利益冲突',409,'DELEGATE_CONFLICT');
      bank.run('UPDATE puma_delegate_requirements SET status=?,auth_context=? WHERE id=?',body.decision,`sandbox:pin:${user.id}`,c.id);
      audit(d.user_id,'decision',c.id,{decision:body.decision,draftId:d.id});return {draftId:d.id,ownerId:d.user_id,status:body.decision};
    });
  }
  function incoming(user) {
    return bank.all(`SELECT c.*,d.payload,d.status AS draft_status FROM puma_delegate_requirements c JOIN puma_delegates r ON r.id=c.delegate_id
      JOIN risk_drafts d ON d.id=c.draft_id WHERE r.delegate_user_id=? AND r.identity_status='VERIFIED' AND r.revoked_at IS NULL AND r.expires_at>? AND c.delegate_version=r.version AND c.draft_version=d.version ORDER BY c.created_at DESC LIMIT 50`,user.id,now())
      .map(c=>{const p=JSON.parse(c.payload),d=bank.get('SELECT * FROM risk_drafts WHERE id=?',c.draft_id);return {...status(d).find(s=>s.id===c.id),draftStatus:c.draft_status,amountMinor:p.amountMinor,currency:p.currency,beneficiaryName:p.beneficiaryName,beneficiaryMasked:p.beneficiaryMasked,institution:p.institution,feeMinor:p.feeMinor,memo:p.memo};});
  }
  function assertLegacy(user,amount) {
    requireThat(!active(user.id).some(r=>r.role!=='TRUSTED_CONTACT'&&amount>=r.min_amount),'请使用交易草稿完成已设置的共同确认',409,'DELEGATE_DRAFT_REQUIRED');
  }
  return {register,verify,revoke,legalReview,sync,status,ready,confirm,incoming,assertLegacy,list:user=>bank.all('SELECT r.id,r.user_id,r.delegate_user_id,r.role,r.identity_status,r.min_amount,r.expires_at,r.version,r.revoked_at,u.name AS owner_name,d.name AS delegate_name FROM puma_delegates r JOIN users u ON u.id=r.user_id JOIN users d ON d.id=r.delegate_user_id WHERE r.user_id=? OR r.delegate_user_id=?',user.id,user.id)};
}
