import { useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { Verify } from './Verify';
import { formValues } from './api';
import { Modal, Notice, PinField } from './ui';
export type ApprovalProof = { pin: string; verificationToken?: string; verificationActionId?: string };
export function Approval({ actionId, title, submitting, onComplete, onCancel }: { actionId?: string; title: string; submitting: boolean; onComplete: (proof: ApprovalProof) => void; onCancel: () => void }) {
 const [token, setToken] = useState('');
 if (actionId && !token) return <Verify actionId={actionId} onVerified={setToken} onCancel={onCancel} />;
 return <Modal operation title="支付密码确认" onClose={() => { if (!submitting) onCancel(); }}><form className="stack-form" onSubmit={e => { const f = formValues(e); onComplete({ pin: f.pin, ...(actionId ? { verificationActionId: actionId, verificationToken: token } : {}) }); }}><Notice>{title}</Notice><PinField /><button className="btn-primary" disabled={submitting}>{submitting && <LoaderCircle size={18} className="spin" />}确认执行</button></form></Modal>;
}
