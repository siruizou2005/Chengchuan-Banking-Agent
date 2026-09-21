import { useState } from 'react';
import { Verify } from './Verify';
import { formValues } from './api';
import { Modal, Notice, PinField } from './ui';
export type ApprovalProof = { pin: string; verificationToken?: string; verificationActionId?: string };
export function Approval({ actionId, title, onComplete, onCancel }: { actionId?: string; title: string; onComplete: (proof: ApprovalProof) => void; onCancel: () => void }) {
 const [token, setToken] = useState('');
 if (actionId && !token) return <Verify actionId={actionId} onVerified={setToken} onCancel={onCancel} />;
 return <Modal title="支付密码确认" onClose={onCancel}><form className="stack-form" onSubmit={e => { const f = formValues(e); onComplete({ pin: f.pin, ...(actionId ? { verificationActionId: actionId, verificationToken: token } : {}) }); }}><Notice>{title}</Notice><PinField /><button className="btn-primary">确认执行</button></form></Modal>;
}
