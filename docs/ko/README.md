> 이 번역은 [영어 원문](../../README.md)을 따릅니다. 영어 문서가 기준이며, 명령어·플래그·URL·자리표시자는 영어 그대로 두었습니다.

<img src="../../brand/obsync-icon-256.png" alt="obsync 아이콘: 서로 맞물린 두 개의 고리" width="96" height="96">

# Self Hosted Private Sync

[Obsidian](https://obsidian.md)을 위한 자체 호스팅 종단 간 암호화 실시간 동기화입니다. 직접 운영하는 의존성 없는 Rust 서버 하나에 대시보드가 내장돼 있고, 여기에 이 플러그인이 더해집니다. 크기를 가리지 않는 파일, 모든 Obsidian 플랫폼, 구독 없음, 제3자 없음.

설정 → 커뮤니티 플러그인 → 탐색에서 **Self Hosted Private Sync**(플러그인 ID `obsync-private-sync`)로 설치하며, Obsidian 1.13.0 이상이 필요합니다.

**처음이신가요? [설정 가이드](https://snaraj.github.io/obsync/setup/)(영어)부터 시작하세요.** 기기가 서버에 연결되는 방식을 고르도록 돕고, 각 방식을 단계별로 안내합니다. Obsidian에서는 설정 → Self Hosted Private Sync → Setup guide에서 열 수 있습니다.

> [!IMPORTANT]
> - **당신이** 직접 운영하는 서버와 동기화합니다. 호스팅 서비스도, 다른 어딘가의 계정도 없습니다.
> - 먼저 보관함을 백업하고, 24단어 복구 문구는 그것을 만든 기기가 아닌 곳에 보관하세요.
> - 하나의 보관함에서 다른 동기화 수단(Obsidian Sync, 클라우드 폴더, 또 다른 플러그인)과 나란히 쓰지 마세요.
> - 아직 어린 소프트웨어입니다. 쓰는 버전의 [`CHANGELOG.md`](../../CHANGELOG.md) 항목을 읽고, 모든 기기를 업데이트하고, 각 [검증 실행](../validation-runs/)이 무엇을 다뤘는지 알아 두세요.

## 이 플러그인이 접근하는 것

- **당신의 서버, 그 밖에는 없습니다.** 모든 요청은 직접 입력한 **Server URL**로 갑니다. 텔레메트리도, 제3자도 없습니다.
- **그 서버의 계정**, 설정 토큰으로 만들어집니다. 당신의 Obsidian 계정은 아무 역할도 하지 않습니다.
- **Obsidian을 통한 GitHub Releases**, 설치와 업데이트에 쓰입니다. Obsidian은 그 밖의 릴리스 자산을 무시합니다.
- **보관함의 파일 목록**, 무엇을 동기화할지 정하는 데 씁니다. 숨김 폴더(`.obsidian`, `.git`)와 심볼릭 링크 폴더는 건너뜁니다.
- **클립보드, 쓰기만 합니다.** **Pair a new device** 안의 **Copy code**와 **Copy link**만 쓰며, 절대 읽지 않습니다.

서버가 볼 수 있는 것과 볼 수 없는 것: [`SECURITY.md`](../../SECURITY.md)와 [위협 모델](../threat-model.md).

## 동기화 시작하기

아무것도 없는 상태에서 두 기기가 동기화되기까지 다섯 단계입니다. `v1.0.6`은 이 페이지를 쓸 때 기준으로 삼은 릴리스이니, 설치하려는 릴리스의 태그를 쓰세요.

### 1. 서버 시작하기

서명을 검증하고, 검증 결과가 출력한 바로 그 다이제스트를 실행하세요:

```sh
cosign verify ghcr.io/snaraj/obsync:v1.0.6 \
  --certificate-identity https://github.com/snaraj/obsync/.github/workflows/release-publisher.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

가장 간단한 길은 이 저장소를 체크아웃한 곳에서 Caddy와 함께 쓰는 Compose입니다. 어떤 네트워크에서든 HTTPS를 쓰고, 도메인도, 어디에도 계정도 필요 없습니다.

```sh
OBSYNC_IMAGE=ghcr.io/snaraj/obsync@sha256:<digest> \
  OBSYNC_HOST=sync.example.org \
  OBSYNC_BIND_ADDRESS=192.168.1.10 \
  docker compose -f deploy/compose/docker-compose.yml up -d
```

`OBSYNC_HOST`는 당신의 기기들이 입력하게 될 이름입니다. 자신의 네트워크에서만 풀리면 됩니다. `OBSYNC_BIND_ADDRESS`는 80번과 443번 포트가 공개되는 주소입니다. 바인드 주소는 출발지가 아니라 목적지 인터페이스를 제한하므로, 누가 거기에 닿는지는 당신의 방화벽이 정합니다. 둘을 고르기 전까지 Compose는 시작을 거부합니다.

신뢰하는 프록시나 터널 덕분에 앞단에 이미 HTTPS가 있나요? 그렇다면 단독 서버를 실행하세요: [서버 실행하기](../server.md).

### 2. 설정 토큰 읽기

서버는 첫 부팅 때 설정 토큰을 발행해 저널 볼륨에 0600 모드로 기록하며, 로그에는 절대 남기지 않습니다. 이 토큰은 계정을 한 번 만들고, 그 뒤로도 대시보드의 복구 로그인 수단으로 남습니다. 복구 문구와 똑같이 조심해서 지키세요. 컨테이너에서 읽으세요:

```sh
docker cp obsync-obsync-1:/data/journal/v1/setup-token - | tar -xO
```

### 3. 인증서 신뢰하기, 기기마다 한 번씩

Caddy는 처음 시작할 때 스스로 만든 인증 기관으로 서명합니다. 그래서 기기마다 한 번씩 그 기관을 신뢰해야 합니다. 루트 인증서를 내보낸 뒤 [서버 실행하기](../server.md#trust-the-certificate-authority-once-per-device)가 보여 주는 대로 플랫폼마다 설치하세요. iOS에서는 설치한 다음 신뢰를 켜는 스위치가 한 번 더 있습니다.

### 4. 첫 기기 설정하기

1. 설정 → 커뮤니티 플러그인 → 탐색 → **Self Hosted Private Sync** → 설치 → 활성화.
2. **Server URL**을 자신의 서버로 맞추고(`https://sync.example.org`, 443이 아니면 포트까지), **Whole vault**나 **Selected folders only** 중 하나를 고릅니다. 나중에는 좁히는 쪽으로만 바꿀 수 있습니다.

   ![플러그인의 설정 탭: 예시 호스트 이름이 들어 있는 Server URL 입력란, 엣지 헤더 상자, 그리고 Check와 Open dashboard 버튼이 있는 Connection 줄](../assets/settings-server.png)

3. **Setup or recover** 아래에 설정 토큰을 붙여 넣고 **Set up or recover**을 선택한 뒤, 24단어 복구 문구를 받아 적으세요.

   ![설정 탭의 This device 구역: Pair this device와 Pair a new device가 있는 Pairing 줄, Setup token 입력란과 Set up 버튼이 있는 First-time setup 줄, 그리고 Vault key 줄](../assets/settings-setup.png)

### 5. 두 번째 기기 페어링하기

1. 그 기기에도 같은 **Server URL**로 플러그인을 설치합니다. 첫 기기에서는 **Pair a new device**를 실행해 10분 동안 유효한 코드를 받습니다.

   ![첫 기기의 Pair a new device 대화 상자, 코드는 가려져 있고, Copy code와 Copy link 버튼, 그리고 Waiting for the new device 줄이 보임](../assets/pair-new-device.png)

2. 두 번째 기기에서 **Pair this device**를 열고 코드를 붙여 넣은 뒤 **Pair**를 선택합니다.
3. 다시 첫 기기로 돌아와 새 기기를 이름으로 승인합니다. 둘 중 아무 기기에서나 노트를 편집하면 몇 초 안에 다른 기기에 나타납니다.

   ![새 기기를 이름으로 승인할지 묻는 첫 기기, Approve와 Reject 버튼이 함께 있음](../assets/pair-approve.png)

![움직이는 이미지: 첫 기기에 표시된 페어링 코드, 두 번째 기기에 붙여 넣기, 첫 기기에서 승인, 그리고 첫 노트가 두 번째 기기에 도착](../assets/pairing.gif)

컴퓨터 한 대로 시험해 보나요? 데스크톱에서는 `http://127.0.0.1:8080`이면 단독 서버에 닿습니다. iOS와 Android의 Obsidian은 평문 HTTP를 거부합니다.

휴대폰 스크린샷은 아직 이 저장소에 없습니다. 메인테이너 본인의 기기에서 촬영하며, 검증 실행이 그것을 기록할 때 추가됩니다.

모든 단계를 빠짐없이: [빠른 시작](../quickstart.md).

## 심화: Cloudflare

기준 배포에는 공개 호스트 이름이 없습니다. Cloudflare Tunnel과 사설 경로가 서버의 네트워크에 닿고, 각 기기의 Cloudflare One 클라이언트가 서버 URL을 그쪽으로 나릅니다. **Edge service-token headers**에 서비스 토큰을 넣고 `OBSYNC_EDGE=cloudflare`로 두는, Cloudflare Access 뒤의 공개 호스트 이름도 됩니다. 둘 다 단계별로: [Cloudflare](cloudflare.md).

## 서버에 닿는 다른 방법들

무엇을 고르든 플러그인에는 모든 기기가 신뢰하는 인증서를 갖춘 HTTPS가 필요하고, 서버 자체는 그 종단 지점 뒤에서 평문 HTTP로 남습니다.

- **LAN 전용.** 위의 Compose 경로를 집에서만 쓰는 방식입니다. 집 밖에서는 동기화가 없습니다.
- **WireGuard.** 자기 네트워크로 돌아가는 자신만의 VPN입니다. 가장 빠르고 온전히 당신의 것이지만, 모든 기기에 피어 설정이 필요합니다.
- **Tailscale.** 관리형 WireGuard 메시입니다. 설정은 가장 적지만, 제3자가 자체 요금제 조건에 따라 메시를 조율합니다.
- **자동 TLS를 갖춘 리버스 프록시**, 예를 들어 공개 이름 위의 Caddy입니다. 인터넷에서 닿을 수 있고, 패치는 당신 몫입니다.
- **Cloudflare Tunnel.** 위에서 설명했습니다. 인바운드 포트가 없지만, 자체 약관을 가진 공급자가 경로 위에 있습니다.

밖을 돌아다니는 기기에 필요한 것(경로, 이름, 인증서, 방화벽, iOS의 로컬 네트워크 요청): [LAN 밖에서 닿기](../server.md#reaching-it-from-outside-your-lan).

## 문제 해결

| 증상 | 유력한 원인 | 가장 먼저 해 볼 것 |
| --- | --- | --- |
| `obsync: offline` | 기기가 서버 URL에 닿지 못합니다 | 같은 기기의 브라우저에서 그 URL을 열어 보고, 포트와 HTTPS와 경로를 확인하세요 |
| 컴퓨터는 동기화되는데 휴대폰이 연결되지 않습니다 | 휴대폰에서 사설 인증서를 신뢰하지 않습니다 | 루트 인증서를 설치하고, iOS에서는 “인증서 신뢰 설정”에서 켜기까지 하세요 |
| `401 stale_timestamp` | 시계가 300초 넘게 어긋나 있습니다 | 기기나 서버에서 시간 자동 설정을 켜세요 |
| `403 device_pending` | 아직 아무도 그 기기를 승인하지 않았습니다 | 페어링을 시작한 기기에서 이름으로 승인하세요 |
| 파일이 끝내 도착하지 않습니다 | 폴더 선택 범위 밖에 있거나 휴대폰의 크기 상한을 넘었습니다 | **Sync folders on this device**를 확인하고, 휴대폰에서는 **Show remote-only files**를 실행하세요 |

그 밖의 모든 증상과 모든 오류 코드, 그리고 보고하는 방법: [문제 해결](../troubleshooting.md).

## 문서

[빠른 시작](../quickstart.md) · [서버 실행하기](../server.md) · [Cloudflare](cloudflare.md) · [일상적인 사용](../daily-use.md) · [설정](../settings.md) · [문제 해결](../troubleshooting.md) · [복구](../recovery.md) · [변경 기록](../../CHANGELOG.md)

그 밖의 모든 것: [docs/README.md](../README.md).

## 질문, 버그, 보안

- **질문이거나, 버그인지 확신이 서지 않는 것:** [Discussions](https://github.com/snaraj/obsync/discussions).
- **버그:** [이슈를 등록하고](https://github.com/snaraj/obsync/issues/new/choose) [문제 해결](../troubleshooting.md)이 설명하는 보고서를 함께 담으세요. 토큰도, 복구 문구도, 공개하고 싶지 않은 주소도 넣지 마세요.
- **취약점으로 의심되는 것:** 공개 이슈가 아니라 [`SECURITY.md`](../../SECURITY.md)를 통해 비공개로 알려 주세요.

## 라이선스

MIT. [`LICENSE`](../../LICENSE)를 보세요.
