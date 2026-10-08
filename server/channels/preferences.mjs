import { requireThat } from '../errors.mjs';
import { now } from '../db.mjs';
import { redact } from '../agent/guard.mjs';

export const channelNames=['feishu','wechat'];
export function channelPreferences(bank,userId){
  return Object.fromEntries(channelNames.map(channel=>[channel,{maskAmounts:Boolean(bank.get('SELECT mask_amounts FROM channel_preferences WHERE user_id=? AND channel=?',userId,channel)?.mask_amounts)}]));
}
export function setChannelPreference(bank,userId,channel,maskAmounts){
  requireThat(channelNames.includes(channel),'不支持的消息渠道',400,'INVALID_CHANNEL');
  requireThat(typeof maskAmounts==='boolean','隐藏金额必须为布尔值',400,'INVALID_CHANNEL_SETTING');
  return bank.atomic(()=>{
    bank.run('INSERT INTO channel_preferences(user_id,channel,mask_amounts,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id,channel) DO UPDATE SET mask_amounts=excluded.mask_amounts,updated_at=excluded.updated_at',userId,channel,maskAmounts?1:0,now());
    bank.audit(userId,'channel.preference_updated',channel,{maskAmounts});
    return {maskAmounts};
  });
}
export function maskMoney(text){
  const protectedValues=[];
  // Preserve links, action/receipt identifiers, account tails, dates, times and rates.
  let output=String(text).replace(/https?:\/\/[^\s<>，。；、）]+|\/#[^\s<>，。；、）]+|\b(?:ACT|TX|TRX|OUT|RUN|WXREQ|TASK|PLAN|BIND|SESSION|RCPT)[A-Za-z0-9_-]+\b|\*{4}\d{4}\b|\b\d{4}[-/]\d{1,2}(?:[-/]\d{1,2})?\b|\d{4}年\d{1,2}月(?:\d{1,2}日)?|\b\d{1,2}:\d{2}(?::\d{2})?\b|\d+(?:\.\d+)?\s*[%％]/g,value=>{const token=String.fromCharCode(0xe100+protectedValues.length);protectedValues.push(value);return token;});
  const number='[+-]?(?:\\d{1,3}(?:[,，]\\d{3})+|\\d+)(?:\\.\\d+)?';
  output=output.replace(new RegExp('((?:[¥￥$]|人民币|RMB|CNY|USD)\\s*\\**\\s*)'+number,'gi'),'$1****');
  output=output.replace(new RegExp(number+'(?=\\s*\\**\\s*(?:万?元|亿元|块(?:钱)?|人民币|美元|港元|欧元))','g'),'****');
  output=output.replace(/[零〇一二两三四五六七八九十百千万亿壹贰叁肆伍陆柒捌玖拾佰仟]+(?:点[零〇一二三四五六七八九]+)?(?=元|块钱|美元|港元|欧元)/g,'****');
  output=output.replace(new RegExp('((?:可用(?:余额|资金)?|余额|金额|收入|支出|消费|转账|还款|本金|总额|合计|总计|费用|限额|待还|持仓|收益|冻结资金|锁定资金)[ \\t:：为是共约¥￥*]*)'+number,'g'),'$1****');
  // Unlabelled monetary cells commonly occur in model-generated financial tables.
  output=output.replace(new RegExp('(\\|\\s*\\**\\s*)'+number+'(?=\\s*\\**\\s*\\|)','g'),'$1****');
  return output.replace(/[\ue100-\uf8ff]/g,c=>protectedValues[c.charCodeAt(0)-0xe100]??c);
}
export function channelText(bank,userId,channel,text){
  const clean=redact(String(text||''));
  return channelPreferences(bank,userId)[channel]?.maskAmounts?maskMoney(clean):clean;
}
