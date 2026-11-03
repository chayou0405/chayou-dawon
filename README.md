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
