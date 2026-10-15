import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { requireThat } from './errors.mjs';
import { now } from './db.mjs';

export function createIdentityCrypto(secret = process.env.IDENTITY_ENCRYPTION_KEY) {
  const key = () => {
    requireThat(typeof secret === 'string' && /^[a-f\d]{64}$/i.test(secret), '实名信息服务未配置', 503, 'IDENTITY_KEY_REQUIRED');
    return Buffer.from(secret, 'hex');
  };
  return {
    assertConfigured: key,
    encrypt(value, context) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key(), iv);
      cipher.setAAD(Buffer.from(context));
      const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join('.');
    },
    decrypt(value, context) {
      const secretKey = key();
      try {
        const [version, iv, tag, data] = value.split('.');
        if (version !== 'v1') throw new Error();
        const cipher = createDecipheriv('aes-256-gcm', secretKey, Buffer.from(iv, 'base64'));
        cipher.setAAD(Buffer.from(context));
        cipher.setAuthTag(Buffer.from(tag, 'base64'));
        return Buffer.concat([cipher.update(Buffer.from(data, 'base64')), cipher.final()]).toString('utf8');
      } catch { requireThat(false, '实名信息暂不可用，请联系管理员', 503, 'IDENTITY_UNAVAILABLE'); }
    },
  };
}

export function normalizeIdentity(realName, idNumber) {
  requireThat(typeof realName === 'string' && /^[\p{Script=Han}·]{2,50}$/u.test(realName.trim()), '请输入正确的真实姓名', 400, 'INVALID_IDENTITY');
  requireThat(typeof idNumber === 'string', '请输入正确的18位身份证号', 400, 'INVALID_IDENTITY');
  const number = idNumber.trim().toUpperCase();
  requireThat(/^[1-9]\d{16}[\dX]$/.test(number), '请输入正确的18位身份证号', 400, 'INVALID_IDENTITY');
  const birth = `${number.slice(6,10)}-${number.slice(10,12)}-${number.slice(12,14)}`;
  const date = new Date(birth + 'T00:00:00.000Z');
  const weights = [7,9,10,5,8,4,2,1,6,3,7,9,10,5,8,4,2];
  const check = '10X98765432'[[...number.slice(0,17)].reduce((sum, digit, index) => sum + Number(digit) * weights[index], 0) % 11];
  requireThat(Number.isFinite(date.getTime()) && date.toISOString().slice(0,10) === birth && date.getTime() <= Date.now() && Number(number.slice(6,10)) >= 1900 && check === number[17], '身份证号校验失败，请检查后重试', 400, 'INVALID_IDENTITY');
  return { realName: realName.trim(), idNumber: number };
}

export function createIdentityStore(bank, crypto) {
  function view(user) {
    const row = bank.get('SELECT masked_name,masked_id,created_at FROM verification_identities WHERE user_id=?', user.id);
    return row ? { enrolled: true, maskedName: row.masked_name, maskedIdNumber: row.masked_id } : { enrolled: false };
  }
  function enroll(user, { realName, idNumber }) {
    const identity = normalizeIdentity(realName, idNumber);
    const ciphertext = crypto.encrypt(JSON.stringify(identity), `identity:${user.id}`);
    bank.atomic(() => {
      requireThat(!view(user).enrolled, '实名资料已录入，暂不支持自行修改', 409, 'IDENTITY_ALREADY_ENROLLED');
      bank.run('INSERT INTO verification_identities(user_id,identity_ciphertext,masked_name,masked_id,created_at) VALUES(?,?,?,?,?)', user.id, ciphertext, identity.realName[0] + '*'.repeat(identity.realName.length - 1), '*'.repeat(14) + identity.idNumber.slice(-4), now());
      bank.audit(user.id, 'verification.identity_enrolled');
    });
    return view(user);
  }
  function read(user) {
    const row = bank.get('SELECT identity_ciphertext FROM verification_identities WHERE user_id=?', user.id);
    requireThat(row, '请先录入实名资料', 403, 'IDENTITY_REQUIRED');
    return JSON.parse(crypto.decrypt(row.identity_ciphertext, `identity:${user.id}`));
  }
  return { view, enroll, read };
}
