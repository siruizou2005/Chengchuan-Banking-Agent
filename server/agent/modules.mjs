// Reviewed application metadata. Neither chat input nor the evolution engine can register code.
export const MODULES = Object.freeze({
  spending: {description:'消费、现金流与账单',skills:['spending_analysis'],keywords:/消费|账单|支出|现金流|流水|对账|重复扣款|核对交易|spending|cash.?flow|reconcil/i},
  budgeting: {description:'预算、储蓄与目标',skills:['budget_planning'],keywords:/预算|储蓄|攒钱|存钱|budget|saving/i},
  investment: {description:'投资、产品比较与配置',skills:['portfolio_analysis','risk_analysis'],keywords:/投资|持仓|配置|股票|基金|理财|存款|估值|回撤|下行风险|推荐|买什么|怎么投|portfolio|invest/i},
  debt_credit: {description:'贷款、信用与还款',skills:['debt_analysis'],keywords:/贷款|债务|负债|还款|信用卡|房贷|debt|credit/i},
  financial_planning: {description:'长期规划、应急与保障',skills:['financial_planning'],keywords:/长期规划|财务规划|应急|退休|养老|保障|买房|教育金|退休金|planning/i},
  general: {description:'通用交互偏好',skills:[],keywords:/$a/},
});
export const INTENTS = Object.freeze(['explain','analyze','compare','plan','review','decide','update_preference','recall']);
export const MEMORY_TYPES = Object.freeze(['explicit','semantic','episodic','behavioral','interaction']);
export const CORE_KEYS = Object.freeze(['preferred_name','focus_areas','language','answer_length','analysis_style','investment_goal','important_constraints']);
export const TOOL_MODULES = Object.freeze({bill_report:'spending',spending_stats:'spending',detect_anomalies:'spending',get_ledger:'spending',get_transactions:'spending',wealth_advice:'investment',get_products_and_holdings:'investment',compare_products:'investment',get_risk_profile:'investment',get_loans:'debt_credit',get_credit_card:'debt_credit',get_scheduled_tasks:'budgeting',create_plan:'financial_planning'});
export function classifyMemory(key,category='preference') {
  const module=/^(markets|sectors|watchlist|investment_horizon)$/.test(key)?'investment':/investment_goal|emergency|retirement/.test(key)?'financial_planning':/budget|saving/.test(key)?'budgeting':/spend|cash_flow/.test(key)?'spending':/debt|loan|credit/.test(key)?'debt_credit':'general';
  return {module,memory_type:['preferred_name','focus_areas','language','answer_length','analysis_style'].includes(key)?'interaction':category==='research'?'episodic':'explicit',intent:'any'};
}
