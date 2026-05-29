-- =============================================================
-- 다중 사용자 서비스 초기 스키마 (Phase 2)
-- 대상: Supabase (Postgres 15+)
-- 적용 방법: Supabase Dashboard → SQL Editor → 전체 복사 후 실행
-- 작성일: 2026-05-28
-- 관련 문서: md/다중사용자_계획.md
-- =============================================================

-- -------------------------------------------------------------
-- 0. 필수 익스텐션
-- -------------------------------------------------------------
create extension if not exists pgcrypto;  -- gen_random_bytes, crypt, gen_salt

-- -------------------------------------------------------------
-- 1. 테이블
-- -------------------------------------------------------------
create table if not exists users (
  id              uuid primary key default gen_random_uuid(),
  naver_id        text,
  nickname        text,
  url_slug        text unique not null,        -- 'jiwon-x7n2p9'
  email           text,                        -- Phase 3 매직링크 대비, nullable
  status          text not null default 'active',  -- 'active' | 'suspended'
  created_at      timestamptz not null default now(),
  last_seen_at    timestamptz
);

create index if not exists users_naver_nick_idx
  on users (naver_id, nickname);

create table if not exists point_events (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  bucket       text,                           -- 'limited' | 'daily' | 'monthly'
  activity_id  text,
  occurred_at  date,
  point        int not null,
  created_at   timestamptz not null default now()
);

create index if not exists point_events_user_date_idx
  on point_events (user_id, occurred_at);

-- 관리자 비번 (단일 행)
create table if not exists admin_secrets (
  id             int primary key default 1,
  password_hash  text not null,
  constraint admin_secrets_single_row check (id = 1)
);

-- -------------------------------------------------------------
-- 2. RLS 잠금 (anon은 RPC 외에 아무것도 못 함)
-- -------------------------------------------------------------
revoke all on users          from anon;
revoke all on point_events   from anon;
revoke all on admin_secrets  from anon, authenticated;

alter table users          enable row level security;
alter table point_events   enable row level security;
alter table admin_secrets  enable row level security;
-- 정책을 하나도 안 만들면 = 전부 차단 (의도된 상태)

-- -------------------------------------------------------------
-- 3. 헬퍼: 6자 base36 보안 코드 생성
--    36^6 = 21억 조합 (충분)
-- -------------------------------------------------------------
create or replace function gen_url_suffix()
returns text
language plpgsql
set search_path = public, extensions
as $$
declare
  v_chars  text := 'abcdefghijklmnopqrstuvwxyz0123456789';
  v_bytes  bytea;
  v_result text := '';
  i        int;
begin
  v_bytes := gen_random_bytes(6);
  for i in 0..5 loop
    v_result := v_result || substr(v_chars, (get_byte(v_bytes, i) % 36) + 1, 1);
  end loop;
  return v_result;
end;
$$;

-- -------------------------------------------------------------
-- 4. RPC: 사용자가 자기 데이터 읽기
--    return: { nickname, events: [...] }
-- -------------------------------------------------------------
create or replace function get_my_data(p_slug text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id  uuid;
  v_nickname text;
  v_events   jsonb;
begin
  select id, nickname into v_user_id, v_nickname
    from users
    where url_slug = p_slug and status = 'active';

  if v_user_id is null then
    raise exception 'not found' using errcode = 'P0002';
  end if;

  update users set last_seen_at = now() where id = v_user_id;

  select coalesce(jsonb_agg(to_jsonb(pe) - 'user_id' order by pe.occurred_at), '[]'::jsonb)
    into v_events
    from point_events pe
    where pe.user_id = v_user_id;

  return jsonb_build_object(
    'nickname', v_nickname,
    'events',   v_events
  );
end;
$$;

grant execute on function get_my_data(text) to anon;

-- -------------------------------------------------------------
-- 5. RPC: 포인트 이벤트 추가
--    return: 생성된 event id
-- -------------------------------------------------------------
create or replace function add_point_event(
  p_slug         text,
  p_bucket       text,
  p_activity_id  text,
  p_occurred_at  date,
  p_point        int
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id  uuid;
  v_event_id uuid;
begin
  select id into v_user_id from users
    where url_slug = p_slug and status = 'active';

  if v_user_id is null then
    raise exception 'not found' using errcode = 'P0002';
  end if;

  insert into point_events (user_id, bucket, activity_id, occurred_at, point)
    values (v_user_id, p_bucket, p_activity_id, p_occurred_at, p_point)
    returning id into v_event_id;

  return v_event_id;
end;
$$;

grant execute on function add_point_event(text, text, text, date, int) to anon;

-- -------------------------------------------------------------
-- 6. RPC: 포인트 이벤트 삭제 (본인 것만)
-- -------------------------------------------------------------
create or replace function delete_point_event(
  p_slug      text,
  p_event_id  uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id  uuid;
  v_deleted  int;
begin
  select id into v_user_id from users
    where url_slug = p_slug and status = 'active';

  if v_user_id is null then
    raise exception 'not found' using errcode = 'P0002';
  end if;

  delete from point_events
    where id = p_event_id and user_id = v_user_id;

  get diagnostics v_deleted = row_count;
  return v_deleted > 0;
end;
$$;

grant execute on function delete_point_event(text, uuid) to anon;

-- -------------------------------------------------------------
-- 7. RPC: "내 URL 찾기" (naver_id + nickname 둘 다 일치)
--    둘 다 일치하는 행이 정확히 1개일 때만 url_slug 반환
-- -------------------------------------------------------------
create or replace function find_my_url(
  p_naver_id  text,
  p_nickname  text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_slug text;
  v_count int;
begin
  if p_naver_id is null or p_nickname is null
     or length(trim(p_naver_id)) = 0 or length(trim(p_nickname)) = 0 then
    raise exception 'naver_id and nickname required' using errcode = '22023';
  end if;

  select count(*), max(url_slug)
    into v_count, v_slug
    from users
    where naver_id = p_naver_id
      and nickname = p_nickname
      and status = 'active';

  if v_count = 0 then
    raise exception 'not found' using errcode = 'P0002';
  elsif v_count > 1 then
    -- 동일 (naver_id, nickname) 다중 매칭 — 안전하게 거부
    raise exception 'ambiguous' using errcode = 'P0003';
  end if;

  return v_slug;
end;
$$;

grant execute on function find_my_url(text, text) to anon;

-- -------------------------------------------------------------
-- 8. RPC: 관리자 일괄 사용자 생성
--    p_admin_key: admin_secrets와 매칭 검증
--    p_rows: [{slug, nickname, naver_id}, ...]
--    return: [{input, status, final_slug?, message?}, ...]
-- -------------------------------------------------------------
create or replace function admin_bulk_create_users(
  p_admin_key  text,
  p_rows       jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_stored_hash text;
  v_row         jsonb;
  v_results     jsonb := '[]'::jsonb;
  v_slug        text;
  v_final_slug  text;
  v_inserted    boolean;
  v_attempts    int;
begin
  -- 관리자 비번 검증
  select password_hash into v_stored_hash from admin_secrets where id = 1;
  if v_stored_hash is null
     or crypt(p_admin_key, v_stored_hash) <> v_stored_hash then
    raise exception 'unauthorized' using errcode = '28000';
  end if;

  -- 각 행 처리
  for v_row in select * from jsonb_array_elements(p_rows) loop
    v_slug := lower(trim(coalesce(v_row->>'slug', '')));

    -- 슬러그 형식 검증
    if v_slug !~ '^[a-z0-9-]{2,20}$' then
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'input',   v_row->>'slug',
        'status',  'error',
        'message', 'invalid slug format'
      ));
      continue;
    end if;

    -- 보안코드 부착 (충돌 시 최대 5회 재시도)
    v_inserted := false;
    for v_attempts in 1..5 loop
      v_final_slug := v_slug || '-' || gen_url_suffix();
      begin
        insert into users (url_slug, nickname, naver_id)
          values (
            v_final_slug,
            nullif(trim(coalesce(v_row->>'nickname', '')), ''),
            nullif(trim(coalesce(v_row->>'naver_id', '')), '')
          );
        v_inserted := true;
        exit;
      exception when unique_violation then
        -- 다음 시도
      end;
    end loop;

    if v_inserted then
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'input',      v_row->>'slug',
        'status',     'created',
        'final_slug', v_final_slug,
        'nickname',   v_row->>'nickname'
      ));
    else
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'input',   v_row->>'slug',
        'status',  'error',
        'message', 'slug collision after 5 retries'
      ));
    end if;
  end loop;

  return v_results;
end;
$$;

grant execute on function admin_bulk_create_users(text, jsonb) to anon;

-- =============================================================
-- ⚠️ 수동 단계: 관리자 비번 초기 설정
-- =============================================================
-- 아래 줄의 'CHANGE_ME_TO_REAL_PASSWORD' 를 실제 비번으로 바꾼 뒤
-- 이 줄만 따로 실행하세요. (스크립트 전체 실행 시에는 주석 처리)
-- 비번 변경 시에도 이 줄을 (id=1 update로) 다시 실행.
-- -------------------------------------------------------------
-- insert into admin_secrets (id, password_hash)
--   values (1, crypt('CHANGE_ME_TO_REAL_PASSWORD', gen_salt('bf')))
--   on conflict (id) do update
--     set password_hash = excluded.password_hash;

-- =============================================================
-- 검증용 셀프 테스트 (선택, 적용 후 한 번 실행해보면 좋음)
-- =============================================================
-- select admin_bulk_create_users(
--   'CHANGE_ME_TO_REAL_PASSWORD',
--   '[{"slug":"test","nickname":"테스트","naver_id":"test_naver"}]'::jsonb
-- );
-- → [{"input":"test","status":"created","final_slug":"test-xxxxxx","nickname":"테스트"}]
--
-- select get_my_data('test-xxxxxx');  -- 위에서 받은 final_slug
-- select find_my_url('test_naver', '테스트');
-- select add_point_event('test-xxxxxx', 'daily', 'a01', current_date, 1);
-- select get_my_data('test-xxxxxx');  -- events에 1개 보여야 함

-- =============================================================
-- 9. Rate Limit (2026-05-29 추가)
--    brute force 공격 대비. IP × 함수명 단위로 시도 횟수 추적.
-- =============================================================

create table if not exists rate_limits (
  ip            text         not null,
  function_name text         not null,
  attempts      int          not null default 1,
  window_start  timestamptz  not null default now(),
  primary key (ip, function_name)
);

revoke all on rate_limits from anon, authenticated;
alter table rate_limits enable row level security;

-- 헬퍼: 호출 시 시도 횟수 증가. true=허용, false=초과(예외 X)
-- ⚠️ 예외를 던지지 않는 이유: 호출자 함수가 그 후 raise하면 트랜잭션이 롤백되어
--    카운터 증가가 사라지기 때문. 모든 경로에서 정상 return해야 commit됨.
drop function if exists check_rate_limit(text, int, int);
create or replace function check_rate_limit(
  p_function_name    text,
  p_max_attempts     int,
  p_window_seconds   int
)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_ip       text;
  v_headers  text;
  v_now      timestamptz := now();
  v_attempts int;
  v_start    timestamptz;
begin
  -- 클라이언트 IP 추출 (PostgREST가 헤더로 전달)
  begin
    v_headers := current_setting('request.headers', true);
    if v_headers is not null then
      v_ip := split_part(v_headers::json->>'x-forwarded-for', ',', 1);
    end if;
  exception when others then
    v_ip := null;
  end;
  v_ip := nullif(trim(coalesce(v_ip, '')), '');
  if v_ip is null then v_ip := 'unknown'; end if;

  select attempts, window_start
    into v_attempts, v_start
    from rate_limits
    where ip = v_ip and function_name = p_function_name
    for update;

  if not found then
    insert into rate_limits (ip, function_name, attempts, window_start)
      values (v_ip, p_function_name, 1, v_now);
    return true;
  end if;

  -- 윈도우 만료 → 리셋
  if v_now - v_start > make_interval(secs => p_window_seconds) then
    update rate_limits
      set attempts = 1, window_start = v_now
      where ip = v_ip and function_name = p_function_name;
    return true;
  end if;

  -- 임계치 초과 → 더 이상 증가 X, false 반환
  if v_attempts >= p_max_attempts then
    return false;
  end if;

  update rate_limits
    set attempts = attempts + 1
    where ip = v_ip and function_name = p_function_name;
  return true;
end;
$$;

-- find_my_url: rate limit 적용 (5분에 IP당 5회).
-- ⚠️ 모든 결과 분기를 jsonb로 반환 (raise 금지) — 트랜잭션 commit해야 카운터 증가가 살아남음.
-- 반환 status: 'ok' | 'rate_limit_exceeded' | 'required' | 'not_found' | 'ambiguous'
drop function if exists find_my_url(text, text);
create or replace function find_my_url(
  p_naver_id  text,
  p_nickname  text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_slug  text;
  v_count int;
begin
  if not check_rate_limit('find_my_url', 5, 300) then
    return jsonb_build_object('status', 'rate_limit_exceeded');
  end if;

  if p_naver_id is null or p_nickname is null
     or length(trim(p_naver_id)) = 0 or length(trim(p_nickname)) = 0 then
    return jsonb_build_object('status', 'required');
  end if;

  select count(*), max(url_slug)
    into v_count, v_slug
    from users
    where naver_id = p_naver_id
      and nickname = p_nickname
      and status = 'active';

  if v_count = 0 then
    return jsonb_build_object('status', 'not_found');
  elsif v_count > 1 then
    return jsonb_build_object('status', 'ambiguous');
  end if;

  return jsonb_build_object('status', 'ok', 'slug', v_slug);
end;
$$;
grant execute on function find_my_url(text, text) to anon;

-- 관리자 비번 RPC에는 아직 미적용 (md/다중사용자_계획.md 0-A-1 참조)
-- 적용 시 admin_bulk_create_users 본문 첫 줄에 아래 추가:
--   perform check_rate_limit('admin_bulk_create_users', 5, 60);

