# CLAUDE.md — 영어 문장 Anki

아이폰에서 쓰는 영어 **문장** 간격반복 앱. AJATT(1만 문장·MCD) + Antimoon(예문·실수 줄이기) + ajatt.top 복습 규칙을 FSRS 스케줄러 위에 구현한 단일 HTML PWA.
사용자(Kyle)는 한국어 화자, 아이폰 사용, Windows PC에서 개발. **UI 문구와 설명은 한국어**로 쓴다.

## 명령어
```bash
npm install                      # 처음 한 번
npx playwright install chromium  # e2e 테스트용 브라우저 (처음 한 번)
npm run build                    # dist/artifact/index.html + dist/pwa/ 생성
npm run dev                      # 빌드 후 http://localhost:4173 에서 PWA 서빙
npm test                         # 단위(node:test) + e2e(Playwright, iPhone 13 뷰포트)
```
변경 후에는 항상 `npm test`를 돌린다. 화면을 바꿨다면 Playwright로 iPhone 13 스크린샷을 찍어 직접 확인한다.

## 구조
- `src/core.js` — 순수 로직(DOM 없음): 카드 모델, FSRS(ts-fsrs) 래퍼, 큐 생성(`buildQueues`/`pickNext`), 클로즈 파싱, 리치·은퇴·실제 기억률·속도 기준, CSV 파서. **단위 테스트 대상.**
- `src/store.js` — 저장소. 노트를 60개씩 "버킷" 문서로 묶어 저장(리뷰 1회 = 버킷 1개만 다시 씀). 로컬: IndexedDB → localStorage → 메모리. 클라우드: claude.ai 아티팩트의 `db` 기능이 있을 때만(`window.claude.use('db')`) 동기화, 노트 단위 `u`(수정시각) 최신 우선 병합, 삭제는 톰스톤(`del:true`).
- `src/main.js` — UI 전체(바닐라 JS, innerHTML 렌더 + 이벤트 위임). 화면: 홈 / 복습 / 추가(문장·MCD·일괄) / 목록 / 설정.
- `src/shell.html` — HTML·CSS 껍데기. `<!--PWA-->`와 `/*BUNDLE*/` 자리에 빌드가 주입.
- `src/samples.js` — 예제 덱(직접 쓴 문장. 저작권 있는 글 복사 금지).
- `scripts/build.mjs` — esbuild로 번들 → HTML 한 파일에 인라인. **배포할 때 `CACHE_VERSION`을 올린다**(폰의 오프라인 캐시 교체).
- `public/` — 아이콘. `tests/` — `core.test.mjs`(단위), `app.spec.js`(e2e).

## 데이터 모델 (호환성 유지 필수 — 사용자 폰에 실데이터가 있음)
- 노트: `{id, type:'sent'|'cloze', text, ko, extra, src, tags, c(생성), u(수정), cards:{…}, del?}`
  - 문장: `cards.rec`(영→이해), 선택적으로 `cards.prod`(한→영 산출). 클로즈: `{{c1::답}}` 또는 `{{c1::답::힌트}}` → `cards.c1, c2 …`
- 카드(압축 FSRS): `{due, s, d, ed, sd, r, l, ls, st, lr}` + 플래그 `sus`('leech'|'retired'|'known'|true), `bury`(ms), `fd`/`fc`(오늘 실패 횟수), `iv`(새 카드 소개 시각)
- meta: `{settings, days:{'YYYY-MM-DD':{rv,n,ag,tr,trf, ms?,tc?,mt?}}, lastBackup, u}` — 하루 경계는 `dayStartHour`(기본 4시). `ms`=답변 시간 합(장당 60초 상한, 백그라운드 제외), `tc`=시간 잰 답변 수, `mt`=성숙(직전 간격 ≥21일) 카드 통과 수 — 없는 날은 0
- 필드 이름을 바꾸거나 지우지 말 것. 새 필드는 없을 때도 동작하게(기본값) 추가. 백업 JSON(`app:'ankiwords', v:1`) 형식도 유지.

## 학습 규칙 (의도된 설계 — 근거는 docs/learning-methods.md)
- 기본 **두 버튼**(다시/알맞음), 앞면에서 바로 채점 가능. 못 떠올림 = 다시(어려움 아님).
- **속도 채점**: 두 버튼 모드 + 복습 단계 카드에서, 알맞음인데 기준(문장 8초, MCD +4초) 초과면 어려움으로 기록. prod 카드 제외. 백그라운드 시간 제외.
- **새 카드 소개**: 처음엔 답과 함께 노출 → "익혔어요"면 `iv` 기록, 1분 뒤 첫 시험(FSRS 첫 평가는 이때). "이미 알아요" → `sus:'known'`.
- 새 카드 하루 ≤30 권장, 학습 중 ≥`learnCap`(30)이면 새 카드 중단, 같은 노트의 새 형제 카드는 하루 1장 우선.
- prod 카드는 rec 카드를 본 뒤에만 등장(Antimoon: 본 적 있는 문장만 산출).
- 리치: `leechLapses`(5)에서 자동 보류, 이후 절반 간격마다. 같은 날 `dayFailBury`(3)번 실패 → 내일로. 간격 ≥`retireYears`(10)년 → 은퇴.
- 밀린 카드가 하루 상한보다 많으면 **기억 가능성(retrievability) 높은 순**.
- 실제 기억률(30일, 복습 단계 카드만) 목표 75~90%.

## 플랫폼 제약
- 같은 코드가 두 곳에서 돈다: ① claude.ai 아티팩트(외부 fetch·서비스워커·마이크·다운로드 차단, 대신 `window.claude.use('db'|'user'|'downloads'|'tts')`) ② GitHub Pages PWA(아이폰 Safari 홈 화면 앱, 오프라인). `window.claude`가 없을 수 있음을 항상 가정.
- iOS Safari 기준으로 만든다: 내보내기는 Web Share(파일) → `<a download>` → 텍스트 복사 순 폴백. 파일 입력에 `accept` 제한을 걸지 않는다(iOS에서 파일이 회색 처리됨).
- TTS: Web Speech API. 장난감·Eloquence 음성 제외, Premium > Enhanced > 일반 순 자동 선택. Siri 음성은 웹에서 못 씀.
- `alert/confirm/prompt` 금지(아티팩트에서 막힘) — 자체 모달 `confirmBox`/`modal` 사용.

## 배포
- GitHub Pages: `main`에 push하면 `.github/workflows/pages.yml`이 빌드해 `dist/pwa`를 배포(저장소 Settings → Pages → Source: GitHub Actions).
- 빌드가 `dist/pwa/version.json`({v: CACHE_VERSION})을 쓰고, 앱은 시작·복귀 때 이것과 자기 버전(`__APP_VERSION__`)을 비교해 홈에 "새 버전" 배너를 띄운다. 설정 → 앱 → "앱 새로고침"은 쓰기 버퍼 저장 → 서비스워커·캐시 삭제 → `?r=` 붙여 다시 불러오기(IndexedDB 데이터는 건드리지 않음).
- claude.ai 아티팩트 버전(dist/artifact/index.html)은 Claude 데스크톱 앱(Cowork)에서 재게시한다. Claude Code에서는 빌드까지만.

## 하지 말 것
- 프레임워크 도입·대규모 리팩터링(단일 파일 PWA, 의존성 최소가 의도).
- 사용자 데이터 형식 깨기, 백업 호환성 깨기.
- 저작권 있는 글·사전 예문을 샘플에 복사.
