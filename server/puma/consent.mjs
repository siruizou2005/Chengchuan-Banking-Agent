import { id, now } from '../db.mjs';
import { requireThat } from '../errors.mjs';
import { resolvePrincipal } from '../agent/principal.mjs';
export const SCOPES=['data_read','personalization','agent_tools','trait_research'];
export function consentAllowed(bank,userId,scope) {
  const c=bank.get('SELECT * FROM puma_consents WHERE user_id=? AND scope=? ORDER BY version DESC LIMIT 1',userId,scope);
  // Existing account/read/personalization permissions remain compatible. Research is opt-in.
  return c ? !c.revoked_at && c.expires_at>now() : scope!=='trait_research';
}
export function createConsentService(bank,services) {
  function update(user,body) {
    requireThat(Object.keys(body).every(k=>['scope','granted','expiresAt','pin'].includes(k))&&SCOPES.includes(body.scope)&&typeof body.granted==='boolean','授权范围无效',400,'INVALID_CONSENT');
    if(body.granted) services.pin(user,body.pin);
    const expiry=body.expiresAt||new Date(Date.now()+30*86400000).toISOString();
    requireThat(Number.isFinite(Date.parse(expiry))&&Date.parse(expiry)>Date.now()&&Date.parse(expiry)<=Date.now()+366*86400000,'授权有效期无效',400,'INVALID_CONSENT');
    return bank.atomic(()=>{
      const version=bank.get('SELECT COALESCE(MAX(version),0)+1 n FROM puma_consents WHERE user_id=? AND scope=?',user.id,body.scope).n;
      bank.run('UPDATE puma_consents SET revoked_at=COALESCE(revoked_at,?) WHERE user_id=? AND scope=?',now(),user.id,body.scope);
      bank.run('INSERT INTO puma_consents VALUES(?,?,?,?,?,?,?)',id('PC'),user.id,body.scope,version,now(),new Date(expiry).toISOString(),body.granted?null:now());
      if(['personalization','trait_research','data_read'].includes(body.scope)) services.memory.invalidate(resolvePrincipal(bank,user),{reason:'consent_changed'});
      if(body.scope==='personalization'&&!body.granted){
        bank.run('UPDATE behavior_events SET revoked=1 WHERE user_id=?',user.id);
        bank.run("UPDATE behavior_hypotheses SET status='expired',version=version+1 WHERE user_id=?",user.id);
      }
      if(body.scope==='agent_tools'&&!body.granted) services.agentControl.stop(user);
      bank.audit(user.id,'puma.consent.changed',body.scope,{version,granted:body.granted});
      return {scope:body.scope,version,granted:body.granted,expiresAt:expiry};
    });
  }
  return {update,allowed:(user,scope)=>consentAllowed(bank,user.id,scope),list:user=>bank.all('SELECT scope,version,issued_at,expires_at,revoked_at FROM puma_consents WHERE user_id=? ORDER BY scope,version DESC',user.id)};
}
