// خادم وهمي يماثل عقود Supabase التي تلمسها رحلة الإدارة — للتحقق من منطق السكربت محليًا.
/* eslint-env node */
/* global URL, Buffer, console */
import { createServer } from 'node:http';

const users = new Map(); // phone -> { id, password, status, role }
const invites = new Map(); // token -> phone
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body === undefined ? '' : JSON.stringify(body));
};

const read = (req) =>
  new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const path = url.pathname;
  const body = req.method === 'POST' || req.method === 'PUT' ? await read(req) : {};

  // GoTrue
  if (path === '/auth/v1/admin/users' && req.method === 'GET') {
    if (url.searchParams.get('per_page')) {
      return json(res, 200, { users: Array.from(users.entries()).map(([phone, u]) => ({ id: u.id, phone })) });
    }
    return json(res, 200, { users: [] });
  }
  if (path === '/auth/v1/admin/users' && req.method === 'POST') {
    if (users.has(body.phone)) return json(res, 422, { code: 422, error_code: 'phone_exists', msg: 'exists' });
    const id = uuid();
    users.set(body.phone, { id, password: body.password, status: 'active', role: 'teacher' });
    return json(res, 200, { id, phone: body.phone });
  }
  if (path.startsWith('/auth/v1/admin/users/') && req.method === 'PUT') {
    const id = path.split('/').pop();
    for (const u of users.values()) if (u.id === id) u.password = body.password;
    return json(res, 200, {});
  }
  if (path.startsWith('/auth/v1/admin/users/') && path.endsWith('/logout')) return json(res, 204);
  if (path === '/auth/v1/token') {
    const u = users.get(String(body.phone ?? ''));
    if (!u || u.password !== body.password) return json(res, 400, { error: 'invalid_grant' });
    if (u.status !== 'active') return json(res, 400, { error: 'invalid_grant' });
    return json(res, 200, { access_token: `h.${Buffer.from(JSON.stringify({ sub: u.id, iat: Math.floor(Date.now() / 1000) })).toString('base64url')}.s`, user: { id: u.id } });
  }
  if (path === '/auth/v1/user') return json(res, 200, { id: uuid() });

  // RPC الخدمي
  if (path === '/rest/v1/rpc/svc_profile_context') {
    const id = body.p_user_id;
    const found = Array.from(users.values()).find((u) => u.id === id);
    return json(res, 200, found ? [{ user_id: id, role: found.role, status: found.status }] : []);
  }

  // PostgREST: الكتابة الأكاديمية بحساب الإدارة تُرفض
  if (path === '/rest/v1/groups') {
    if (req.method === 'POST') return json(res, 403, { code: '42501', message: 'new row violates row-level security policy' });
    return json(res, 200, []);
  }

  // الدوال
  if (path === '/functions/v1/auth-login') {
    const u = users.get(String(body.identifier ?? '').replace(/^\+/, ''));
    if (!u || u.password !== body.password || u.status !== 'active') {
      return json(res, 401, { ok: false, code: 'INVALID_CREDENTIALS' });
    }
    return json(res, 200, { ok: true, data: { access_token: `t.${u.id}`, profile: { user_id: u.id, role: u.role } } });
  }
  if (path === '/functions/v1/admin-teachers') {
    if (body.action === 'invite') {
      const token = `tok${Date.now().toString(36)}`;
      invites.set(token, String(body.phone).replace(/^\+/, ''));
      return json(res, 200, { ok: true, data: { invitation_id: uuid(), invite_link: `http://localhost:4173/pages/auth/invite.html?token=${token}` } });
    }
    if (body.action === 'set-status') {
      for (const u of users.values()) if (u.id === body.user_id) u.status = body.status;
      return json(res, 200, { ok: true, data: { user_id: body.user_id, status: body.status, changed: true } });
    }
    return json(res, 400, { ok: false, code: 'INVALID_INPUT' });
  }
  if (path === '/functions/v1/invite-accept') {
    const phone = invites.get(body.token);
    if (!phone) return json(res, 400, { ok: false, code: 'INVITATION_INVALID' });
    const normalized = String(body.identifier ?? '').replace(/^\+/, '');
    if (normalized !== phone) return json(res, 400, { ok: false, code: 'INVITATION_INVALID' });
    const id = uuid();
    users.set(normalized, { id, password: body.password, status: 'active', role: 'teacher' });
    invites.delete(body.token);
    return json(res, 200, { ok: true, data: { kind: 'teacher_invite', profile: { user_id: id, role: 'teacher' } } });
  }
  if (path === '/functions/v1/admin-instructions') {
    return json(res, 200, { ok: true, data: { recipients: (body.user_ids ?? []).length } });
  }

  return json(res, 404, { error: 'not found', path });
});

server.listen(8791, '127.0.0.1', () => console.log('mock ready on 8787'));
