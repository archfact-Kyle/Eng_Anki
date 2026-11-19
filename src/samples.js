// Starter deck — original sentences written for this app (no third-party text).
export const SAMPLE_SENTENCES = [
  ['I ran out of time, so I had to skip lunch.', '시간이 다 떨어져서 점심을 걸러야 했다.', 'run out of ~ : ~이 다 떨어지다'],
  ['Could you walk me through the process one more time?', '그 절차를 한 번만 더 차근차근 설명해 주시겠어요?', 'walk A through B : A에게 B를 단계별로 설명하다'],
  ["It's not worth the risk.", '그럴 위험을 감수할 가치가 없다.', 'be worth + 명사/-ing'],
  ['She is used to getting up early.', '그녀는 일찍 일어나는 데 익숙하다.', 'be used to + -ing (≠ used to + 동사원형: 예전에 ~하곤 했다)'],
  ["Let's put off the meeting until next week.", '회의를 다음 주로 미룹시다.', 'put off = postpone'],
  ['I should have checked the weather before I left.', '나가기 전에 날씨를 확인했어야 했는데.', 'should have p.p. : ~했어야 했다 (후회)'],
  ['The flight was delayed due to a technical issue.', '항공편이 기술적인 문제로 지연되었다.', 'due to + 명사'],
  ['He kept his promise, even though it cost him a lot.', '큰 대가를 치렀지만 그는 약속을 지켰다.', 'keep a promise / cost A B'],
  ['I can hardly hear you. Could you speak up?', '잘 안 들려요. 좀 크게 말씀해 주시겠어요?', 'hardly = 거의 ~ 않다; speak up = 더 크게 말하다'],
  ['As far as I know, the store closes at nine.', '내가 아는 한 그 가게는 9시에 닫는다.', 'as far as I know'],
  ["I'm looking forward to hearing from you.", '당신의 연락을 기다리고 있겠습니다.', 'look forward to + -ing (to는 전치사)'],
  ['It took me a while to get used to the new system.', '새 시스템에 익숙해지는 데 시간이 좀 걸렸다.', 'it takes (사람) (시간) to ~'],
];

export const SAMPLE_CLOZES = [
  [
    'Every morning, the mechanic {{c1::walks around}} the aircraft before the first flight. She looks for anything unusual, such as a small {{c2::leak}} or a loose panel. If she finds a problem, she {{c3::writes it up}} in the logbook so that it can be fixed before departure.',
    '매일 아침 정비사는 첫 비행 전에 항공기 주변을 돌며 점검한다. 작은 누유나 헐거운 패널 같은 이상한 점을 찾는다. 문제를 발견하면 출발 전에 고칠 수 있도록 로그북에 기록한다.',
    'walk around: 외부 점검(walkaround) / leak: 누출 / write up: (결함을) 기록하다',
  ],
  [
    "Learning a language is a lot like {{c1::building}} a habit. You don't need hours every day; you need a little time, {{c2::consistently}}. The people who succeed are rarely the most talented. They are simply the ones who {{c3::show up}} again tomorrow.",
    '언어를 배우는 것은 습관을 만드는 것과 많이 닮았다. 매일 몇 시간이 필요한 게 아니라, 꾸준히 조금씩의 시간이 필요하다. 성공하는 사람은 가장 재능 있는 사람인 경우가 드물다. 그저 내일도 다시 나타나는 사람들이다.',
    'consistently: 꾸준히 / show up: 나타나다, (빠지지 않고) 오다',
  ],
];
