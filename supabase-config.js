// =============================================================
// Supabase 연결 설정
// =============================================================
// Supabase Dashboard → Project Settings → API 에서 복사
//
// ⚠️ anon key는 공개되어도 안전합니다 (RLS + RPC로 보호).
//    단, service_role key는 절대 여기에 넣지 마세요.
// =============================================================

const SUPABASE_URL      = 'https://mxbyidpgetaxpenganwp.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im14YnlpZHBnZXRheHBlbmdhbndwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk0MzE1MzQsImV4cCI6MjA5NTAwNzUzNH0.ofO8DZeMDIaG17nMAUCZiT9Em1ZB4CqgRW2p0sJSieI';

// 배포 후 도메인 (final URL 표시용). 로컬 테스트 중엔 빈 문자열로.
const SITE_BASE_URL = '';

// ─────────────────────────────────────────────────────────────
// 공용 RPC 호출 헬퍼
// ─────────────────────────────────────────────────────────────
async function callRpc(funcName, args) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${funcName}`, {
    method: 'POST',
    headers: {
      'apikey':        SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; }
  catch { data = text; }
  if (!res.ok) {
    const msg = (data && data.message) ? data.message : (typeof data === 'string' ? data : JSON.stringify(data));
    throw new Error(`[${res.status}] ${msg}`);
  }
  return data;
}

function buildUserUrl(slug) {
  return `${SITE_BASE_URL}/index.html#${slug}`;
}
