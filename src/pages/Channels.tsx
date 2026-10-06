import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api, ApiError, formValues, date } from '../api';
import { useBank } from '../bank';
import { Card, Empty, InlineError, Notice, PinField } from '../ui';
const FEISHU_STATUS: Record<string, string> = { wait: '请用飞书扫码，并在飞书里确认创建', confirmed: '创建成功，已自动绑定。去飞书里和它打个招呼吧', denied: '你已取消创建', expired: '二维码已过期，请重新生成', failed: '创建失败，请稍后重试' };
export function Channels() {
 const { data, refresh } = useBank();
 const [code, setCode] = useState(''), [qr, setQr] = useState<{ id: string; image: string } | null>(null), [status, setStatus] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
 const [bot, setBot] = useState<{ id: string; image: string; url: string } | null>(null), [botStatus, setBotStatus] = useState('');
 const [enabled, setEnabled] = useState({ feishu: false, feishuPersonal: false, wechat: false });
 const hasBot = data.bindings.some(b => b.personal && b.status === 'active');
 useEffect(() => { api('/chat/status').then(s => setEnabled(s.channels)).catch(e => setError(e.message)); }, []);
 useEffect(() => {
  if (!qr) return; let cancelled = false; let timer: ReturnType<typeof setTimeout>;
  async function poll() { try { const result = await api(`/channels/wechat/qr/${qr!.id}`); if (cancelled) return; setStatus(({ wait: '等待扫码', scaned: '已扫码，请在微信确认', confirmed: '绑定成功', expired: '二维码已过期' } as Record<string, string>)[result.status] || result.status); if (result.status === 'confirmed') { await refresh(); setQr(null); return; } if (result.status === 'expired') return; } catch (e) { if (!cancelled) { setError((e as Error).message); return; } } if (!cancelled) timer = setTimeout(poll, 1000); }
  void poll(); return () => { cancelled = true; clearTimeout(timer); };
 }, [qr, refresh]);
 // Polls only while the page is visible; switching to the Feishu app pauses it and coming back resumes at once.
 useEffect(() => {
  if (!bot) return; let cancelled = false, running = false; let timer: ReturnType<typeof setTimeout> | undefined;
  async function poll() {
   timer = undefined; if (cancelled || running || document.hidden) return; running = true;
   try { const result = await api(`/channels/feishu/register/${bot!.id}`); if (cancelled) return; setBotStatus(result.status === 'failed' ? result.error || FEISHU_STATUS.failed : FEISHU_STATUS[result.status] || result.status); if (result.status === 'confirmed') await refresh(); if (result.status !== 'wait') { setBot(null); return; } }
   catch (e) { if (cancelled) return; if (e instanceof ApiError && e.status === 404) { setBotStatus(FEISHU_STATUS.expired); setBot(null); return; } }
   finally { running = false; }
   if (!cancelled) timer = setTimeout(poll, 3000);
  }
  const resume = () => { if (!document.hidden && !timer) void poll(); };
  document.addEventListener('visibilitychange', resume); void poll();
  return () => { cancelled = true; clearTimeout(timer); document.removeEventListener('visibilitychange', resume); };
 }, [bot, refresh]);
 async function bind(channel: string, pin: string) { setBusy(true); setError(''); try { if (channel === 'feishu') { const result = await api('/channels/code', 'POST', { pin }); setCode(result.code); } else { const result = await api('/channels/wechat/qr', 'POST', { pin }); setQr({ id: result.id, image: await QRCode.toDataURL(result.qrcode_img_content, { width: 260, margin: 2 }) }); setStatus('等待扫码'); } } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
 async function createBot(pin: string) { setBusy(true); setError(''); try { const result = await api('/channels/feishu/register', 'POST', { pin }); setBot({ id: result.id, url: result.url, image: await QRCode.toDataURL(result.url, { width: 260, margin: 2 }) }); setBotStatus(FEISHU_STATUS.wait); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
 return <div className="page"><Notice>绑定后可在私聊中查询账户、提议业务。为保障资金安全，所有操作都需回App确认：需授权确认的输入支付密码，需加强验证的还需人脸模拟和短信验证码；私聊中只能取消。绑定不会自动授权任何操作。</Notice><Card title="飞书机器人">{hasBot ? <p className="body-copy">已绑定你的飞书专属机器人，可在飞书与它私聊。</p> : <form className="stack-form form-card" onSubmit={e => { const f = formValues(e); void createBot(f.pin); }}><p>一键在你的飞书里创建一个只属于你的银行助手，扫码确认后自动绑定，无需绑定码。</p>{!enabled.feishuPersonal && <Notice>飞书专属机器人尚未开启。</Notice>}<PinField /><button className="btn-primary" disabled={busy || !enabled.feishuPersonal || Boolean(bot)}>一键创建我的飞书机器人</button></form>}{bot && <div className="channel-qr"><img src={bot.image} width="260" height="260" alt="飞书专属机器人创建二维码" /><p><a className="btn-text" href={bot.url} target="_blank" rel="noreferrer">在飞书中打开</a></p><p role="status">{botStatus}</p></div>}{!bot && botStatus && <p className="body-copy">{botStatus}</p>}<p className="data-note">机器人建在你自己的飞书里，只响应你本人的消息；银行只加密保存它的收发凭据。可随时在下方解绑，解绑后可在飞书开发者后台删除该应用。</p>{enabled.feishu && <form className="stack-form form-card" onSubmit={e => { const f = formValues(e); void bind('feishu', f.pin); }}><p>银行飞书组织成员也可与银行机器人私聊，发送下方一次性绑定码。</p><PinField /><button className="pill" disabled={busy}>生成5分钟绑定码</button>{code && <div className="binding-code"><strong>{code}</strong><span>在飞书发送：绑定 {code}</span></div>}</form>}</Card><Card title="微信 ClawBot"><form className="stack-form form-card" onSubmit={e => { const f = formValues(e); void bind('wechat', f.pin); }}><p>直接连接 iLink。请使用支持 ClawBot 插件的微信扫码。</p>{!enabled.wechat && <Notice>微信渠道尚未开启。</Notice>}<PinField /><button className="btn-primary" disabled={busy || !enabled.wechat}>生成微信绑定二维码</button></form>{qr && <div className="channel-qr"><img src={qr.image} width="260" height="260" alt="微信ClawBot绑定二维码" /><p role="status">{status}</p></div>}{!qr && status && <p className="body-copy">{status}</p>}</Card><Card title="已绑定渠道">{data.bindings.length === 0 && <Empty title="尚未绑定消息渠道" />}{data.bindings.map(b => <div className="form-card" key={b.id}><p><strong>{b.channel === 'feishu' ? (b.personal ? '飞书 · 专属机器人' : '飞书') : '微信'}</strong> · {({ active: b.personal && !b.live ? '已绑定 · 等待飞书生效' : '已绑定', revoked: '已解绑', expired: '登录已失效' } as Record<string, string>)[b.status]} · {date(b.created_at)}</p>{b.personal && b.status === 'active' && !b.live && <p className="data-note">在飞书给机器人发一句话即可完成生效。长时间没有回复，可能是公司飞书需要管理员审批该应用的新版本，请联系管理员审批，或解绑后改用个人飞书账号重新创建。</p>}{b.status !== 'revoked' && <form className="stack-form" onSubmit={async e => { const f = formValues(e); setBusy(true); setError(''); try { await api(`/channels/${b.id}/unbind`, 'POST', f); await refresh(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); } }}><PinField /><button className="pill" disabled={busy}>解绑并撤销未执行操作</button></form>}</div>)}</Card><InlineError message={error} /></div>;
}
