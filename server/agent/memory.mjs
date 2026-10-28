import { id, now } from '../db.mjs';
import { requireThat } from '../errors.mjs';
import { injectionFlags } from './guard.mjs';
import { assertPrincipal } from './principal.mjs';
import { createHash } from 'node:crypto';
import { classifyMemory, MODULES, INTENTS } from './modules.mjs';
import { routeBehavior } from './behavior-router.mjs';
import { createModularRetriever } from './memory-retrieval.mjs';

export const PROFILE_KEYS = ['preferred_name','focus_areas','language','answer_length','analysis_style','markets','sectors','watchlist','investment_goal','investment_horizon'];
const sensitive = /password|\bpin\b|token|secret|密码|验证码|密钥|身份证|银行卡号|\d{11,19}|sk-[\w-]+/i;
const authoritative = /^(balance|holdings|positions|risk_level|risk_tolerance|transactions|余额|持仓|风险等级|风险承受能力)$/i;
const clean = text => text.normalize('NFKC').trim().replace(/\s+/g,' ');
const digest = text => createHash('sha256').update(text).digest('hex');
export function boundedHistory(history, maxBytes = 24000) {
  const result=[]; let bytes=0;
  for(const item of [...history].slice(-12).reverse()) {
    if(!['user','assistant'].includes(item.role)||typeof item.content!=='string')continue;
    const size=Buffer.byteLength(item.content);
    if(bytes+size>maxBytes)break;
    bytes+=size;result.unshift({role:item.role,content:item.content});
  }
  while(result[0]?.role==='assistant')result.shift();
  return result;
}

export function createMemoryManager(bank, options={}) {
  let onChange=()=>{};
  const enabled = () => options.enabled ?? process.env.PERSONALIZATION_ENABLED !== 'false';
  const scope = p => { assertPrincipal(bank,p); return [p.tenant_id,p.user_id]; };
  const live = "status='active' AND confirmed=1 AND (expires_at IS NULL OR expires_at>?)";
  function validate(key,value) {
    requireThat(typeof key==='string'&&typeof value==='string'&&key.trim().length>0&&key.length<=60&&value.trim().length>0&&value.length<=300,'记忆格式无效',400,'INVALID_MEMORY');
    key=clean(key);value=clean(value);
    requireThat(!sensitive.test(key+' '+value)&&!authoritative.test(key)&&!injectionFlags(value).length,'此内容不能保存为偏好记忆',400,'UNSAFE_MEMORY');
    if(key==='language')requireThat(['中文','English'].includes(value),'请选择中文或English',400,'INVALID_MEMORY');
    if(key==='answer_length')requireThat(['简短','适中','详细'].includes(value),'请选择简短、适中或详细',400,'INVALID_MEMORY');
    if(key==='preferred_name')requireThat(value.length<=20,'称呼不超过20个字',400,'INVALID_MEMORY');
    return {key,value};
  }
  function epoch(p) { return bank.get('SELECT epoch FROM memory_epochs WHERE tenant_id=? AND user_id=?',...scope(p))?.epoch||0; }
  function invalidate(p,change={}) {
    bank.run('INSERT INTO memory_epochs(tenant_id,user_id,epoch) VALUES(?,?,1) ON CONFLICT(tenant_id,user_id) DO UPDATE SET epoch=epoch+1',...scope(p));
    // A correction/revocation also invalidates old conversational copies, including other channels.
    bank.run("UPDATE agent_sessions SET history='[]' WHERE user_id=?",p.user_id);
    bank.run("UPDATE agent_sessions SET task_context='{}' WHERE user_id=?",p.user_id);
    bank.run('DELETE FROM memory_module_summaries WHERE tenant_id=? AND user_id=?',...scope(p));
    onChange(p,change);
  }
  function activate(p,module){bank.run('INSERT INTO user_memory_modules VALUES(?,?,?,?,?) ON CONFLICT(tenant_id,user_id,module) DO UPDATE SET updated_at=excluded.updated_at',...scope(p),module,now(),now());}
  function metadata(key,category,change={},route){
    const base=classifyMemory(key,category),module=change.module||(base.module==='general'&&!['preferred_name','focus_areas','language','answer_length','analysis_style'].includes(key)?route?.primary_module:null)||base.module;
    const memory_type=change.memory_type||base.memory_type,intent=change.intent||'any';
    requireThat(Object.hasOwn(MODULES,module)&&['explicit','semantic','episodic','interaction'].includes(memory_type)&&(intent==='any'||INTENTS.includes(intent)),'记忆分类无效',400,'INVALID_MEMORY');return {module,memory_type,intent};
  }
  function log(p,row,action,source) {
    bank.run('INSERT INTO memory_changes(tenant_id,user_id,memory_id,action,version,source_message_id,created_at) VALUES(?,?,?,?,?,?,?)',...scope(p),row.memory_id,action,row.version,source||null,now());
  }
  function list(p) {
    return bank.all("SELECT * FROM agent_memory WHERE tenant_id=? AND user_id=? AND status<>'deleted' ORDER BY updated_at DESC LIMIT 200",...scope(p))
      .concat(bank.all("SELECT * FROM memory_candidates WHERE tenant_id=? AND user_id=? AND status='candidate' ORDER BY updated_at DESC LIMIT 100",...scope(p)))
      .map(row=>({...row,status:row.expires_at&&row.expires_at<=now()?'expired':row.status}));
  }
  function profile(p) {
    return Object.fromEntries(bank.all(`SELECT key,value FROM agent_memory WHERE tenant_id=? AND user_id=? AND ${live}`,...scope(p),now()).filter(r=>PROFILE_KEYS.includes(r.key)).map(r=>[r.key,r.value]));
  }
  function update(p, change, source={}) {
    requireThat(enabled(),'个性化功能已关闭',503,'PERSONALIZATION_DISABLED');
    const {key,value}=validate(change.key,change.value);
    requireThat(source.type==='explicit'||source.type==='confirmed','记忆需要本人确认',400,'MEMORY_CONFIRMATION_REQUIRED');
    const category=PROFILE_KEYS.includes(key)?'profile':change.category||'preference';
    requireThat(['profile','preference','research','temporary'].includes(category),'记忆类别无效',400,'INVALID_MEMORY');
    let expires=change.expires_at ?? (category==='temporary'?new Date(Date.now()+7*86400000).toISOString():category==='research'?new Date(Date.now()+90*86400000).toISOString():null);
    if(expires!==null){requireThat(typeof expires==='string'&&Number.isFinite(Date.parse(expires))&&Date.parse(expires)>Date.now(),'有效期无效',400,'INVALID_MEMORY');expires=new Date(expires).toISOString();}
    return bank.atomic(()=>{
      const old=bank.get('SELECT * FROM agent_memory WHERE tenant_id=? AND user_id=? AND key=?',...scope(p),key);
      if(change.version!==undefined)requireThat(old?.version===change.version,'记忆已更新，请刷新后重试',409,'MEMORY_CONFLICT');
      const meta=metadata(key,category,{module:change.module??old?.module,memory_type:change.memory_type??old?.memory_type,intent:change.intent??old?.intent},source.route);
      if(source.messageId&&!bank.run('INSERT OR IGNORE INTO memory_events VALUES(?,?,?,?)',...scope(p),source.messageId,key).changes)return old;
      if(old?.status==='active'&&old.value===value&&old.expires_at===expires&&old.module===meta.module&&old.memory_type===meta.memory_type&&old.intent===meta.intent)return old;
      const time=now(),memoryId=old?.memory_id||id('MEM');
      bank.run(`INSERT INTO agent_memory(user_id,key,value,updated_at,tenant_id,memory_id,category,status,confirmed,source_message_id,source_channel,source_type,confidence,importance,created_at,expires_at,version)
        VALUES(?,?,?,?,?,?,?,'active',1,?,?,?,1,0.8,?,?,1) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at,category=excluded.category,status='active',confirmed=1,source_message_id=excluded.source_message_id,source_channel=excluded.source_channel,source_type=excluded.source_type,confidence=1,expires_at=excluded.expires_at,version=agent_memory.version+1`,
        p.user_id,key,value,time,p.tenant_id,memoryId,category,source.messageId||id('EDIT'),p.channel,source.type,time,expires);
      bank.run('UPDATE agent_memory SET module=?,memory_type=?,intent=? WHERE tenant_id=? AND user_id=? AND key=?',meta.module,meta.memory_type,meta.intent,...scope(p),key);activate(p,meta.module);
      bank.run("UPDATE memory_candidates SET status='superseded' WHERE tenant_id=? AND user_id=? AND key=? AND status='candidate'",...scope(p),key);
      invalidate(p,{key,reason:'explicit_update'});
      const row=bank.get('SELECT * FROM agent_memory WHERE tenant_id=? AND user_id=? AND key=?',...scope(p),key);log(p,row,old?'updated':'created',source.messageId);return row;
    });
  }
  function candidate(p, change, source) {
    if(!enabled())return {saved:false};
    const {key,value}=validate(change.key,change.value);
    requireThat(source?.messageId&&typeof source.input==='string'&&typeof change.evidence==='string'&&change.evidence.length<=600&&change.evidence.trim().length>=2&&source.input.includes(change.evidence)&&change.evidence.includes(value),'候选缺少当前用户原文证据',400,'MEMORY_EVIDENCE_REQUIRED');
    return bank.atomic(()=>{
      const old=bank.get('SELECT * FROM agent_memory WHERE tenant_id=? AND user_id=? AND key=?',...scope(p),key);
      if(old?.status==='deleted'||old?.value===value)return {saved:false};
      if(bank.get('SELECT 1 FROM memory_rejections WHERE tenant_id=? AND user_id=? AND key=? AND value_digest=?',...scope(p),key,digest(value)))return {saved:false};
      if(source.epoch!==undefined&&source.epoch!==epoch(p))return {saved:false};
      const row={memory_id:id('MEM'),version:1},time=now();
      const meta=metadata(key,'preference',{},source.route);
      const inserted=bank.run(`INSERT OR IGNORE INTO memory_candidates(memory_id,tenant_id,user_id,key,value,category,source_message_id,source_channel,created_at,updated_at,expires_at)
        VALUES(?,?,?,?,?,'preference',?,?,?,?,?)`,row.memory_id,...scope(p),key,value,source.messageId,p.channel,time,time,new Date(Date.now()+30*86400000).toISOString());
      if(inserted.changes){bank.run('UPDATE memory_candidates SET module=?,memory_type=?,intent=? WHERE tenant_id=? AND user_id=? AND memory_id=?',meta.module,meta.memory_type,meta.intent,...scope(p),row.memory_id);activate(p,meta.module);log(p,row,'candidate',source.messageId);}
      return {saved:false,candidate:true,key};
    });
  }
  function owned(p,memoryId) {
    const row=bank.get('SELECT * FROM agent_memory WHERE tenant_id=? AND user_id=? AND memory_id=?',...scope(p),memoryId)
      ||bank.get('SELECT * FROM memory_candidates WHERE tenant_id=? AND user_id=? AND memory_id=?',...scope(p),memoryId);
    requireThat(row&&['active','candidate','expired'].includes(row.status),'记忆不存在或已被替换',404,'NOT_FOUND');return row;
  }
  function confirm(p,memoryId,version) {
    return bank.atomic(()=>{const row=owned(p,memoryId);requireThat(row.status==='candidate'&&row.version===version&&(!row.expires_at||row.expires_at>now()),'候选已变化或过期，请刷新',409,'MEMORY_CONFLICT');
      return update(p,{key:row.key,value:row.value,category:row.category,module:row.module,memory_type:row.memory_type,intent:row.intent},{type:'confirmed',messageId:id('CONFIRM')});});
  }
  function remove(p,memoryId,version) {
    return bank.atomic(()=>{
      const row=owned(p,memoryId);requireThat(version===undefined||row.version===version,'记忆已更新，请刷新',409,'MEMORY_CONFLICT');
      const current=bank.get('SELECT * FROM agent_memory WHERE tenant_id=? AND user_id=? AND key=?',...scope(p),row.key);
      if(current?.memory_id!==memoryId){
        // Rejecting a suggestion must not delete a different, already confirmed preference.
        bank.run('INSERT OR IGNORE INTO memory_rejections VALUES(?,?,?,?)',...scope(p),row.key,digest(row.value));
        bank.run("UPDATE memory_candidates SET value=memory_id,status='deleted',version=version+1 WHERE tenant_id=? AND user_id=? AND memory_id=?",...scope(p),memoryId);
        invalidate(p,{key:row.key,reason:'rejected'});log(p,{...row,version:row.version+1},'deleted');return {ok:true};
      }
      // Deleting an active/legacy memory revokes its field and every pending replacement.
      bank.run(`INSERT INTO agent_memory(user_id,key,value,updated_at,tenant_id,memory_id,status,created_at,version) VALUES(?,?,'',?,?,?,'deleted',?,1)
        ON CONFLICT(user_id,key) DO UPDATE SET value='',status='deleted',confirmed=0,version=agent_memory.version+1,updated_at=excluded.updated_at`,p.user_id,row.key,now(),p.tenant_id,current?.memory_id||row.memory_id,now());
      bank.run("UPDATE memory_candidates SET value=memory_id,status='deleted',version=version+1 WHERE tenant_id=? AND user_id=? AND key=?",...scope(p),row.key);
      invalidate(p,{key:row.key,reason:'deleted'});log(p,{...row,version:(current?.version||0)+1},'deleted');return {ok:true};
    });
  }
  function relevant(p,query) {
    return retrieval.retrieve(p,query,routeBehavior({text:query})).items;
  }
  function recent(p,sessionId) {
    const row=bank.get('SELECT history,updated_at FROM agent_sessions WHERE user_id=? AND id=? AND channel=? AND archived=0',scope(p)[1],sessionId,p.channel);
    return row&&Date.parse(row.updated_at)>Date.now()-7*86400000?boundedHistory(JSON.parse(row.history)):[];
  }
  function command(p,input,messageId) {
    if(!enabled())return null;
    const text=input.trim().replace(/[。！!]$/,'');
    if(/^(查看|列出)(我的)?(记忆|偏好|关注的主题)$/.test(text))return list(p).filter(r=>r.status==='active').map(r=>`${r.key}：${r.value}（${r.memory_id}）`).join('\n')||'尚未保存已确认的记忆。';
    if(/^(帮助|help)$/i.test(text))return '可以查询账户、分析账单；回复「查看我的记忆」管理偏好，或在App「我的 → 个性化与记忆」确认、修改、删除。资金操作仍需App验证。';
    const deletion=text.match(/^(?:删除|忘记)(?:记忆)?\s*(MEM[a-f0-9]+)$/i);
    if(deletion){remove(p,deletion[1]);return '该记忆已删除，旧对话不会将它自动恢复。';}
    const deleteKey=text.match(/^(?:删除|忘记)(?:我的)?(称呼|关注业务|回答语言|回答长度|分析方式|关注市场|关注行业|关注资产|投资目标|投资期限)(?:偏好|记忆)?$/);
    if(deleteKey){
      const key=({称呼:'preferred_name',关注业务:'focus_areas',回答语言:'language',回答长度:'answer_length',分析方式:'analysis_style',关注市场:'markets',关注行业:'sectors',关注资产:'watchlist',投资目标:'investment_goal',投资期限:'investment_horizon'})[deleteKey[1]];
      const row=list(p).find(r=>r.key===key);if(row)remove(p,row.memory_id);
      return row?'该项记忆已删除，旧对话不会将它自动恢复。':'没有找到该项已保存记忆。';
    }
    const preference=text.match(/^(?:以后|今后)(?:请)?(?:用|使用)(中文|英文|English)(?:回答|回复)(?:我)?$/i);
    const length=text.match(/^(?:以后|今后)(?:请)?(?:给我|回答|回复|分析|财务分析)*(?:更)?(简短|适中|详细|完整)(?:的)?(?:回答|回复|分析|财务分析)?$/);
    let change=preference?{key:'language',value:preference[1]==='中文'?'中文':'English'}:length?{key:'answer_length',value:length[1]==='完整'?'详细':length[1]}:null;
    if(text==='以后分析股票时先展示估值指标')change={key:'analysis_style',value:'先展示估值指标'};
    if(text==='以后比较投资方案时先讲风险')change={key:'analysis_style',value:'先说明下行风险'};
    if(text==='以后不要优先讲风险')change={key:'analysis_style',value:'按问题自然顺序说明'};
    const interest=text.match(/^(?:我长期关注|记住我关注的(?:行业|主题)是)([^。！？!?]{1,100})$/);
    if(interest)change={key:'watchlist',value:interest[1]};
    if(change){update(p,change,{type:'explicit',messageId});return '已更新你的回答偏好，可在「个性化与记忆」查看或修改。';}
    return null;
  }
  function cleanup(at=now()) {
    bank.run("UPDATE agent_memory SET status='expired' WHERE status IN ('active','candidate') AND expires_at<=?",at);
    bank.run("UPDATE memory_candidates SET status='expired' WHERE status='candidate' AND expires_at<=?",at);
    bank.run("UPDATE agent_sessions SET history='[]' WHERE updated_at<? AND history<>'[]'",new Date(Date.parse(at)-7*86400000).toISOString());
    bank.run('UPDATE behavior_events SET revoked=1 WHERE revoked=0 AND session_id IN (SELECT id FROM agent_sessions WHERE archived=1 OR updated_at<?)',new Date(Date.parse(at)-7*86400000).toISOString());
    bank.run('DELETE FROM memory_module_summaries WHERE expires_at<=?',at);
  }
  const retrieval=createModularRetriever(bank,{scope,epoch,enabled,options:options.budgets});
  return {enabled,validate,list,profile,update,candidate,owned,confirm,remove,relevant,recent,command,cleanup,epoch,invalidate,activate,retrieve:retrieval.retrieve,setChangeListener:listener=>{onChange=listener;}};
}
