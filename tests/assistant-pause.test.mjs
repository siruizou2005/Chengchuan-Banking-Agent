import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './helpers.mjs';
import { future } from '../server/services.mjs';

const clock = (t, when = '2026-09-20T02:00:00.000Z') => t.mock.timers.enable({ apis: ['Date'], now: Date.parse(when) });
const at = seconds => new Date(Date.now() + seconds * 1000).toISOString();
const PAUSES = {
  '助手停止': { on: f => f.call('/agent/control/stop', {}), off: f => f.call('/agent/control/resume', { pin: '123456' }) },
  '安全锁定': { on: f => f.bank.run('UPDATE users SET agent_locked_until=? WHERE id=?', at(1800), f.user.id), off: f => f.call('/agent/unlock', { pin: '123456' }) },
  '全局关闭': { on: f => { f.agent.disabled = true; }, off: f => { f.agent.disabled = false; } },
  '授权过期': { on: f => f.bank.run("INSERT INTO puma_consents VALUES('PCX',?,'agent_tools',1,?,?,NULL)", f.user.id, at(-7200), at(-3600)), off: f => f.bank.run("UPDATE puma_consents SET expires_at=? WHERE id='PCX'", at(86400)) },
};
async function setup(t, options = {}) { const agent = { disabled: false }, f = await fixture(t, { agent, ...options }); return { ...f, agent }; }
const notices = (f, title) => f.bank.get('SELECT COUNT(*) AS n FROM notifications WHERE user_id=? AND title=?', f.user.id, title).n;
const dueSubscription = f => { const sub = f.bank.get('SELECT * FROM subscriptions WHERE user_id=? LIMIT 1', f.user.id), due = at(-1); f.bank.run('UPDATE subscriptions SET next_at=? WHERE id=?', due, sub.id); for (const other of f.bank.all('SELECT id FROM subscriptions WHERE user_id=? AND id<>?', f.user.id, sub.id)) f.bank.run("UPDATE subscriptions SET status='cancelled' WHERE id=?", other.id); return { ...sub, next_at: due }; };

for (const [name, pause] of Object.entries(PAUSES)) {
  test(`${name}时App大额转账的强验证、挂失和风控转账批准照常，助手动作仍受限`, async t => {
    const f = await setup(t), account = f.services.accountFor(f.user);
    const earlier = (await f.propose('propose_virtual_card', { limit: '100' })).data;
    await pause.on(f);
    const tx = (await f.req('/transactions', { type: 'transfer', amount: '1500', recipientName: '陈屿', recipientAccount: '6218808888000088096', bank: '澄川银行' }, f.alice.token, 'POST', { 'Idempotency-Key': randomUUID() })).data;
    const path = `/transactions/${tx.id}/confirm`, intent = (await f.call('/verify/intent', { path, body: {} })).data;
    assert.equal(intent.required, true);
    assert.equal((await f.call(path, { pin: '123456', verificationActionId: intent.actionId, verificationToken: await f.verify(intent.actionId) })).data.status, 'completed');
    const d = (await f.call('/v1/transfers/drafts', { sourceAccountRef: account.id, beneficiaryRef: f.recipient, amountMinor: 150000, currency: 'CNY' })).data;
    const i = (await f.call(`/v1/transfers/drafts/${d.id}/approval-intents`, { version: d.version, payloadHash: d.payloadHash })).data;
    assert.equal((await f.call(`/v1/transfers/drafts/${d.id}/approve`, { challengeId: i.challengeId, version: i.version, payloadHash: i.payloadHash, pin: '123456', ...(i.verificationActionId ? { verificationToken: await f.verify(i.verificationActionId) } : {}) })).data.status, 'SETTLED');
    const card = `/accounts/${account.id}`, lost = (await f.call('/verify/intent', { path: card, body: { status: 'lost' } })).data;
    assert.equal((await f.call(card, { status: 'lost', pin: '123456', verificationActionId: lost.actionId, verificationToken: await f.verify(lost.actionId) }, 'PATCH')).status, 200);
    assert.equal(f.services.accountFor(f.user).status, 'lost');
    assert.equal((await f.propose('propose_virtual_card', { limit: '200' })).status, 423);
    assert.equal((await f.call('/verify/start', { actionId: earlier.id })).status, name === '助手停止' ? 409 : 423);
  });
}

for (const [name, pause] of Object.entries({ '安全锁定': PAUSES['安全锁定'], '全局关闭': PAUSES['全局关闭'], '授权过期': PAUSES['授权过期'] })) {
  test(`定时转账到期遇${name}：保留任务和预留，只通知一次，恢复后执行`, async t => {
    clock(t); const f = await setup(t), b = f.balance().balance, a = (await f.propose('propose_transfer', { recipient: f.recipient, amount: '100', scheduleAt: at(60) })).data;
    await f.call(`/agent/actions/${a.id}/confirm`, { pin: '123456' });
    await pause.on(f); t.mock.timers.tick(61000); f.scheduler.runDue(); f.scheduler.runDue();
    assert.equal(f.services.owned(f.user, a.id).status, 'confirmed');
    const task = f.bank.get('SELECT status,error FROM scheduled_tasks WHERE action_id=?', a.id);
    assert.equal(task.status, 'pending'); assert.ok(task.error);
    assert.deepEqual({ ...f.balance() }, { balance: b, held: 10000 });
    assert.equal(notices(f, '定时任务暂缓'), 1); assert.equal(notices(f, '定时任务未完成'), 0);
    assert.equal(f.bank.get("SELECT COUNT(*) AS n FROM agent_security WHERE kind='action_failure'").n, 0);
    await pause.off(f); f.scheduler.runDue();
    assert.equal(f.services.owned(f.user, a.id).status, 'completed');
    assert.equal(f.bank.get('SELECT error FROM scheduled_tasks WHERE action_id=?', a.id).error, null);
    assert.deepEqual({ ...f.balance() }, { balance: b - 10000, held: 0 });
  });
}

test('定时转账一直未恢复：授权窗口结束才过期，释放预留并通知', async t => {
  clock(t); const f = await setup(t), b = f.balance().balance, a = (await f.propose('propose_transfer', { recipient: f.recipient, amount: '100', scheduleAt: at(60) })).data;
  await f.call(`/agent/actions/${a.id}/confirm`, { pin: '123456' });
  f.agent.disabled = true; t.mock.timers.tick(61000); f.scheduler.runDue();
  assert.equal(f.balance().held, 10000);
  t.mock.timers.tick(86400000); f.scheduler.runDue();
  assert.equal(f.services.owned(f.user, a.id).status, 'expired');
  assert.equal(f.bank.get('SELECT status FROM scheduled_tasks WHERE action_id=?', a.id).status, 'expired');
  assert.deepEqual({ ...f.balance() }, { balance: b, held: 0 });
  assert.equal(notices(f, '定时任务未完成'), 1);
});

test('联动计划到期遇暂时状态：步骤保留，恢复后继续', async t => {
  clock(t); const f = await setup(t), b = f.balance().balance;
  const plan = (await f.propose('create_plan', { title: '恢复计划', steps: [{ id: 'a', title: '付', tool: 'propose_payment', args: { billType: 'merchant', merchant: '鲜花', amount: '100' }, runAt: at(60) }] })).data;
  await f.call(`/agent/actions/${plan.id}/confirm`, { pin: '123456' });
  f.agent.disabled = true; t.mock.timers.tick(61000); f.scheduler.runDue();
  assert.equal(f.services.plans(f.user)[0].status, 'active'); assert.equal(f.balance().held, 10000);
  f.agent.disabled = false; f.scheduler.runDue();
  assert.equal(f.services.plans(f.user)[0].status, 'completed'); assert.deepEqual({ ...f.balance() }, { balance: b - 10000, held: 0 });
});

test('微信待重新认证时到期的定时转账保留，认证恢复后执行，解绑才撤销', async t => {
  clock(t); const f = await setup(t), b = f.balance().balance;
  f.bank.run("INSERT INTO channel_bindings(id,user_id,channel,external_id,created_at,binding_session_id) VALUES('BW',?,'wechat','wx-owner',?,'SESSW')", f.user.id, at(0));
  const a = f.services.propose(f.user, 'propose_transfer', { recipient: f.recipient, amount: '100', scheduleAt: at(60) }, { channel: 'wechat', sessionId: 'BW' });
  await f.call(`/agent/actions/${a.id}/confirm`, { pin: '123456' });
  f.bank.run("UPDATE channel_bindings SET auth_state='reauth_required' WHERE id='BW'");
  t.mock.timers.tick(61000); f.scheduler.runDue();
  assert.equal(f.services.owned(f.user, a.id).status, 'confirmed'); assert.equal(f.balance().held, 10000);
  f.bank.run("UPDATE channel_bindings SET auth_state='valid' WHERE id='BW'"); f.scheduler.runDue();
  assert.equal(f.services.owned(f.user, a.id).status, 'completed'); assert.deepEqual({ ...f.balance() }, { balance: b - 10000, held: 0 });
  const later = f.services.propose(f.user, 'propose_transfer', { recipient: f.recipient, amount: '10', scheduleAt: at(60) }, { channel: 'wechat', sessionId: 'BW' });
  await f.call(`/agent/actions/${later.id}/confirm`, { pin: '123456' });
  f.bank.run("UPDATE channel_bindings SET status='revoked' WHERE id='BW'");
  t.mock.timers.tick(61000); f.scheduler.runDue();
  assert.equal(f.services.owned(f.user, later.id).status, 'failed');
});

for (const [name, pause] of Object.entries(PAUSES)) {
  test(`订阅到期遇${name}：保留下次扣款日不进入失败，恢复后只扣一次`, async t => {
    clock(t); const f = await setup(t), sub = dueSubscription(f), b = f.balance().balance;
    await pause.on(f); f.scheduler.runDue(); f.scheduler.runDue();
    const held = f.bank.get('SELECT status,next_at FROM subscriptions WHERE id=?', sub.id);
    assert.deepEqual({ ...held }, { status: 'active', next_at: sub.next_at });
    assert.equal(f.balance().balance, b); assert.equal(notices(f, '订阅代扣暂缓'), 1); assert.equal(notices(f, '订阅代扣失败'), 0);
    await pause.off(f); f.scheduler.runDue(); f.scheduler.runDue();
    assert.equal(f.bank.get('SELECT status FROM subscriptions WHERE id=?', sub.id).status, 'active');
    assert.equal(f.balance().balance, b - sub.amount);
    assert.ok(f.bank.get('SELECT next_at FROM subscriptions WHERE id=?', sub.id).next_at > at(0));
  });
}

test('订阅真实失败照旧进入失败：账户冻结不重试', async t => {
  clock(t); const f = await setup(t), sub = dueSubscription(f);
  f.bank.run("UPDATE accounts SET status='frozen' WHERE user_id=?", f.user.id); f.scheduler.runDue();
  assert.equal(f.bank.get('SELECT status FROM subscriptions WHERE id=?', sub.id).status, 'payment_failed');
  assert.equal(notices(f, '订阅代扣失败'), 1);
});

test('订阅月末：按北京时间扣款日，短月在月末扣，下月回到原扣款日', async t => {
  clock(t, '2026-01-30T16:00:01.000Z'); const f = await setup(t), sub = dueSubscription(f);
  const charge = due => { f.bank.run('UPDATE subscriptions SET next_at=? WHERE id=?', due, sub.id); t.mock.timers.setTime(Date.parse(due) + 1000); f.scheduler.runDue(); return f.bank.get('SELECT next_at FROM subscriptions WHERE id=?', sub.id).next_at; };
  // 2026-01-31 00:00 Beijing time.
  const february = charge('2026-01-30T16:00:00.000Z');
  assert.equal(february, '2026-02-27T16:00:00.000Z');
  const march = charge(february);
  assert.equal(march, '2026-03-30T16:00:00.000Z');
  assert.equal(charge(march), '2026-04-29T16:00:00.000Z');
  assert.equal(f.bank.get("SELECT COUNT(*) AS n FROM transactions WHERE user_id=? AND idempotency_key LIKE 'subscription:%' AND status='completed'", f.user.id).n, 3);
});

test('订阅恢复时已错过多期：只扣一次，下次回到之后最近的扣款日', async t => {
  clock(t, '2026-04-10T02:00:00.000Z'); const f = await setup(t), sub = dueSubscription(f), b = f.balance().balance;
  f.bank.run('UPDATE subscriptions SET next_at=? WHERE id=?', '2026-01-30T16:00:00.000Z', sub.id);
  f.scheduler.runDue(); f.scheduler.runDue();
  assert.equal(f.balance().balance, b - sub.amount);
  assert.equal(f.bank.get('SELECT next_at FROM subscriptions WHERE id=?', sub.id).next_at, '2026-04-29T16:00:00.000Z');
});

const payLock = until => [{ id: 'pay', title: '付', tool: 'propose_payment', args: { billType: 'merchant', merchant: '蛋糕店', amount: '300' } }, { id: 'lock', title: '锁', tool: 'propose_lock_funds', args: { amount: '1000', purpose: '预算', until }, dependsOn: ['pay'] }];
const lockPay = until => [{ id: 'lock', title: '锁', tool: 'propose_lock_funds', args: { amount: '1000', purpose: '预算', until } }, { id: 'pay', title: '付', tool: 'propose_payment', args: { billType: 'merchant', merchant: '蛋糕店', amount: '300' }, dependsOn: ['lock'] }];
async function runPlan(t, f, steps) { const plan = (await f.propose('create_plan', { title: '资金计划', steps })).data; const r = (await f.call(`/agent/actions/${plan.id}/confirm`, { pin: '123456' })).data; return { plan, r }; }

test('计划先付后锁：确认时预留两者之和，付款后锁定足额', async t => {
  clock(t); const f = await setup(t), b = f.balance().balance, { plan, r } = await runPlan(t, f, payLock(at(5 * 86400)));
  assert.equal(r.status, 'confirmed'); assert.equal(f.balance().held, 130000); assert.equal(f.services.plans(f.user)[0].budget, 130000);
  t.mock.timers.tick(1000); f.scheduler.runDue(); f.scheduler.runDue();
  assert.equal(f.services.plans(f.user)[0].status, 'completed'); assert.equal(f.services.owned(f.user, plan.id).status, 'completed');
  assert.deepEqual({ ...f.balance() }, { balance: b - 30000, held: 100000 });
  t.mock.timers.tick(6 * 86400000); f.scheduler.runDue(); assert.equal(f.balance().held, 0);
});

test('计划先锁后付：付款从锁定预算中支出，这是原有的共享语义', async t => {
  clock(t); const f = await setup(t), b = f.balance().balance, { r } = await runPlan(t, f, lockPay(at(5 * 86400)));
  assert.equal(r.status, 'confirmed'); assert.equal(f.balance().held, 100000);
  t.mock.timers.tick(1000); f.scheduler.runDue(); f.scheduler.runDue();
  assert.equal(f.services.plans(f.user)[0].status, 'completed');
  assert.deepEqual({ ...f.balance() }, { balance: b - 30000, held: 70000 });
});

test('计划先付后锁且余额只够其一：确认时拒绝，不会先扣款再失败', async t => {
  clock(t); const f = await setup(t), account = f.services.accountFor(f.user);
  f.bank.run('UPDATE accounts SET balance=balance-? WHERE id=?', account.balance - 110000, account.id); f.bank.run("UPDATE accounts SET balance=balance+? WHERE id='system'", account.balance - 110000);
  const { r } = await runPlan(t, f, payLock(at(5 * 86400)));
  assert.equal(r.status, 'failed'); assert.deepEqual({ ...f.balance() }, { balance: 110000, held: 0 });
  t.mock.timers.tick(1000); f.scheduler.runDue();
  assert.deepEqual({ ...f.balance() }, { balance: 110000, held: 0 });
});

test('无时区的时间按北京时间解析，与进程时区无关；带时区的时间不变', t => {
  clock(t, '2026-09-20T02:00:00.000Z');
  const zone = process.env.TZ; t.after(() => { if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone; });
  for (const tz of ['UTC', 'America/New_York', 'Asia/Shanghai']) {
    process.env.TZ = tz;
    assert.equal(future('2026-09-21T10:00:00'), '2026-09-21T02:00:00.000Z', tz);
    assert.equal(future('2026-09-21T10:00'), '2026-09-21T02:00:00.000Z', tz);
    assert.equal(future('2026-09-21 10:00:30'), '2026-09-21T02:00:30.000Z', tz);
    assert.equal(future('2026-09-21'), '2026-09-20T16:00:00.000Z', tz);
    assert.equal(future('2026-09-21T10:00:00Z'), '2026-09-21T10:00:00.000Z', tz);
    assert.equal(future('2026-09-21T10:00:00+09:00'), '2026-09-21T01:00:00.000Z', tz);
    for (const bad of ['2026-02-30T10:00:00', '2026-09-21T25:00:00', '明天', 'Sep 21 2026', '']) assert.throws(() => future(bad), /有效时间/, bad);
    assert.throws(() => future('2026-09-20T09:59:00'), /有效时间/, '北京时间已过去');
  }
  assert.throws(() => future(20260921), /有效时间/);
});

test('定时转账和计划步骤的无时区时间按北京时间归入业务日', async t => {
  clock(t, '2026-09-20T15:00:00.000Z'); const f = await setup(t), zone = process.env.TZ; process.env.TZ = 'UTC'; t.after(() => { if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone; });
  // 23:30 on the 20th in Beijing is still the 20th; read as UTC it would fall on the 21st there.
  const a = (await f.propose('propose_transfer', { recipient: f.recipient, amount: '10', scheduleAt: '2026-09-20T23:30:00' })).data;
  assert.equal(JSON.parse(f.services.owned(f.user, a.id).args).scheduleAt, '2026-09-20T15:30:00.000Z');
  assert.equal(a.decision.businessDate, '2026-09-20');
  const plan = (await f.propose('create_plan', { title: '时间', steps: [{ id: 'a', title: '转', tool: 'propose_transfer', args: { recipient: f.recipient, amount: '10' }, runAt: '2026-09-21 00:30:00' }, { id: 'b', title: '提醒', tool: 'set_reminder', args: { at: '2026-09-21 01:00', text: '记得' }, dependsOn: ['a'] }] })).data;
  const steps = JSON.parse(f.services.owned(f.user, plan.id).args).steps;
  assert.equal(steps[0].runAt, '2026-09-20T16:30:00.000Z'); assert.equal(steps[1].args.at, '2026-09-20T17:00:00.000Z');
  assert.deepEqual(plan.decision.dates, ['2026-09-21']);
});

test('计划内AA：链接指向步骤任务，收款人可打开，他人仍然404', async t => {
  clock(t); const f = await setup(t);
  const plan = (await f.propose('create_plan', { title: '聚餐', steps: [{ id: 'aa', title: 'AA', tool: 'propose_split', args: { total: '100', people: [f.recipient], note: '聚餐' } }] })).data;
  await f.call(`/agent/actions/${plan.id}/confirm`, { pin: '123456' }); t.mock.timers.tick(1000); f.scheduler.runDue();
  const url = JSON.parse(f.bank.get('SELECT result FROM scheduled_tasks WHERE action_id=?', plan.id).result).requests[0].url, [, id, index] = url.match(/pay-request\/([^/]+)\/(\d+)/);
  const opened = await f.req(`/agent/splits/${id}/${index}`, undefined, f.bob.token);
  assert.equal(opened.status, 200); assert.equal(opened.data.amount, '100.00'); assert.equal(opened.data.name, '林知夏'); assert.equal(opened.data.note, '聚餐');
  assert.equal((await f.call(`/agent/splits/${id}/${index}`)).status, 404);
  assert.equal((await f.req(`/agent/splits/${id}/9`, undefined, f.bob.token)).status, 404);
  const single = (await f.propose('propose_split', { total: '50', people: [f.recipient] })).data; await f.call(`/agent/actions/${single.id}/confirm`, { pin: '123456' });
  assert.equal((await f.req(`/agent/splits/${single.id}/0`, undefined, f.bob.token)).data.amount, '50.00');
});

test('页面操作不发助手通知也不记助手审计，未开通助手的用户同样如此', async t => {
  const f = await fixture(t, { enroll: false }), body = { type: 'payment', amount: '50', billType: 'water', billNumber: '10010001' };
  const tx = (await f.req('/transactions', body, f.alice.token, 'POST', { 'Idempotency-Key': randomUUID() })).data;
  assert.equal((await f.call(`/transactions/${tx.id}/confirm`, { pin: '123456' })).data.status, 'completed');
  assert.equal(notices(f, '智能助手操作完成'), 0); assert.equal(notices(f, '交易完成'), 1); assert.equal(notices(f, '操作完成'), 0);
  assert.equal(f.bank.get("SELECT COUNT(*) AS n FROM audit WHERE action='agent.action.completed'").n, 0);
  assert.equal(f.bank.get("SELECT COUNT(*) AS n FROM audit WHERE action='operation.completed'").n, 1);
  assert.equal(f.bank.get("SELECT COUNT(*) AS n FROM agent_security WHERE kind='action_success'").n, 0);
  assert.equal((await f.call(`/accounts/${f.services.accountFor(f.user).id}`, { status: 'frozen', pin: '123456' }, 'PATCH')).status, 200);
  assert.equal(notices(f, '操作完成'), 1); assert.equal(notices(f, '智能助手操作完成'), 0);
});

test('通知按动作来源：助手提议用助手文案，业务页提议用通用文案', async t => {
  const f = await setup(t);
  const fromRun = f.services.propose(f.user, 'propose_virtual_card', { limit: '100' }, { channel: 'app', sessionId: 'SESSIONchat', runId: 'RUNchat' });
  f.services.confirm(f.user, fromRun.id, { pin: '123456', verificationToken: undefined });
  assert.equal(notices(f, '智能助手操作完成'), 1); assert.equal(notices(f, '操作完成'), 0);
  const fromPage = (await f.propose('propose_virtual_card', { limit: '100' })).data;
  await f.call(`/agent/actions/${fromPage.id}/confirm`, { pin: '123456' });
  assert.equal(notices(f, '智能助手操作完成'), 1); assert.equal(notices(f, '操作完成'), 1);
  assert.equal(f.bank.get("SELECT COUNT(*) AS n FROM audit WHERE action='agent.action.completed'").n, 2);
});
