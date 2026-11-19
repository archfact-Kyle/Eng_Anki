# 영어 문장 Anki

AJATT(1만 문장·MCD) + Antimoon + ajatt.top 복습 규칙을 FSRS 위에 구현한 영어 문장 간격반복 앱. 아이폰 홈 화면 앱(PWA)으로 오프라인에서 동작합니다.

## 개발 (Windows PowerShell 기준)
```powershell
npm install
npx playwright install chromium
npm run dev        # http://localhost:4173
npm test
```
Claude Code에서 작업할 때는 이 폴더에서 `claude`를 실행하세요. 프로젝트 규칙은 `CLAUDE.md`에 있습니다.

## 배포 (GitHub Pages, 자동)
1. 이 폴더를 GitHub 저장소(Public)로 push
2. 저장소 Settings → Pages → Source: **GitHub Actions**
3. 이후 `main`에 push할 때마다 자동 빌드·배포 → `https://<아이디>.github.io/<저장소>/`
4. 아이폰 Safari로 열기 → 공유 → 홈 화면에 추가

데이터는 폰 안(IndexedDB)에만 저장됩니다. 앱 설정의 "전체 백업 파일"로 가끔 백업하세요.

학습법 근거와 설계 결정: [docs/learning-methods.md](docs/learning-methods.md)
