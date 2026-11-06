import assert from 'node:assert/strict';
import test from 'node:test';

import { requireSession } from '../../supabase/functions/_shared/auth.js';

/** JWT وهمي بالشكل الذي يُنتجه GoTrue: three parts + iat حدبث. */
function fakeJwt(iat = Math.floor(Date.now() / 1000)) {
  const payload = Buffer.from(JSON.stringify({ sub: 'u1', iat })).toString('base64url');
  return `header.${payload}.signature`;
}

const dbWith = (getUser) => ({ auth: { getUser } });

test('requireSession يقبل شكل GoTrue الحقيقي (المستخدم في الجذر)', async () => {
  const db = dbWith(() => ({ data: { id: 'user-1' }, error: null }));
  const session = await requireSession(db, fakeJwt());
  assert.equal(session.userId, 'user-1');
});

test('requireSession يقبل الشكل المتداخل الدفاعي { user: { id } }', async () => {
  const db = dbWith(() => ({ data: { user: { id: 'user-2' } }, error: null }));
  const session = await requireSession(db, fakeJwt());
  assert.equal(session.userId, 'user-2');
});

test('requireSession يرفض رفضًا صريحًا عندما لا يُعيد GoTrue هوية', async () => {
  const db = dbWith(() => ({ data: {}, error: null }));
  await assert.rejects(() => requireSession(db, fakeJwt()), (error) => {
    assert.equal(error.code, 'INVALID_SESSION');
    assert.equal(error.status, 401);
    return true;
  });
});

test('requireSession يرفض جلسة أقدم من الحد المسموح', async () => {
  const db = dbWith(() => ({ data: { id: 'user-3' }, error: null }));
  const old = Math.floor(Date.now() / 1000) - 7200;
  await assert.rejects(() => requireSession(db, fakeJwt(old)), (error) => {
    assert.equal(error.code, 'INVALID_SESSION');
    return true;
  });
});
