// Fixed detectors and authorization invariants share a versioned registry. Models cannot edit it.
const entries=[
 ['R01','LARGE_VS_HISTORY','historical amount','risk/policy.mjs'],['R02','ROLLING_OUTFLOW','7d/30d/calendar accumulation','puma/rules.mjs'],
 ['R03','SPLIT_TRANSFERS','short window velocity/splitting','puma/rules.mjs'],['R04','BALANCE_DRAIN','trusted balance exposure','risk/policy.mjs'],
 ['R05','DORMANT_REACTIVATION','dormant account','risk/policy.mjs'],['R06','RAPID_MIGRATION','rapid funds migration','puma/rules.mjs'],
 ['R07','NEW_BENEFICIARY','first payee','risk/policy.mjs'],['R08','NAME_MISMATCH','payee identity mismatch','risk/policy.mjs'],
 ['R09','BENEFICIARY_CHANGED','saved payee changed','risk/policy.mjs'],['R10','NEW_DEVICE','verified new device','puma/rules.mjs'],
 ['R11','SECURITY_SETTINGS_CHANGED','verified security change','puma/rules.mjs'],['R12','ATO_SEQUENCE','account takeover sequence','risk/policy.mjs'],
 ['R13','SAFE_ACCOUNT_SCAM','safe-account impersonation','puma/rules.mjs'],['R14','URGENT_PAYMENT','urgency','puma/rules.mjs'],
 ['R15','GUARANTEED_RETURN_OR_SECRECY','false returns/secrecy','puma/rules.mjs'],['R16','REPEAT_SUSPICIOUS_PAYEE','linked suspicious payee','puma/rules.mjs'],
 ['R17','HISTORICAL_RISK_FLAG','live reviewed risk label','puma/rules.mjs'],['R18','CONFIRMED_FRAUD','confirmed fraud feedback','risk/policy.mjs'],
 ['R19','APPROVAL_REQUIRED','missing primary approval','risk/transfers.mjs'],['R20','DRAFT_VERSION','changed transaction digest','risk/transfers.mjs'],
 ['R21','APPROVAL_REPLAY_OR_EXPIRY','replay, expiry and provider idempotency','risk/transfers.mjs']
];
export const RULE_REGISTRY=Object.freeze(entries.map(([rule_id,signal,description,implementation])=>Object.freeze({rule_id,signal,description,implementation,version:'puma-fixed-v1',products:['SIMULATED_TRANSFER'],enabled:true,exceptions:rule_id<'R07'?['VERIFIED_INTERNAL_TRANSFER']:[],action:rule_id>='R19'?'REJECT':'EVALUATE_FIXED_POLICY'})));
export function additionalSignals(f,candidate,trusted,config={}) {
  const signals=[],add=(code,group,severity='moderate',evidenceRef=code)=>signals.push({code,group,severity,evidenceRef,objective:true});
  if(!candidate?.ownAccount){
    const amount=candidate?.amountMinor||0;
    if((f.windows.d7.amount+amount>(config.rolling7Minor??5000000)||f.windows.d30.amount+amount>(config.rolling30Minor??15000000))&&amount>0)add('ROLLING_OUTFLOW','unusual_outflow');
    if(f.windows.short?.count>=(config.burstCount??5)&&f.windows.short.amount+amount>=(config.splitAmountMinor??500000))add('SPLIT_TRANSFERS','transaction_velocity');
  }
  const groups={RAPID_MIGRATION:'balance_drain',NEW_DEVICE:'account_security_change',SECURITY_SETTINGS_CHANGED:'account_security_change',SAFE_ACCOUNT_SCAM:'scam_context',URGENT_PAYMENT:'scam_urgency',GUARANTEED_RETURN_OR_SECRECY:'scam_context',REPEAT_SUSPICIOUS_PAYEE:'linked_risk',HISTORICAL_RISK_FLAG:'linked_risk'};
  for(const e of trusted.events||[]){
    if(!groups[e.type]||!e.verified||!e.sourceRef||!Number.isFinite(Date.parse(e.expiresAt))||e.expiresAt<=trusted.at||e.occurredAt&&(!Number.isFinite(Date.parse(e.occurredAt))||e.occurredAt>trusted.at))continue;
    add(e.type,groups[e.type],e.type==='SAFE_ACCOUNT_SCAM'?'severe':'moderate',e.sourceRef);
  }
  return signals;
}
