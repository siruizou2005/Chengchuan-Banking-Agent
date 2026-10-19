// Read-only evidence collection. Run in the deployed service's environment, against its database.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [mode,file='idle-baseline.json']=process.argv.slice(2);
if(!['start','check'].includes(mode)||!process.env.BANK_DB){
  console.error('Usage: BANK_DB=/path/bank.sqlite node scripts/audit-idle.mjs start|check /path/baseline.json');
  process.exit(2);
}
const path=resolve(process.env.BANK_DB),db=new DatabaseSync(path,{readOnly:true});
try {
  const instance=db.prepare('SELECT tenant_id FROM personalization_instance WHERE id=1').get().tenant_id;
  const count=db.prepare('SELECT COUNT(*) n FROM inference_calls').get().n;
  const maxRow=db.prepare('SELECT COALESCE(MAX(rowid),0) n FROM inference_calls').get().n;
  const pending=db.prepare("SELECT COUNT(*) n FROM agent_execution_queue WHERE status IN ('queued','running')").get().n;
  if(mode==='start') {
    if(pending||db.prepare("SELECT COUNT(*) n FROM inference_calls WHERE status='running'").get().n)throw Error('Pending user requests must finish before the idle observation.');
    writeFileSync(file,JSON.stringify({path,instance,count,maxRow,startedAt:new Date().toISOString()},null,2),{flag:'wx',mode:0o600});
    console.log('Baseline saved. Keep the service running without user requests for at least 24 hours, then run check.');
  } else {
    const baseline=JSON.parse(readFileSync(file,'utf8'));
    if(baseline.path!==path||baseline.instance!==instance||count<baseline.count)throw Error('Database changed or audit rows were removed; start a new observation.');
    const elapsedHours=(Date.now()-Date.parse(baseline.startedAt))/3600000;
    const calls=db.prepare('SELECT trigger_source,status,COUNT(*) count FROM inference_calls WHERE rowid>? GROUP BY trigger_source,status').all(baseline.maxRow);
    const passed=elapsedHours>=24&&calls.length===0&&pending===0;
    console.log(JSON.stringify({passed,elapsedHours,calls,pending,checkedAt:new Date().toISOString(),scope:'This database only; confirm continuous service uptime and no external model callers separately.'},null,2));
    if(!passed)process.exitCode=1;
  }
} finally { db.close(); }
