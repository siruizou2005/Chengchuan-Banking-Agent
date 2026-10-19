import { performance } from 'node:perf_hooks';
import { CORE_KEYS, MODULES } from './modules.mjs';
import { requireThat } from '../errors.mjs';

const integer=(value,fallback)=>Number.isInteger(Number(value))&&Number(value)>=0?Number(value):fallback;
export function memoryBudgets(options={}) {
  return {items:Math.min(32,integer(options.items??process.env.MEMORY_MAX_ITEMS,8)),bytes:Math.min(16000,integer(options.bytes??process.env.MEMORY_MAX_BYTES,2400)),
    core:integer(options.core??process.env.MEMORY_CORE_BYTES,600),module:integer(options.module??process.env.MEMORY_MODULE_BYTES,1200),history:integer(options.history??process.env.MEMORY_HISTORY_BYTES,600)};
}
export function queryTerms(query) {
  return [...new Set((query.toLowerCase().match(/[a-z0-9.]{2,}|[\p{Script=Han}]{2,}/gu)||[]).flatMap(t=>/\p{Script=Han}/u.test(t)?[...t].slice(1).map((_,i)=>t.slice(i,i+2)):[t]))].slice(0,80);
}
export function createModularRetriever(bank,{scope,epoch,enabled,options={}}) {
  function retrieve(p,query,route,overrides={}) {
    const started=performance.now(),owner=scope(p),budget={...memoryBudgets(options),...overrides};
    let sqliteMs=0;
    const sql=(method,...args)=>{const start=performance.now();try{return bank[method](...args);}finally{sqliteMs+=performance.now()-start;}};
    if(!enabled())return {items:[],bytes:2,query_ms:0,cache_hits:0,levels:{core:0,module:0,history:0}};
    requireThat(Object.hasOwn(MODULES,route.primary_module)&&route.secondary_modules.every(m=>Object.hasOwn(MODULES,m)),'模块路由无效',400,'INVALID_MEMORY_ROUTE');
    const time=new Date().toISOString(),currentEpoch=epoch(p),terms=queryTerms(query),items=[],seen=new Set(),levels={core:0,module:0,history:0};let hits=0;
    const valid="status='active' AND confirmed=1 AND (expires_at IS NULL OR expires_at>?)";
    const core=sql('all',`SELECT * FROM agent_memory WHERE tenant_id=? AND user_id=? AND key IN (${CORE_KEYS.map(()=>'?')}) AND ${valid} ORDER BY importance DESC,updated_at DESC LIMIT 8`,...owner,...CORE_KEYS,time);
    const rank=rows=>rows.map(row=>({row,score:terms.filter(t=>(row.key+' '+row.value).toLowerCase().includes(t)).length*3+row.importance+row.confidence+Math.max(0,1-(Date.now()-Date.parse(row.updated_at))/(90*86400000))})).sort((a,b)=>b.score-a.score||a.row.memory_id.localeCompare(b.row.memory_id)).map(x=>x.row);
    function add(rows,level){
      for(const row of rank(rows)){
        if(seen.has(row.memory_id)||items.length>=budget.items)continue;
        const item={key:row.key,value:row.value};
        if(level==='history'){item.source_message_id=row.source_message_id;item.updated_at=row.updated_at;}
        const size=Buffer.byteLength(JSON.stringify(item));
        if(levels[level]+size>budget[level]||Buffer.byteLength(JSON.stringify([...items,item]))>budget.bytes)continue;
        items.push(item);seen.add(row.memory_id);levels[level]+=size;
      }
    }
    add(core,'core');
    for(const module of [...new Set([route.primary_module,...route.secondary_modules])]){
      let rows;const cached=sql('get','SELECT payload FROM memory_module_summaries WHERE tenant_id=? AND user_id=? AND module=? AND intent=? AND epoch=? AND expires_at>?',...owner,module,route.intent,currentEpoch,time);
      if(cached){rows=JSON.parse(cached.payload);hits++;}
      else {
        rows=sql('all',`SELECT memory_id,key,value,source_message_id,updated_at,expires_at,importance,confidence,memory_type FROM agent_memory WHERE tenant_id=? AND user_id=? AND module=? AND ${valid} AND intent IN ('any',?) AND memory_type<>'episodic' ORDER BY importance DESC,updated_at DESC LIMIT 48`,...owner,module,time,route.intent);
        const expiry=Math.min(Date.now()+300000,...rows.filter(r=>r.expires_at).map(r=>Date.parse(r.expires_at)));
        sql('run',`INSERT INTO memory_module_summaries VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,user_id,module,intent) DO UPDATE SET epoch=excluded.epoch,payload=excluded.payload,created_at=excluded.created_at,expires_at=excluded.expires_at`,...owner,module,route.intent,currentEpoch,JSON.stringify(rows),time,new Date(expiry).toISOString());
      }
      // A module match alone must not fill the prompt with low-importance archival notes.
      add(rows.filter(r=>CORE_KEYS.includes(r.key)||terms.some(t=>(r.key+' '+r.value).toLowerCase().includes(t))||(module!=='general'&&r.importance>=0.7)),'module');
      if(route.retrieval_depth==='detail'){
        const details=sql('all',`SELECT * FROM agent_memory WHERE tenant_id=? AND user_id=? AND module=? AND ${valid} AND memory_type='episodic' AND intent IN ('any',?) ORDER BY updated_at DESC LIMIT 12`,...owner,module,time,route.intent);
        add(details,'history');
      }
    }
    return {items,bytes:Buffer.byteLength(JSON.stringify(items)),query_ms:performance.now()-started,sqlite_ms:sqliteMs,cache_hits:hits,levels};
  }
  return {retrieve};
}
