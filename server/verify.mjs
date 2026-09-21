import { randomInt, randomBytes } from 'node:crypto';
import { id, now } from './db.mjs';
import { hash, requireThat } from './errors.mjs';

export function createVerification(bank, services) {
  const { get, run, atomic, audit, notify } = bank;
  function owned(user, actionId) {
    const action = get('SELECT * FROM agent_actions WHERE id=? AND user_id=?', actionId, user.id);
    requireThat(action, '操作不存在',404,'NOT_FOUND');
    requireThat(action.status === 'proposed' && action.expires_at > now(), '操作已结束或过期',409,'INVALID_STATE');
    return action;
  }
  function start(user, actionId) {
    services.guard.assertOpen(user.id); const action=owned(user,actionId);
    const recent=get('SELECT created_at FROM verifications WHERE user_id=? AND action_id=? ORDER BY created_at DESC LIMIT 1',user.id,actionId);
    requireThat(!recent || Date.now()-Date.parse(recent.created_at)>1000,'验证码发送过于频繁',429,'RATE_LIMITED');
    services.checkRate(`verify:${user.id}`);
    const code=String(randomInt(100000,1000000)), verificationId=id('V');
    atomic(()=>{
      run('UPDATE verifications SET used=1 WHERE user_id=? AND action_id=?',user.id,actionId);
      run('INSERT INTO verifications(id,user_id,action_id,code_hash,expires_at,created_at) VALUES(?,?,?,?,?,?)', verificationId,user.id,actionId,hash(code),new Date(Date.now()+300000).toISOString(),now());
      notify(user.id,'模拟短信验证码',`【澄川银行】验证码 ${code}，用于：${action.title}。5分钟内有效。请勿发送给聊天助手或他人。`);
      audit(user.id,'verification.started',actionId,{id:verificationId});
    });
    return { id:verificationId, expiresIn:300, simulated:true };
  }
  function challenge(user, verificationId) {
    const v=get('SELECT * FROM verifications WHERE id=? AND user_id=?',verificationId,user.id);
    requireThat(v && !v.used && v.expires_at>now(),'验证已过期，请重新开始',403,'VERIFICATION_EXPIRED');
    owned(user,v.action_id); return v;
  }
  function face(user, { id:verificationId, frameHash, skipped, reason }) {
    challenge(user,verificationId);
    requireThat(skipped === true ? ['unavailable','denied','unsupported'].includes(reason) : typeof frameHash==='string' && /^[a-f0-9]{64}$/.test(frameHash), '请先完成人脸演示或记录摄像头不可用原因');
    run('UPDATE verifications SET face_status=?,frame_hash=? WHERE id=?',skipped?'skipped':'completed',skipped?null:frameHash,verificationId);
    audit(user.id,skipped?'verification.face_skipped':'verification.face_simulated',verificationId,{reason:skipped?reason:undefined});
    return {ok:true,simulated:true};
  }
  function complete(user, {id:verificationId,code}) {
    services.checkRate(`verify:${user.id}`); const v=challenge(user,verificationId);
    requireThat(v.face_status!=='pending','请先完成人脸模拟步骤',403,'FACE_REQUIRED');
    requireThat(v.attempts<8,'验证码尝试已达上限',429,'RATE_LIMITED');
    if(typeof code!=='string' || !/^\d{6}$/.test(code) || hash(code)!==v.code_hash) {
      run('UPDATE verifications SET attempts=attempts+1 WHERE id=?',verificationId);
      services.badAttempt(`verify:${user.id}`); services.guard.record(user.id,'code_failure');
      audit(user.id,'verification.rejected',v.action_id); requireThat(false,'验证码不正确',403,'INVALID_CODE');
    }
    requireThat(!v.token_hash,'验证令牌已签发，请勿重复提交',409,'TOKEN_ISSUED');
    const token=randomBytes(32).toString('hex');
    run('UPDATE verifications SET token_hash=?,token_expires_at=? WHERE id=?',hash(token),new Date(Date.now()+600000).toISOString(),verificationId);
    audit(user.id,'verification.completed',v.action_id); return {verificationToken:token};
  }
  // Called inside the same database transaction as confirmation and settlement.
  function consume(user,actionId,token) {
    requireThat(typeof token==='string' && token.length===64,'此操作需在App完成强验证',403,'VERIFICATION_REQUIRED');
    const v=get('SELECT * FROM verifications WHERE user_id=? AND action_id=? AND token_hash=? AND used=0 AND token_expires_at>?',user.id,actionId,hash(token),now());
    requireThat(v,'验证令牌无效、已使用或与操作不匹配',403,'INVALID_VERIFICATION');
    run('UPDATE verifications SET used=1 WHERE id=?',v.id); audit(user.id,'verification.consumed',actionId);
  }
  return { start, face, complete, consume };
}
export function registerVerification(route,verification) {
  route('post','/verify/start','发送模拟短信验证码',(req,res)=>res.json(verification.start(req.user,req.body.actionId)));
  route('post','/verify/face','记录摄像头人脸演示步骤',(req,res)=>res.json(verification.face(req.user,req.body)));
  route('post','/verify/complete','验证短信并签发一次性操作令牌',(req,res)=>res.json(verification.complete(req.user,req.body)));
}
