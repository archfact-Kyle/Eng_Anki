# 학습법 근거와 설계 결정

앱의 동작 규칙이 어디서 왔는지, 자료끼리 충돌할 때 무엇을 택했는지 정리한다.

## 출처
| 자료 | 핵심 |
|---|---|
| AJATT 개요 — https://learnanylanguage.fandom.com/wiki/All_Japanese_All_The_Time | 목표 언어에 몰입, 문장 단위로 SRS |
| 1만 문장 — https://learnanylanguage.fandom.com/wiki/1000_Sentences | 단어장 대신 i+1 문장을 모은다 |
| MCD — https://learnanylanguage.fandom.com/wiki/Massive-Context_Cloze_Deletion | 문단 통째 + 외울 말만 가림, 문단 하나 → 여러 카드, 가린 문장에 집중 |
| Antimoon — https://www.antimoon.com/how/examplesent.htm, /mistakes.htm, /input.htm | 정의보다 사전 예문, 본 적 있는 표현으로만 산출(실수 줄이기), 인풋 우선 |
| ajatt.top 복습법 — https://ajatt.top/blog/how-to-review.html | 두 버튼(Pass/Fail), 매일, 실제 기억률 75~90%, 밀린 카드는 기억 가능성 높은 순, 리치 4~6회 보류, 새 카드 ≤30, 학습 큐 30 넘으면 분할, 은퇴 |
| 디시 영어갤 "안키 애호가들을 위한 소소한팁" — https://gall.dcinside.com/board/view/?id=English&no=445169 | 초기 노출 위주, 숙달 = 즉시 떠오름(어려움 버튼 활용 주장) |

## 충돌과 결정
1. **소리 내어 읽기를 정답 조건으로?** MCD 위키는 필수, ajatt.top은 초보에겐 비권장(틀린 발음 고착). → 정답 기준은 "문맥 속 이해", 소리 내어 읽기·녹음은 선택 기능.
2. **못 떠올렸을 때 어려움?** 디시 글은 어려움, ajatt.top은 다시. FSRS에서 어려움은 "힘들게 회상 성공"이라 실패에 쓰면 간격이 오히려 늘어남. → 실패 = 다시.
3. **숙달(속도) 욕심** — 디시 글의 "장기 카드에 어려움 연타"는 복습량 폭증. → "느리게 떠올린 성공 = 어려움"으로 재해석해 **속도 채점**으로 자동화(버튼은 두 개 유지).
4. **새 카드 첫 만남** — 디시 글의 "가볍게 노출" + AJATT의 "이해한 문장만" → **소개 화면**(답과 함께 보기 → 1분·10분 → 1일), 이미 아는 건 보류.
5. **SM-2 설정값(시작 Ease 131%, Interval Modifier 190%)** — FSRS에는 Ease가 없어 해당 없음. 같은 목적은 목표 기억률(desired retention)로 조절.
6. **"10년 100만 장"** — 근거 Reddit 글은 13.5년간 110만 회 *복습*(하루 약 220회). 새 카드 하루 30장 ≈ 1년 1만 장이 현실적 상한.

## 아직 안 한 것 (후보)
- Google Drive 자동 동기화(OAuth `drive.appdata` 범위, 비민감 권한 — Google 심사 불필요). Google Cloud OAuth 클라이언트 ID 필요.
- 클라우드 TTS(OpenAI/Google, 사용자 API 키, 문장별 음성을 IndexedDB에 캐시).
- .apkg 직접 가져오기(현재는 Anki 텍스트 내보내기 → 일괄 가져오기).
- 영어만 넣으면 뜻·예문 자동 채우기(아티팩트의 `sample` 기능 또는 API).
