import { now } from '../db.mjs';
import { requireThat } from '../errors.mjs';
import { redactIdentity } from '../privacy.mjs';

export function injectionFlags(text) {
  return [/忽略.{0,12}(指令|规则|之前)/i,/你现在是/i,/\b(system|developer)\s*:/i,/(无需|不用|跳过|绕过).{0,6}(确认|验证|密码)/i,/ignore.{0,25}(instructions|rules)/i].filter(r=>r.test(text)).map(r=>r.source);
}
// Topic gate runs before the model: banking keywords always pass, so only clear off-topic asks and bare greetings get a fixed reply.
const BANK_TOPIC=/账|余额|流水|转账|汇款|收款|付款|理财|基金|定期|活期|存款|利率|利息|收益|贷款|还款|借款|信用卡|卡|额度|冻结|挂失|订阅|扣费|代扣|缴费|水费|电费|燃气|话费|宽带|物业|花|消费|支出|收入|预算|省钱|存钱|攒钱|工资|银行|AA|提醒|钱|元|块|金额|限额|风险|产品|人工|客服/i;
const GREETING=/^(你好|您好|嗨|哈喽|hi|hello|hey|在吗|在不在|谢谢|多谢|感谢|谢了|再见|拜拜|早上好|早安|中午好|下午好|晚上好|晚安|你是谁|你能做什么|你会什么)(呀|啊|哦|你|您)?[\s!！。.,，~～?？]*$/i;
const OFF_TOPIC=[/(讲|说|来)(个|一个|段|几个)?.{0,4}笑话/,/(讲|说)(个|一个)?.{0,4}故事/,/写.{0,8}(诗|作文|小说|文章|歌词|对联|情书|检讨|周报|论文|代码|程序|脚本|函数)/,/翻译/,/\b(python|java|javascript|sql|html|css|c\+\+)\b/i,/(编程|代码|bug|报错)/i,/天气|星座|算命|运势|塔罗|菜谱|做菜|食谱/,/陪我(聊|玩)|聊聊天|玩(个)?游戏|猜谜|脑筋急转弯/,/(作业|习题|数学题|解方程)/];
export const OFF_TOPIC_REPLY='我是澄川银行智能助手，只能协助账户、账单、转账、理财、卡片、订阅、缴费等银行业务。你可以试试：查本月账单、给某人转账、对比理财产品。';
export const GREETING_REPLY='你好，我是澄川银行智能助手。可以帮你查余额和账单、转账、对比理财产品、管理卡片和订阅，请问要办理什么？';
export function topicGate(text) {
  const t=text.trim();
  if(t.length<=12&&GREETING.test(t)) return 'greeting';
  if(BANK_TOPIC.test(t)) return null;
  return OFF_TOPIC.some(r=>r.test(t))?'off_topic':null;
}
export function redact(value) {
  const visit = v => {
    if (typeof v === 'string') return v.replace(/((?:支付密码|登录密码|密码|验证码|API[ _-]?KEY|PIN)\s*[:：=是为]?\s*)[A-Za-z0-9_-]{4,128}/gi,'$1[已隐藏]').replace(/\b\d{11,19}\b/g, n=>'****'+n.slice(-4)).replace(/sk-[a-zA-Z0-9_-]+/g,'[secret]');
    if (Array.isArray(v)) return v.map(visit);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k])=>!/(password|pin|token|secret|code_hash|frame_hash)/i.test(k)).map(([k,x])=>[k,visit(x)]));
    return v;
  };
  return visit(redactIdentity(value));
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
