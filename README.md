# 차요우 다원 (茶友茶园)

three.js로 만든 3D 온라인 다원입니다. 브라우저 화면(`index.html`)과 실시간 서버(`server.js`)로 이루어져 있어요.

## 함께 접속하려면 서버가 필요해요
GitHub Pages는 파일만 보여 주는 곳이라 실시간 서버를 돌릴 수 없어요. `server.js`를 한 곳에 띄우고, 그 주소로 들어가면 같은 서버의 사람들이 서로 보여요.

- 실행: `node server.js` (Node 18 이상, 설치할 패키지 없음) → `http://localhost:8080`
- 게임 화면과 실시간 연결(`/ws`)을 같은 주소에서 함께 제공합니다.
- 채널: 링크의 `?server=1` (기본 1). 채널당 최대 88명(팽주·손님 포함). 가득 차면 만원 안내가 뜹니다.
- 서버가 관리하는 것: 접속자·닉네임(채널 안 중복 없음)·새로고침 복구(30초)·좌석·팽주 역할·고른 차와 남은 우림 횟수·손님 찻잔·차 내기·함께 한 모금.

### Render(무료)로 띄우기
1. https://render.com 가입 → **New → Blueprint** → 이 저장소(chayou-dawon) 선택 → Apply.
2. 배포가 끝나면 `https://chayou-dawon-xxxx.onrender.com` 같은 주소가 생겨요. 이 주소를 친구에게 공유하면 됩니다.
   (무료 플랜은 15분간 접속이 없으면 잠들었다가, 다음 접속 때 30초~1분 뒤 깨어나요.)

### GitHub Pages 화면을 계속 쓰고 싶다면
`index.html`의 `<meta name="chayou-server" content="">`에 서버 주소를 `wss://chayou-dawon-xxxx.onrender.com/ws` 처럼 넣어 주세요.
비워 두면 "서버 미설정 · 혼자 보는 중"으로 표시됩니다.

## 개발용 로그 (일반 화면에는 표시되지 않음)

- 브라우저: 주소 끝에 `&debug`를 붙이면 연결·재연결·착석·퇴석·캐릭터 생성/삭제가 `window.__chayouLog`와 개발자 도구 콘솔(console.debug)에 사용자 ID, 연결 ID, 채널, 좌석 ID와 함께 남아요.
- 서버: Render의 Logs 탭에 connect / enter / resume / takeover / away / closeStale / sit / sitDenied / stand / remove 줄이 남아요. 끄려면 환경 변수 `DEBUG_LOG=0`.
- 재접속 유예 시간은 `GRACE_MS`(기본 40초), 화면이 뒤로 간 채로 머무는 시간은 `HIDE_MS`(기본 45초)예요. 이 시간이 지나면 캐릭터가 퇴장하고, 다시 화면에 돌아오면 같은 이름으로 다시 들어와요.

## 방문 통계

서버가 이름이나 IP 없이 숫자만 모아요. 날짜는 한국 시간 기준이에요.

- 방문자 수(날짜별·시간대별), 새로 온 사람/다시 온 사람, 채널별 방문
- 하루 최고 동시 접속과 그 시각
- 머문 시간(평균·구간별), 휴대폰/PC
- 활동 횟수: 찻잎 고르기·바꾸기, 차 우리기·나누기·마시기, 함께 한 모금, 자동으로 따른 잔, 팽주석/손님석, 나룻배, 향, 다과, 물수제비, 잉어 먹이, 풍등, 마음 표현

10분마다, 그리고 서버가 꺼질 때 이 저장소의 `stats` 브랜치에 `stats.json`으로 저장하고, 서버가 다시 켜지면 이어서 세요.
`stats` 브랜치에 저장해도 게임은 다시 배포되지 않아요.

설정: GitHub에서 이 저장소만 접근할 수 있는 fine-grained 토큰(권한 Contents: Read and write)을 만들어
Render의 Environment에 `STATS_GITHUB_TOKEN`으로 넣어 주세요. 토큰이 없으면 통계가 메모리에만 있어서 서버가 재시작되면 지워져요.
