import { SKILLS } from './registry.mjs';

// Reviewed task selectors; chat cannot supply file paths or register a Skill.
const selectors=[
  {id:'cashflow_reconciliation',test:/对账|核对.*(?:流水|交易)|(?:流水|交易).*核对|重复扣款|账.*对不上|reconcil/i},
  {id:'budget_variance',test:/(?:预算|budget).*(?:差异|超|实际|对比|比较|偏差|variance|actual)|(?:超|差异|对比|比较|实际).*(?:预算|budget)/i},
  {id:'product_comparison',test:/(?:比较|对比|compare).*(?:产品|基金|存款|理财)|(?:产品|基金|存款|理财).*(?:比较|对比|compare)/i,tool:'compare_products'},
];
export function selectFinancialSkills({text='',tool,modules,intent,previous,continuation=false}) {
  if(['update_preference','recall'].includes(intent))return [];
  const matches=selectors.filter(s=>modules.includes(SKILLS[s.id].module)&&SKILLS[s.id].intents.includes(intent)&&(s.test.test(text)||(s.tool&&s.tool===tool)||(continuation&&previous?.required_skills?.includes(s.id))));
  return matches.sort((a,b)=>modules.indexOf(SKILLS[a.id].module)-modules.indexOf(SKILLS[b.id].module)).map(s=>s.id);
}
