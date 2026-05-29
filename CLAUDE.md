# jw — 제이웨딩 포인트 관리

> Claude가 이 프로젝트에서 작업할 때 자동 로드되는 컨텍스트 노트.
> 모든 PC에서 동일하게 적용됨 (git 따라감).

## 프로젝트 한 줄 요약

결혼 준비용 포인트 트래커 (카페+SNS 활동 누적/오늘/이번달). Phase 2 PoC 완료 — Supabase 기반 다중 사용자 서비스. 본인 + 결혼식 후 박람회/플래너 산업 확장 검토.

## 현재 단계 (2026-05-29 기준)

- ✅ **Phase 2 PoC 완료**: localStorage → Supabase 완전 이전
- 인증 = **Capability URL** (`index.html#slug`, 6자 base36 보안코드 부착)
- 사용자 가입 = 구글폼 → 관리자(본인) 시트 복붙 → `admin.html` 일괄 생성
- Phase 3 (매직링크 마이그레이션) = 미실시, 박람회/플래너 확장 시점에 검토

## 진실의 원천

**모든 리스크/완료/보류 작업/Phase 로드맵은 [md/다중사용자_계획.md](md/다중사용자_계획.md)에 있음.** 
새 작업 시작 전 또는 "지난번에 뭐 했지?" 질문 시 그 파일부터 봄.

## 파일 맵

| 파일 | 역할 |
|---|---|
| `index.html` / `app.js` / `styles.css` | 메인 사용자 앱 (정적 HTML/JS, Live Server 실행) |
| `admin.html` | 관리자 페이지 — 구글시트 복붙으로 사용자 일괄 생성 |
| `supabase-config.js` | Supabase URL, anon key, `callRpc()` 헬퍼 |
| `data.json` | 활동 정의 (한정/매일/매달/사용계획) |
| `sql/init.sql` | DB 스키마 + RLS + RPC 5종 + rate limit. 전체 idempotent |
| `md/다중사용자_계획.md` | **설계/리스크/완료 로그 단일 진실 원천** |

## 데이터 모델

```
users (id, naver_id, nickname, url_slug UNIQUE, email, status, created_at, last_seen_at)
point_events (id, user_id FK, bucket, activity_id, occurred_at DATE, point, created_at)
admin_secrets (id=1, password_hash)  -- bcrypt
rate_limits (ip, function_name, attempts, window_start)
```

- 카운터(누적/오늘/이번달)는 **항상 `point_events`에서 derive**. 별도 카운터 캐시 X (자정 리셋 자동).
- 클라이언트 `state.history[bucket:id] = [{id, occurred_at}, ...]` — event UUID 보유로 정확 삭제 가능.

## 보안 모델

- **테이블 전면 RLS 차단** (`revoke all from anon`) + `security definer` RPC만 anon에 expose
- 모든 RPC는 **첫 인자로 슬러그 또는 관리자 비번 검증**
- pgcrypto는 `extensions` 스키마 → 함수에 `set search_path = public, extensions` 필수
- 관리자 비번: `crypt(input, stored_hash) = stored_hash` (bcrypt)
- IP rate limit: `current_setting('request.headers')::json->>'x-forwarded-for'` 추출

## 코딩 규칙 (학습된 패턴)

### ⚠️ RPC: raise 대신 JSON status 반환

PostgreSQL은 함수가 `raise`하면 트랜잭션 전체 롤백 → 같은 함수의 INSERT/UPDATE도 같이 사라짐.

**부수효과(카운터/로그) + 에러 분기를 함께 가지는 RPC는 raise 금지.** 대신 `returns jsonb`로 `{status: 'ok'|'rate_limit_exceeded'|'not_found'|'ambiguous'|'required'|...}` 반환.

부수효과 없는 단순 query 함수만 `raise` OK.

참조 예시: `sql/init.sql` 섹션 9의 `find_my_url`.

### `data.json` activity ID는 immutable

ID 바꾸면 기존 `point_events.activity_id`와 매칭 안 됨 → 데이터 사라진 것처럼 보임. name/note만 수정.

### RPC 시그니처 변경 시

반환 타입이나 인자 타입 바뀌면 `create or replace`로 안 됨. `drop function if exists ...` 먼저, 그 다음 `create or replace`. PostgREST 스키마 캐시 갱신은 `notify pgrst, 'reload schema';`.

## 사용자 컨텍스트

- 한국어 대화. 영문 기술용어 섞임 OK.
- Solo 개발자. 코딩 익숙하지만 Supabase/PostgreSQL/RLS는 학습 중.
- **무료 티어 우선** (Supabase Pro 안 함, Vercel/Netlify 무료 등). 비용/규모 추정 자주 물음.
- 환경: Windows 11 + VSCode + Live Server + PowerShell. WSL Bash도 사용 가능.
- 응답 선호: 간결 + 트레이드오프 명시 + 결정 옵션 제시.

## 사용자 수 단계별 우려

| 규모 | 무료 가능 | 필요 작업 |
|---|---|---|
| ~50명 (지인) | ✅ 여유 | 그대로 |
| ~200명 | ✅ | `find_my_url` rate limit (✅ 완료) |
| ~500명 | ⚠️ egress 빠듯 | + 관리자 rate limit, DB 백업, URL 재발급 (md 0-A 참조, 보류 중) |
| 1000명+ | 🟡 Pro 검토 | + 증분 fetch 최적화 |

## 보류 중인 다음 작업 (사용자 결정 대기)

[md/다중사용자_계획.md](md/다중사용자_계획.md) **0-A 섹션** 참조:
- A-1. 관리자 비번 rate limit (인프라 다 있음 → 한 줄)
- A-2. DB 백업 자동화 (GitHub Actions 또는 수동)
- A-3. URL 재발급 기능
- A-4. 자동 승인 룰

## 작업 완료 시 루틴

- [md/다중사용자_계획.md](md/다중사용자_계획.md) 상단 "✅ 완료 로그" 섹션에 날짜 + 결과 추가
- 해당 0번 리스크 항목에 ✅ 마커
- 코드 위치 markdown 링크로 명시 ([filename.ext:line](filename.ext#Lline) 형식)
