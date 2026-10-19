// The file allowlist is static and versioned with the application, never user-editable.
export const SKILLS = Object.freeze({
  spending_analysis:{name:'消费与现金流分析',description:'核对时段、口径和数据覆盖',version:'1.0.0',module:'spending',intents:['analyze','review','explain'],file:'spending_analysis.json'},
  budget_planning:{name:'预算与储蓄规划',description:'以已确认目标及真实现金流制定方案',version:'1.0.0',module:'budgeting',intents:['plan','analyze','compare'],file:'budget_planning.json'},
  portfolio_analysis:{name:'投资产品与持仓分析',description:'区分关注、实际持仓和模拟产品',version:'1.0.0',module:'investment',intents:['analyze','compare','decide','explain'],file:'portfolio_analysis.json'},
  risk_analysis:{name:'风险分析',description:'说明风险依据，不推断用户适当性',version:'1.0.0',module:'investment',intents:['analyze','compare','decide','explain'],file:'risk_analysis.json'},
  debt_analysis:{name:'债务与信用分析',description:'核对本金、还款约束和缺失费用',version:'1.0.0',module:'debt_credit',intents:['analyze','compare','plan','decide','explain'],file:'debt_analysis.json'},
  financial_planning:{name:'长期财务规划',description:'分开目标、假设、事实及待确认约束',version:'1.0.0',module:'financial_planning',intents:['plan','review','analyze','explain'],file:'financial_planning.json'},
});
export function skillMetadata(ids){return ids.filter(id=>Object.hasOwn(SKILLS,id)).map(id=>({id,...SKILLS[id],file:undefined}));}
