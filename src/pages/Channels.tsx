import { FeishuRequests } from './FeishuRequests';
import { useEffect, useState } from 'react';
import { WeChatChannel } from './WeChatChannel';
import { ChannelAmountSetting } from './ChannelAmountSetting';
import { ChannelReportSetting } from './ChannelReportSetting';
import { useFeishuBot } from './channelConnect';
import { api, formValues, date } from '../api';
import { useBank } from '../bank';
import { Card, Empty, InlineError, Notice, PinField } from '../ui';
export function Channels() {
 const { data, refresh, navigate } = useBank();
 // Binding needs an open assistant; existing bindings stay visible so they can still be unbound.
 const closed = Boolean(data.agent && data.agent.status !== 'enabled');
 const [code, setCode] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
 const feishu = useFeishuBot(refresh), { bot, status: botStatus } = feishu;
 const [enabled, setEnabled] = useState({ feishu: false, feishuPersonal: false, wechat: false });
 const hasBot = data.bindings.some(b => b.personal && b.status === 'active');
 useEffect(() => { api('/chat/status').then(s => setEnabled(s.channels)).catch(e => setError(e.message)); }, []);
 async function bind(_channel: string, pin: string) { setBusy(true); setError(''); try { const result = await api('/channels/code', 'POST', { pin }); setCode(result.code); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
 async function createBot(pin: string) { setBusy(true); setError(''); try { await feishu.start(pin); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
 return <div className="page"><Notice>绑定后可在私聊中查询账户、提议业务。为保障资金安全，所有操作都需回App确认：需授权确认的输入支付密码，需加强验证的还需人脸模拟和短信验证码；私聊中只能取消。绑定不会自动授权任何操作。</Notice>{closed && <div className="notice channel-closed"><span>智能助手{data.agent?.status === 'reconsent_required' ? '协议已更新，重新同意后' : '尚未开通或已关闭，开通后'}才能绑定和使用飞书、微信。</span><button className="pill small primary" onClick={() => navigate('assistant')}>去开通</button></div>}<Card title="飞书机器人"><ChannelAmountSetting channel="feishu" /><ChannelReportSetting channel="feishu" />{hasBot ? <p className="body-copy">已绑定你的飞书专属机器人，可在飞书与它私聊。</p> : <form className="stack-form form-card" onSubmit={e => { const f = formValues(e); void createBot(f.pin); }}><p>一键在你的飞书里创建一个只属于你的银行助手，扫码确认后自动绑定，无需绑定码。</p>{!enabled.feishuPersonal && <Notice>飞书专属机器人尚未开启。</Notice>}<PinField /><button className="btn-primary" disabled={busy || closed || !enabled.feishuPersonal || Boolean(bot)}>一键创建我的飞书机器人</button></form>}{bot && <div className="channel-qr"><img src={bot.image} width="260" height="260" alt="飞书专属机器人创建二维码" /><p><a className="btn-text" href={bot.url} target="_blank" rel="noreferrer">在飞书中打开</a></p><p role="status">{botStatus}</p></div>}{!bot && botStatus && <p className="body-copy">{botStatus}</p>}<p className="data-note">机器人建在你自己的飞书里，只响应你本人的消息；银行只加密保存它的收发凭据。可随时在下方解绑，解绑后可在飞书开发者后台删除该应用。</p>{enabled.feishu && <form className="stack-form form-card" onSubmit={e => { const f = formValues(e); void bind('feishu', f.pin); }}><p>银行飞书组织成员也可与银行机器人私聊，发送下方一次性绑定码。</p><PinField /><button className="pill" disabled={busy || closed}>生成5分钟绑定码</button>{code && <div className="binding-code"><strong>{code}</strong><span>在飞书发送：绑定 {code}</span></div>}</form>}</Card><FeishuRequests /><WeChatChannel enabled={enabled.wechat} closed={closed} /><Card title="已绑定渠道">{data.bindings.length === 0 && <Empty title="尚未绑定消息渠道" />}{data.bindings.map(b => <div className="form-card" key={b.id}><p><strong>{b.channel === 'feishu' ? (b.personal ? '飞书 · 专属机器人' : '飞书') : '微信'}</strong> · {({ active: b.personal && !b.live ? '已绑定 · 等待飞书生效' : '已绑定', revoked: '已解绑', expired: '登录已失效' } as Record<string, string>)[b.status]} · {date(b.created_at)}</p>{b.personal && b.status === 'active' && !b.live && <p className="data-note">在飞书给机器人发一句话即可完成生效。长时间没有回复，可能是公司飞书需要管理员审批该应用的新版本，请联系管理员审批，或解绑后改用个人飞书账号重新创建。</p>}{b.status !== 'revoked' && <form className="stack-form" onSubmit={async e => { const f = formValues(e); setBusy(true); setError(''); try { await api(`/channels/${b.id}/unbind`, 'POST', f); await refresh(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); } }}><PinField /><button className="pill" disabled={busy}>解绑并撤销未执行操作</button></form>}</div>)}</Card><InlineError message={error} /></div>;
}
