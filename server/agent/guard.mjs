import { now } from '../db.mjs';
import { requireThat } from '../errors.mjs';

export function injectionFlags(text) {
  return [/忽略.{0,12}(指令|规则|之前)/i,/你现在是/i,/\b(system|developer)\s*:/i,/(无需|不用|跳过|绕过).{0,6}(确认|验证|密码)/i,/ignore.{0,25}(instructions|rules)/i].filter(r=>r.test(text)).map(r=>r.source);
}
export function redact(value) {
  const visit = v => {
    if (typeof v === 'string') return v.replace(/((?:支付密码|登录密码|密码|验证码|API[ _-]?KEY|PIN)\s*[:：=是为]?\s*)[A-Za-z0-9_-]{4,128}/gi,'$1[已隐藏]').replace(/\b\d{11,19}\b/g, n=>'****'+n.slice(-4)).replace(/sk-[a-zA-Z0-9_-]+/g,'[secret]');
    if (Array.isArray(v)) return v.map(visit);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k])=>!/(password|pin|token|secret|code_hash|frame_hash)/i.test(k)).map(([k,x])=>[k,visit(x)]));
    return v;
  };
  return visit(value);
}
export function validate(schema, input, path = '参数') {
  if (schema.type === 'object') {
    requireThat(input && typeof input === 'object' && !Array.isArray(input), `${path}须为对象`);
    const result = {};
    for (const key of schema.required || []) requireThat(Object.hasOwn(input,key), `${path}.${key}不能为空`);
    for (const [key,sub] of Object.entries(schema.properties || {})) if (Object.hasOwn(input,key)) result[key] = validate(sub,input[key],`${path}.${key}`);
    return result; // Explicit allowlist: unknown properties never reach business logic.
  }
  if (schema.type === 'array') {
    requireThat(Array.isArray(input) && input.length >= (schema.minItems || 0) && input.length <= (schema.maxItems || 100), `${path}列表长度无效`);
    return input.map((x,i)=>validate(schema.items,x,`${path}[${i}]`));
  }
  if (schema.type === 'string') requireThat(typeof input === 'string' && input.length >= (schema.minLength || 0) && input.length <= (schema.maxLength || 500) && (!schema.pattern || new RegExp(schema.pattern).test(input)), `${path}格式无效`);
  if (schema.type === 'number' || schema.type === 'integer') requireThat(typeof input === 'number' && Number.isFinite(input) && (schema.type !== 'integer' || Number.isInteger(input)) && input >= (schema.minimum ?? -Infinity) && input <= (schema.maximum ?? Infinity), `${path}数值无效`);
  if (schema.enum) requireThat(schema.enum.includes(input), `${path}取值无效`);
  return input;
}
export function unsupportedSuccess(text, completed = false) {
  return !completed && /已(?:成功)?(?:转账|支付|扣款|完成|挂失|解冻|冻结|取消订阅|锁定资金)|(?:申购|转账|支付|缴费|还款|挂失|赎回|冻结|解冻|购买)成功/.test(text);
}
export function createGuard(bank, options = {}) {
  const disabled = () => (options.disabled ?? process.env.AGENT_DISABLED === 'true');
  function locked(userId) { const u=bank.get('SELECT agent_locked_until FROM users WHERE id=?',userId); return disabled() || (u?.agent_locked_until && u.agent_locked_until > now()); }
  function assertOpen(userId) { requireThat(!locked(userId), disabled() ? '智能助手暂时关闭，请使用银行业务页面' : '智能助手已安全锁定30分钟，可在安全中心使用支付密码解除',423,'AGENT_LOCKED'); }
  function record(userId, kind) {
    bank.run('INSERT INTO agent_security(user_id,kind,created_at) VALUES(?,?,?)',userId,kind,now());
    const since = new Date(Date.now()-900000).toISOString();
    let count=bank.get('SELECT COUNT(*) AS n FROM agent_security WHERE user_id=? AND kind=? AND created_at>?',userId,kind,since).n;
    if(kind==='action_failure') {
      const last=bank.get("SELECT MAX(id) AS n FROM agent_security WHERE user_id=? AND kind='action_success'",userId).n || 0;
      count=bank.get('SELECT COUNT(*) AS n FROM agent_security WHERE user_id=? AND kind=? AND created_at>? AND id>?',userId,kind,since,last).n;
    }
    const threshold = ['pin_failure','code_failure'].includes(kind) ? 8 : 3;
    if (kind !== 'action_success' && count >= threshold && !locked(userId)) {
      bank.run('UPDATE users SET agent_locked_until=? WHERE id=?',new Date(Date.now()+1800000).toISOString(),userId);
      bank.audit(userId,'agent.locked','',{kind,count}); bank.notify(userId,'智能助手安全锁定','检测到连续异常，写操作与工具调用已暂停30分钟。可前往安全中心解除。');
    }
  }
  function unlock(userId) { bank.atomic(()=>{bank.run('UPDATE users SET agent_locked_until=NULL WHERE id=?',userId);bank.run('DELETE FROM agent_security WHERE user_id=?',userId);bank.audit(userId,'agent.unlocked');}); }
  return { locked, assertOpen, record, unlock, disabled };
}
