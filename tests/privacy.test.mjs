import test from 'node:test';
import assert from 'node:assert/strict';
import { redactIdentity } from '../server/privacy.mjs';
import { id } from '../server/db.mjs';

test('身份证号被遮挡，生成的编号中偶然出现的18位数字不受影响', () => {
  assert.equal(redactIdentity('身份证号110101199003077777，请核对'), '身份证号**************7777，请核对');
  assert.equal(redactIdentity('11010119900307777X'), '**************777X');
  assert.equal(redactIdentity({ text: 'ID: 110101199003077777' }).text, 'ID: **************7777');
  // An 18-digit run inside a generated id used to be masked, so the client could not find the run again.
  assert.equal(redactIdentity('RUNab110101199003077777cd'), 'RUNab110101199003077777cd');
  for (let i = 0; i < 200000; i++) { const value = id('RUN'); assert.equal(redactIdentity(value), value); }
});
