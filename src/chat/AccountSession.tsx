import { useRef, useState } from 'react';
import { LogOut, UserRound } from 'lucide-react';
import { api } from '../api';
import type { User } from '../types';

export function AccountSession({ user, loading, onChange }: { user: User | null; loading: boolean; onChange: (user: User | null) => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const lock = useRef(false);
  async function login(phone: string, password: string) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try { const result = await api<{ user: User }>('/auth/login', 'POST', { phone, password }); onChange(result.user); }
    catch (failure) { setError((failure as Error).message); }
    finally { lock.current = false; setBusy(false); }
  }
  async function logout() {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try { await api('/auth/logout', 'POST', {}); onChange(null); }
    catch (failure) { setError((failure as Error).message); }
    finally { lock.current = false; setBusy(false); }
  }
  if (loading) return <div className="session-panel">正在连接模拟银行…</div>;
  return <section className={`session-panel${user ? ' signed-in' : ''}`} aria-label="模拟银行账户">
    {user ? <><div className="session-name"><UserRound size={17} /><strong>{user.name}</strong><span>资料已连接 · 本地模拟账户</span></div><button onClick={logout} disabled={busy} aria-label="切换账户"><LogOut size={15} />切换账户</button></> : <>
      <h2>连接你的模拟账户</h2><p>登录后，助手会结合你的资料和最新账户数据回答。</p>
      <div className="demo-accounts"><button disabled={busy} onClick={() => void login('13800138000', 'Bank123456')}>林知夏<span>演示账户</span></button><button disabled={busy} onClick={() => void login('13900139000', 'Bank123456')}>陈屿<span>演示账户</span></button></div>
      <details><summary>使用其他模拟账户</summary><form onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); void login(String(data.get('phone')), String(data.get('password'))); }}>
        <label>手机号<input name="phone" type="tel" autoComplete="username" required pattern="1[0-9]{10}" /></label>
        <label>登录密码<input name="password" type="password" autoComplete="current-password" required minLength={8} maxLength={72} /></label>
        <button type="submit" disabled={busy}>登录</button>
      </form></details>
      <p className="session-disclosure">对话和脱敏的模拟账户资料将发送至配置的 AI 服务，用于生成回复。</p>
    </>}
    {error && <p className="session-error" role="alert">{error}</p>}
  </section>;
}
