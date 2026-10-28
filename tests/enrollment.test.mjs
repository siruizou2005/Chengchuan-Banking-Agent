import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, llm } from './helpers.mjs';
import { wechatFixture } from './wechat-helpers.mjs';
import { AGREEMENTS } from '../server/agent/agreements.mjs';
import { IM_NOT_ENABLED_REPLY } from '../server/agent/enrollment.mjs';

const current = docs => docs.map(d => ({ id: d.id, version: d.version }));
const audits = (f, action) => f.bank.all('SELECT * FROM audit WHERE user_id=? AND action=? ORDER BY id', f.user.id, action).map(r => ({ ...r, detail: JSON.parse(r.detail) }));
function wav(seconds = 1) {
  const data = 32000 * seconds, buffer = Buffer.alloc(44 + data);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + data, 4); buffer.write('WAVE', 8);
  buffer.write('fmt ', 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(16000, 24); buffer.writeUInt32LE(32000, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(data, 40);
  return buffer;
}

test('未开通时对话、语音、渠道绑定都被拒绝且不调用模型；同意当前全部协议后可用，同意记录带版本与时间写入审计', async t => {
  let asrCalls = 0;
  const f = await fixture(t, { enroll: false, voice: { config: () => ({ apiKey: 'asr', baseUrl: 'https://asr.test/v1', model: 'asr' }), fetch: async () => { asrCalls++; return Response.json({ choices: [{ message: { content: '查余额' } }] }); } } });
  assert.equal((await f.call('/dashboard')).data.agent.status, 'not_enabled');
  const chat = await f.chat('查余额');
  assert.equal(chat.status, 403); assert.equal(chat.data.error.code, 'AGENT_NOT_ENABLED');
  assert.equal(f.requests.length, 0); assert.equal(f.bank.get('SELECT COUNT(*) n FROM agent_runs').n, 0);
  assert.equal((await f.call('/channels/code', { pin: '123456' })).data.error.code, 'AGENT_NOT_ENABLED');
  assert.throws(() => f.channels.router.createCode(f.user, '123456'), e => e.code === 'AGENT_NOT_ENABLED');
  const voice = await fetch(f.url + '/voice/transcribe', { method: 'POST', headers: { Authorization: `Bearer ${f.alice.token}`, 'Content-Type': 'audio/wav' }, body: wav() });
  assert.equal(voice.status, 403); assert.equal(asrCalls, 0);
  // Business pages keep working without the assistant.
  assert.equal((await f.propose('propose_set_daily_limit', { amount: '60000' })).status, 201);

  const status = (await f.call('/agent/enrollment')).data;
  assert.equal(status.status, 'not_enabled');
  assert.deepEqual(status.documents.map(d => d.title), ['智能助手服务协议', '个人信息处理授权书', '风险提示书']);
  assert.ok(status.documents.every(d => !d.body));
  const doc = (await f.call('/agent/agreements/privacy')).data;
  assert.equal(doc.version, '1.0'); assert.match(doc.body, /委托处理/);
  assert.equal((await f.call('/agent/agreements/unknown')).status, 404);

  assert.equal((await f.call('/agent/enrollment', { documents: current(status.documents).slice(1) })).data.error.code, 'AGREEMENT_VERSION_MISMATCH');
  assert.equal((await f.call('/agent/enrollment', { documents: current(status.documents).map(d => ({ ...d, version: '0.9' })) })).status, 409);
  assert.equal((await f.call('/agent/enrollment', { documents: 'all' })).status, 409);
  assert.equal(f.bank.get('SELECT COUNT(*) n FROM agent_consents').n, 0);

  const enabled = (await f.call('/agent/enrollment', { documents: current(status.documents) })).data;
  assert.equal(enabled.status, 'enabled'); assert.equal(enabled.onboarding, 'pending');
  assert.deepEqual(enabled.accepted.map(a => [a.id, a.version]), [['privacy', '1.0'], ['risk', '1.0'], ['service', '1.0']]);
  const [record] = audits(f, 'agent.enabled');
  assert.deepEqual(record.detail.documents.map(d => `${d.title}@${d.version}`), ['智能助手服务协议@1.0', '个人信息处理授权书@1.0', '风险提示书@1.0']);
  assert.equal(record.detail.acceptedAt, enabled.enabledAt);
  // Accepting again is a no-op rather than a second consent record.
  await f.call('/agent/enrollment', { documents: current(status.documents) });
  assert.equal(f.bank.get('SELECT COUNT(*) n FROM agent_consents WHERE user_id=?', f.user.id).n, 3);
  assert.equal(audits(f, 'agent.enabled').length, 1);

  f.queue.push(llm([], '你的余额已查询。'));
  assert.equal((await f.chat('查余额')).status, 200);
  assert.equal((await f.call('/dashboard')).data.agent.status, 'enabled');
  assert.ok((await f.call('/channels/code', { pin: '123456' })).data.code);
  assert.equal((await fetch(f.url + '/voice/transcribe', { method: 'POST', headers: { Authorization: `Bearer ${f.alice.token}`, 'Content-Type': 'audio/wav' }, body: wav() })).status, 200);
  // Bob's consent is his own.
  assert.equal((await f.req('/agent/enrollment', undefined, f.bob.token)).data.status, 'not_enabled');
});

test('协议升版本后需重新同意：对话与IM都暂停，重新同意后恢复，旧同意记录保留并标记撤销', async t => {
  const documents = AGREEMENTS.map(d => ({ ...d }));
  const f = await fixture(t, { agreements: documents });
  const binding = f.channels.router.bind('feishu', 'open-alice', f.channels.router.createCode(f.user, '123456').code);
  documents[2].version = '1.1';
  const status = (await f.call('/agent/enrollment')).data;
  assert.equal(status.status, 'reconsent_required');
  const chat = await f.chat('查余额');
  assert.equal(chat.status, 403); assert.match(chat.data.error.message, /协议已更新/);
  f.channels.feishuPipeline.ingest({ externalId: 'open-alice', messageId: 'after-update', text: '查余额' });
  const refused = f.bank.get("SELECT * FROM feishu_inbox WHERE message_id='after-update'");
  assert.equal(refused.status, 'failed'); assert.equal(JSON.parse(refused.result_json).text, IM_NOT_ENABLED_REPLY);
  assert.equal(f.bank.get('SELECT status FROM channel_bindings WHERE id=?', binding.id).status, 'active');
  assert.equal((await f.call('/agent/enrollment', { documents: current(status.documents) })).data.status, 'enabled');
  assert.deepEqual(f.bank.all('SELECT version FROM agent_consents WHERE user_id=? AND document=? ORDER BY accepted_at', f.user.id, 'risk').map(r => r.version), ['1.0', '1.1']);
  assert.equal(f.bank.get('SELECT COUNT(*) n FROM agent_consents WHERE user_id=? AND revoked_at IS NULL', f.user.id).n, 3);
  f.queue.push(llm([], '你的余额已查询。'));
  assert.equal((await f.chat('查余额')).status, 200);
});

test('关闭（只停用）：对话和IM停止受理，对话提出的未确认操作取消，业务页提议与已确认的定时转账照常，渠道与记忆保留', async t => {
  const f = await fixture(t);
  const binding = f.channels.router.bind('feishu', 'open-alice', f.channels.router.createCode(f.user, '123456').code);
  await f.call('/agent/memory', { key: 'answer_length', value: '简短' });
  const fromChat = f.services.propose(f.user, 'propose_transfer', { recipient: f.recipient, amount: '30' }, { channel: 'app', sessionId: 'SESSIONchat' });
  const fromIm = f.services.propose(f.user, 'propose_transfer', { recipient: f.recipient, amount: '40' }, { channel: 'feishu', sessionId: binding.id });
  const fromPage = (await f.propose('propose_set_daily_limit', { amount: '60000' })).data;
  const scheduled = f.services.propose(f.user, 'propose_transfer', { recipient: f.recipient, amount: '50', scheduleAt: new Date(Date.now() + 60000).toISOString() }, { channel: 'app', sessionId: 'SESSIONchat' });
  f.services.confirm(f.user, scheduled.id, { pin: '123456' });
  // Queued before closing, executed after (the pipeline starts on the next microtask): refused with the same reply as a new message.
  f.channels.feishuPipeline.ingest({ externalId: 'open-alice', messageId: 'queued', text: '查余额' });
  assert.equal(f.bank.get("SELECT status FROM feishu_inbox WHERE message_id='queued'").status, 'queued');
  const closed = f.services.enrollment.disable(f.user, {});
  assert.equal(closed.status, 'not_enabled');
  assert.equal(closed.cancelledActions, 2); assert.equal(closed.unboundChannels, 0);
  assert.equal(f.services.owned(f.user, fromChat.id).status, 'cancelled');
  assert.equal(f.services.owned(f.user, fromIm.id).status, 'cancelled');
  assert.equal(f.services.owned(f.user, fromPage.id).status, 'proposed');
  assert.equal(f.services.owned(f.user, scheduled.id).status, 'confirmed');
  assert.equal(f.bank.get('SELECT COUNT(*) n FROM agent_consents WHERE user_id=? AND revoked_at IS NULL', f.user.id).n, 0);
  assert.deepEqual(audits(f, 'agent.disabled').map(a => a.detail), [{ unbindChannels: false, clearData: false, cancelledActions: 2, unboundChannels: 0 }]);

  assert.equal((await f.chat('查余额')).data.error.code, 'AGENT_NOT_ENABLED');
  await f.channels.feishuPipeline.drain();
  assert.equal(JSON.parse(f.bank.get("SELECT result_json FROM feishu_inbox WHERE message_id='queued'").result_json).text, IM_NOT_ENABLED_REPLY);
  assert.equal(f.requests.length, 0);
  f.channels.feishuPipeline.ingest({ externalId: 'open-alice', messageId: 'after', text: '查余额' });
  assert.equal(JSON.parse(f.bank.get("SELECT result_json FROM feishu_inbox WHERE message_id='after'").result_json).text, IM_NOT_ENABLED_REPLY);
  // Cancelling by command still works while the assistant is closed.
  f.channels.feishuPipeline.ingest({ externalId: 'open-alice', messageId: 'cmd', text: '帮助' });
  assert.equal(f.bank.get("SELECT status FROM feishu_inbox WHERE message_id='cmd'").status, 'queued');

  f.scheduler.runDue(new Date(Date.now() + 120000).toISOString());
  assert.equal(f.services.owned(f.user, scheduled.id).status, 'completed');
  assert.equal(f.bank.get('SELECT status FROM channel_bindings WHERE id=?', binding.id).status, 'active');
  assert.equal((await f.call('/agent/memory')).data.profile.answer_length, '简短');
  assert.equal((await f.call('/agent/enrollment/disable', {})).status, 409);
});

test('关闭并解绑渠道、清空数据需支付密码；清空删除记忆与对话、重置引导，审计保留', async t => {
  const f = await wechatFixture(t);
  await f.bind();
  const feishu = f.channels.router.bind('feishu', 'open-alice', f.channels.router.createCode(f.user, '123456').code);
  await f.call('/agent/memory', { key: 'answer_length', value: '简短' });
  f.queue.push(llm([], '余额已查询。'));
  const session = (await f.chat('查余额')).data.sessionId;
  const auditCount = f.bank.get('SELECT COUNT(*) n FROM audit WHERE user_id=?', f.user.id).n;

  assert.equal((await f.call('/agent/enrollment/disable', { unbindChannels: true })).data.error.code, 'INVALID_PIN');
  assert.equal((await f.call('/agent/enrollment/disable', { clearData: true, pin: '000000' })).status, 403);
  assert.equal((await f.call('/agent/enrollment')).data.status, 'enabled');
  assert.equal((await f.call('/agent/enrollment/disable', { unbindChannels: 'yes', pin: '123456' })).status, 400);

  const closed = (await f.call('/agent/enrollment/disable', { unbindChannels: true, clearData: true, pin: '123456' })).data;
  assert.equal(closed.status, 'not_enabled'); assert.equal(closed.unboundChannels, 2); assert.equal(closed.onboarding, 'pending');
  assert.deepEqual(f.bank.all('SELECT status FROM channel_bindings WHERE user_id=?', f.user.id).map(r => r.status), ['revoked', 'revoked']);
  assert.equal(f.bank.get('SELECT status FROM channel_bindings WHERE id=?', feishu.id).status, 'revoked');
  const memory = (await f.call('/agent/memory')).data;
  assert.deepEqual(memory.profile, {}); assert.equal(memory.memories.length, 0);
  assert.equal((await f.call('/agent/sessions')).data.length, 0);
  assert.equal(f.bank.get('SELECT archived FROM agent_sessions WHERE id=?', session).archived, 1);
  assert.ok(f.bank.get('SELECT COUNT(*) n FROM audit WHERE user_id=?', f.user.id).n > auditCount);
  assert.equal(f.bank.get('SELECT COUNT(*) n FROM agent_runs WHERE user_id=?', f.user.id).n, 1);
  assert.deepEqual(audits(f, 'agent.disabled').at(-1).detail, { unbindChannels: true, clearData: true, cancelledActions: 0, unboundChannels: 2 });

  // Re-enabling needs a fresh consent and starts the guide again.
  const { documents } = (await f.call('/agent/enrollment')).data;
  const again = (await f.call('/agent/enrollment', { documents: current(documents) })).data;
  assert.equal(again.status, 'enabled'); assert.equal(again.onboarding, 'pending');
});

test('微信：关闭后新消息收到开通提示，不进入模型', async t => {
  const f = await wechatFixture(t);
  await f.bind();
  await f.call('/agent/enrollment/disable', {});
  await f.receive('查余额', 'closed-1');
  const row = f.bank.get("SELECT * FROM wechat_inbox WHERE upstream_message_id='closed-1'");
  assert.equal(row.status, 'failed'); assert.equal(JSON.parse(row.result_json).text, IM_NOT_ENABLED_REPLY);
  assert.equal(f.requests.length, 0);
});
