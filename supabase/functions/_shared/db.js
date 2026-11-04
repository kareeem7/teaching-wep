/**
 * طبقة الوصول إلى Supabase من داخل Edge Functions.
 *
 * قواعد أمنية:
 *  ١. مفتاح `service_role` يعيش في متغيرات بيئة الدالة فقط، ولا يُعاد إلى المتصفح ولا يُسجَّل.
 *  ٢. كل استعلام يمرّ عبر PostgREST/Auth REST — لا SQL نصي يُبنى بالسلاسل هنا.
 *  ٣. مهلة زمنية لكل نداء، ولا إعادة محاولة تلقائية لعمليات الكتابة (تمنع التكرار).
 */
import { apiError } from './errors.js';

/** قراءة متغير بيئة من كائن يُمرَّر صريحًا (Deno.env أو process.env في الاختبارات). */
export function readEnv(env, name) {
  if (!env) return undefined;
  if (typeof env.get === 'function') {
    const value = env.get(name);
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }
  const value = env[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** متغير إلزامي: غيابه يعني أن الخدمة غير مهيأة، لا خطأ داخلي غامض. */
export function requireEnv(env, name) {
  const value = readEnv(env, name);
  if (!value) throw apiError('SERVICE_NOT_CONFIGURED', { details: name });
  return value;
}

/** يبني عنوان REST بلا تكرار الشرطة المائلة. */
export function buildUrl(baseUrl, path, query) {
  const base = String(baseUrl).replace(/\/+$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(`${base}${suffix}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/** يمنع تسريب المفتاح في أي رسالة خطأ. */
export function scrubKey(text, key) {
  const value = String(text ?? '');
  if (!key) return value;
  return value.split(key).join('[محجوب]');
}

/**
 * عميل مصغّر. كل الدوال ترجع `{data, error}` ولا ترمي إلا عند خطأ نقل/مهلة.
 * @param {{baseUrl: string, serviceRoleKey: string, fetchImpl?: typeof fetch, timeoutMs?: number}} options
 */
export function createDb(options) {
  const { baseUrl, serviceRoleKey } = options;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 8000;

  function baseHeaders(extra = {}) {
    return {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      'content-type': 'application/json',
      ...extra,
    };
  }

  async function request(path, { method = 'GET', query, body, headers = {}, prefer } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(buildUrl(baseUrl, path, query), {
        method,
        headers: { ...baseHeaders(prefer ? { prefer } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      const parsed = text.length > 0 ? JSON.parse(text) : null;
      if (!response.ok) return { data: null, error: { status: response.status, body: parsed } };
      return { data: parsed, error: null };
    } catch (error) {
      const message = error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'network';
      throw apiError('UPSTREAM_UNAVAILABLE', { details: message });
    } finally {
      clearTimeout(timer);
    }
  }

  function rest(table, query) {
    return `/rest/v1/${table}${query ? `?${query}` : ''}`;
  }

  return {
    request,

    /** استدعاء دالة SQL في المخطط `app` غير المكشوف. */
    rpc(name, args = {}) {
      return request(`/rest/v1/rpc/${name}`, { method: 'POST', body: args });
    },

    /** قراءة صفوف بمرشّحات PostgREST الجاهزة مثل `{ 'phone_e164': 'eq.+20…' }`. */
    select(table, { columns = '*', filters = {}, limit } = {}) {
      const query = new URLSearchParams({ select: columns });
      for (const [key, value] of Object.entries(filters)) query.set(key, value);
      if (limit) query.set('limit', String(limit));
      return request(`/rest/v1/${table}?${query.toString()}`);
    },

    /** إدراج صفوف وإرجاعها. */
    insert(table, rows, { onConflict } = {}) {
      const query = new URLSearchParams({ select: '*' });
      if (onConflict) query.set('on_conflict', onConflict);
      return request(rest(table, query.toString()), {
        method: 'POST',
        body: rows,
        prefer: onConflict ? 'return=representation,resolution=merge-duplicates' : 'return=representation',
      });
    },

    /** تحديث صفوف بمرشّح إلزامي — لا تحديث جدول كامل بالخطأ. */
    update(table, filters, patch) {
      if (!filters || Object.keys(filters).length === 0) {
        throw new Error('update بلا مرشّح مرفوض');
      }
      const query = new URLSearchParams({ select: '*' });
      for (const [key, value] of Object.entries(filters)) query.set(key, value);
      return request(rest(table, query.toString()), {
        method: 'PATCH',
        body: patch,
        prefer: 'return=representation',
      });
    },

    /** واجهات Auth الإدارية — تحتاج service_role، ولا تُستدعى من المتصفح. */
    auth: {
      signInWithPassword({ phone, password }) {
        return request('/auth/v1/token', {
          method: 'POST',
          query: { grant_type: 'password' },
          body: { phone, password },
        });
      },
      createUser({ phone, password, code, fullName, role }) {
        const body = { phone, password, phone_confirm: true, email_confirm: true };
        body.user_metadata = { full_name: fullName ?? null, role: role ?? null, student_code: code ?? null };
        return request('/auth/v1/admin/users', { method: 'POST', body });
      },
      setPassword(userId, password) {
        return request(`/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
          method: 'PUT',
          body: { password },
        });
      },
      signOutGlobal(userId) {
        return request(`/auth/v1/admin/users/${encodeURIComponent(userId)}/logout`, {
          method: 'POST',
          query: { scope: 'global' },
        });
      },
      getUser(accessToken) {
        return request('/auth/v1/user', {
          headers: { authorization: `Bearer ${accessToken}` },
        });
      },
    },
  };
}
