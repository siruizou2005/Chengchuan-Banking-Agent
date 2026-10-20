import { randomInt, randomBytes } from 'node:crypto';
import { id, now } from './db.mjs';
import { hash, requireThat } from './errors.mjs';
import { paramsDigest, actionParams } from './authorization.mjs';
import { createSmsDelivery } from './sms.mjs';
import { createFaceVerification } from './face.mjs';

export function createVerification(bank, services, options, faceOptions) {
  const { get, run, atomic, audit } = bank;
  const sms = createSmsDelivery(bank, options);
  const faceVerification = createFaceVerification(bank, faceOptions, { challenge });
  function owned(user, actionId) {
    const action = get('SELECT * FROM agent_actions WHERE id=? AND user_id=?', actionId, user.id);
    requireThat(action, '操作不存在',404,'NOT_FOUND');
    requireThat((action.status === 'proposed' && action.expires_at > now()) || (action.status==='awaiting_verification' && action.verification_until>now() && action.authorization_until>now()), '操作已结束或过期',409,'INVALID_STATE');
    requireThat(!action.params_digest || action.params_digest===paramsDigest(actionParams(action)),'操作参数已变化，请重新提议',403,'AUTHORIZATION_MISMATCH');
    return action;
  }
  async function start(user, actionId) {
    services.guard.assertOpen(user.id); const action=owned(user,actionId);
    faceVerification.assertIdentity(user);
    services.checkRate(`verify:${user.id}`);
    const code=String(randomInt(100000,1000000)), verificationId=id('V'), createdAt=now();
    const delivery=sms.forUser(user), detail={id:verificationId,channel:delivery.channel,...(delivery.reason?{reason:delivery.reason}:{})};
    atomic(()=>{
      const recent=get('SELECT created_at FROM verifications WHERE user_id=? AND action_id=? ORDER BY created_at DESC LIMIT 1',user.id,actionId);
      requireThat(!recent || Date.now()-Date.parse(recent.created_at)>1000,'验证码发送过于频繁',429,'RATE_LIMITED');
      requireThat(!get("SELECT id FROM verifications WHERE user_id=? AND action_id=? AND delivery_status='pending' AND expires_at>?",user.id,actionId,now()),'验证码正在发送，请稍后再试',429,'RATE_LIMITED');
      delivery.reserve();
      run('INSERT INTO verifications(id,user_id,action_id,code_hash,expires_at,created_at) VALUES(?,?,?,?,?,?)', verificationId,user.id,actionId,hash(code),new Date(Date.parse(createdAt)+300000).toISOString(),createdAt);
      run("UPDATE verifications SET params_digest=?,revision=?,sms_channel=?,delivery_status='pending' WHERE id=?",paramsDigest(actionParams(action)),action.revision,delivery.channel,verificationId);
      run('UPDATE verifications SET face_channel=? WHERE id=?',faceVerification.mode(user),verificationId);
    });
    // Network I/O must not run inside bank.atomic (SQLite transactions are synchronous).
    try {
      await delivery.send({phone:user.phone,code,expiresIn:300,verificationId,actionTitle:action.title});
    } catch {
      atomic(()=>{
        run("UPDATE verifications SET delivery_status='failed',used=1 WHERE id=?",verificationId);
        audit(user.id,'verification.send_failed',actionId,detail);
      });
      // Provider errors may contain credentials, phone numbers or message bodies.
      requireThat(false,'验证码发送失败，请稍后重试',503,'SMS_SEND_FAILED');
    }
    try { atomic(()=>{
      services.guard.assertOpen(user.id);
      const current=owned(user,actionId);
      requireThat(current.revision===action.revision && paramsDigest(actionParams(current))===paramsDigest(actionParams(action)),'操作参数已变化，请重新提议',403,'AUTHORIZATION_MISMATCH');
      requireThat(get('SELECT expires_at FROM verifications WHERE id=?',verificationId).expires_at>now(),'验证已过期，请重新开始',403,'VERIFICATION_EXPIRED');
      run('UPDATE verifications SET used=1 WHERE user_id=? AND action_id=? AND id<>?',user.id,actionId,verificationId);
      run("UPDATE verifications SET delivery_status='sent' WHERE id=?",verificationId);
      audit(user.id,'verification.started',actionId,detail);
    }); } catch (error) {
      atomic(()=>{
        run("UPDATE verifications SET delivery_status='sent',used=1 WHERE id=?",verificationId);
        audit(user.id,'verification.invalidated',actionId,detail);
      });
      throw error;
    }
    // A simulated code is no secret: there is no real inbox, so the page shows it with a demo notice.
    return { id:verificationId, expiresIn:300, simulated:delivery.simulated, channel:delivery.channel, faceChannel:faceVerification.mode(user), ...(delivery.target?{target:delivery.target}:{}), ...(delivery.showCode?{demoCode:code,reason:delivery.reason}:{}) };
  }
  function challenge(user, verificationId) {
    const v=get('SELECT * FROM verifications WHERE id=? AND user_id=?',verificationId,user.id);
    requireThat(v && v.delivery_status==='sent' && !v.used && v.expires_at>now(),'验证已过期，请重新开始',403,'VERIFICATION_EXPIRED');
    const action=owned(user,v.action_id);
    requireThat(v.params_digest===paramsDigest(actionParams(action)) && v.revision===action.revision,'验证与当前参数版本不匹配',403,'INVALID_VERIFICATION');return v;
  }
  function face(user, { id:verificationId, frameHash, skipped, reason }) {
    const v=challenge(user,verificationId);
    requireThat(v.face_channel==='simulated_face','当前验证必须完成人脸核身，不能使用模拟或跳过',403,'FACE_REQUIRED');
    requireThat(skipped === true ? ['unavailable','denied','unsupported'].includes(reason) : typeof frameHash==='string' && /^[a-f0-9]{64}$/.test(frameHash), '请先完成人脸演示或记录摄像头不可用原因');
    run('UPDATE verifications SET face_status=?,frame_hash=?,face_reason=? WHERE id=?',skipped?'skipped':'completed',skipped?null:frameHash,skipped?reason:null,verificationId);
    audit(user.id,skipped?'verification.face_skipped':'verification.face_simulated',verificationId,{channel:'simulated_face',reason:skipped?reason:undefined});
    return {ok:true,simulated:true};
  }
  function complete(user, {id:verificationId,code}) {
    services.checkRate(`verify:${user.id}`); const v=challenge(user,verificationId);
    requireThat(['completed','skipped'].includes(v.face_status),'请先完成人脸验证步骤',403,'FACE_REQUIRED');
    faceVerification.assertPassed(v);
    requireThat(v.attempts<8,'验证码尝试已达上限',429,'RATE_LIMITED');
    if(typeof code!=='string' || !/^\d{6}$/.test(code) || hash(code)!==v.code_hash) {
      run('UPDATE verifications SET attempts=attempts+1 WHERE id=?',verificationId);
      services.badAttempt(`verify:${user.id}`); services.guard.record(user.id,'code_failure');
      audit(user.id,'verification.rejected',v.action_id); requireThat(false,'验证码不正确',403,'INVALID_CODE');
    }
    requireThat(!v.token_hash,'验证令牌已签发，请勿重复提交',409,'TOKEN_ISSUED');
    const token=randomBytes(32).toString('hex');
    run('UPDATE verifications SET token_hash=?,token_expires_at=? WHERE id=?',hash(token),new Date(Date.now()+600000).toISOString(),verificationId);
    audit(user.id,'verification.completed',v.action_id,{channel:v.sms_channel,faceChannel:v.face_channel,faceSessionId:v.face_session_id}); return {verificationToken:token};
  }
  // Called inside the same database transaction as confirmation and settlement.
  function consume(user,actionId,token) {
    requireThat(typeof token==='string' && token.length===64,'此操作需在App完成加强验证',403,'VERIFICATION_REQUIRED');
    const v=get("SELECT * FROM verifications WHERE user_id=? AND action_id=? AND token_hash=? AND used=0 AND delivery_status='sent' AND token_expires_at>?",user.id,actionId,hash(token),now());
    requireThat(v,'验证令牌无效、已使用或与操作不匹配',403,'INVALID_VERIFICATION');
    const action=owned(user,actionId);
    requireThat(v.params_digest===paramsDigest(actionParams(action)) && v.revision===action.revision,'验证令牌与参数版本不匹配',403,'INVALID_VERIFICATION');
    faceVerification.consume(v);
    run('UPDATE verifications SET used=1 WHERE id=?',v.id); audit(user.id,'verification.consumed',actionId,{channel:v.sms_channel,faceChannel:v.face_channel,faceSessionId:v.face_session_id});
    return [v.sms_channel,v.face_channel==='tencent_face'?'tencent_face':v.face_status==='skipped'?'simulated_camera_fallback:'+v.face_reason:'simulated_face'];
  }
  return { start, face, complete, consume, faceVerification, delivery: sms };
}
export function registerVerification(route,verification) {
  route('get','/verify/identity','本人实名资料脱敏状态',(req,res)=>res.json(verification.faceVerification.profile(req.user)));
  route('post','/verify/identity','首次录入实名资料',(req,res)=>res.json(verification.faceVerification.enroll(req.user,req.body)));
  route('post','/verify/face/start','发起H5人脸核身',async(req,res)=>res.json(await verification.faceVerification.start(req.user,req.body.id)));
  route('post','/verify/face/result','服务端拉取并核对核身结果',async(req,res)=>res.json(await verification.faceVerification.result(req.user,req.body)));
  route('get','/verify/face/sessions/:id','本人核身进度',(req,res)=>res.json(verification.faceVerification.status(req.user,req.params.id)));
  route('post','/verify/start','发送加强验证验证码',async(req,res)=>res.json(await verification.start(req.user,req.body.actionId)));
  route('post','/verify/face','记录摄像头人脸演示步骤',(req,res)=>res.json(verification.face(req.user,req.body)));
  route('post','/verify/complete','验证短信并签发一次性操作令牌',(req,res)=>res.json(verification.complete(req.user,req.body)));
}
