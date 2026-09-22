> 이 번역은 [영어 원문](../../README.md)을 따릅니다. 영어 문서가 기준이며, 명령어·플래그·URL·자리표시자는 영어 그대로 두었습니다.

# Self Hosted Private Sync

[Obsidian](https://obsidian.md)을 위한 자체 호스팅 종단 간 암호화 실시간 동기화입니다. 직접 운영하는 의존성 없는 Rust 서버 하나에 대시보드가 내장돼 있고, 여기에 이 플러그인이 더해집니다. 크기를 가리지 않는 파일, 모든 Obsidian 플랫폼, 구독 없음, 제3자 없음.

설정 → 커뮤니티 플러그인 → 탐색에서 **Self Hosted Private Sync**(플러그인 ID `obsync-private-sync`)로 설치하며, Obsidian 1.13.0 이상이 필요합니다.

> [!IMPORTANT]
> 이 플러그인은 **당신이** 직접 운영하는 서버와 동기화합니다. 호스팅 서비스는 없고, 자기 자신 말고 다른 누구와의 계정도 없습니다. HTTPS로 닿을 수 있는 자신의 `obsyncd`가 없으면 플러그인에는 동기화할 대상 자체가 없습니다.

> [!IMPORTANT]
> 첫 동기화 전에 보관함을 백업하고, 24단어 복구 문구는 그것을 생성한 기기가 아닌 다른 곳에 보관하세요. 서버는 암호문만 저장하므로 보관함을 대신 복구해 줄 수 없습니다.

> [!IMPORTANT]
> 같은 보관함에서 이 플러그인을 다른 동기화 수단과 나란히 쓰지 마세요. Obsidian Sync, 파일을 동기화하는 클라우드 폴더, 또 다른 동기화 플러그인 모두 해당합니다. 하나의 보관함에 쓰는 주체가 둘이면 어느 쪽도 해소할 수 없는 충돌이 생깁니다.

## 믿고 맡기기 전에

이것은 당신 노트의 유일한 사본을 동기화하는, 아직 어린 소프트웨어입니다.

- **[`CHANGELOG.md`](../../CHANGELOG.md)는 알려진 사실을 관리하는 목록입니다.** 지금 쓰는 버전의 항목과 그 위의 항목들을 읽으세요. 릴리스 페이지는 공개 당시의 노트를 그대로 유지하고, 나중에 밝혀진 사실은 여기에 추가됩니다.
- **보관함을 동기화하는 모든 기기를 업데이트하세요.** 한 대라도 옛 버전에 남아 있으면 여전히 옛 동작대로 움직여 나머지 기기에 영향을 줄 수 있습니다.
- **실제 하드웨어에서 확인한 것**은 실행마다 [`docs/validation-runs/`](../validation-runs/)에 기록되며, 각 실행이 다루지 않은 것도 함께 적혀 있습니다. 어떤 실행도 이름을 대지 않은 플랫폼은 증명된 것이 아닙니다.
- **“merged concurrent edits” 알림이 줄줄이 뜨는 경우**, 한 노트를 두 기기가 편집하고 있는 것입니다. 한쪽에서 Obsidian을 종료해 다른 쪽이 밀린 작업을 끝내게 하고, 둘 다 업데이트한 뒤 다시 시작하세요.

## 이 플러그인이 접근하는 것

설치 전에 판단할 수 있도록 짧고 빠짐없이 적었습니다.

- **네트워크 목적지는 하나, 당신 자신의 서버뿐입니다.** 모든 요청은 플러그인 설정에 입력한 **Server URL**로 가고, 그 밖의 어디로도 가지 않습니다. 텔레메트리도, 분석도, 크래시 리포터도, 광고도 없고, 동기화 경로 어디에도 제3자 서비스가 없습니다. 플러그인은 그 서버에서 코드를 내려받거나 실행하지도 않습니다.
- **그 서버의 계정, 당신이 직접 만드는 것입니다.** 첫 기기는 서버가 첫 부팅 때 기록한 설정 토큰을 쓰고, 나머지 기기는 이미 동기화 중인 기기에서 페어링합니다. 당신의 Obsidian 계정은 아무 역할도 하지 않습니다.
- **Obsidian과 GitHub, 설치와 업데이트에만 해당합니다.** Obsidian이 직접 이 저장소의 GitHub Releases에서 `main.js`, `manifest.json`, `styles.css`를 내려받습니다. 각 Release에는 서버를 배포하는 사람들을 위한 플러그인 ZIP과 릴리스 매니페스트도 함께 실려 있지만, Obsidian은 둘 다 무시합니다.
- **당신의 엣지, 직접 구성한 경우에만 해당합니다.** **Edge service-token headers** 아래에 붙여 넣은 헤더는 위의 서버 URL로 가는 모든 요청에 함께 실립니다. 그 헤더를 필요로 하는 프록시가 당신 서버로 가는 경로 위에 있기 때문입니다.
- **보관함의 파일 목록입니다.** 플러그인은 무엇이 범위에 드는지 정하려고 보관함의 모든 파일을 열거하고, 선택한 폴더 안의 파일을 읽고, 다른 기기가 바꾼 것을 씁니다. 숨김 폴더(`.obsidian`, `.git`)와 심볼릭 링크로 연결된 폴더는 건너뜁니다.
- **클립보드, 쓰기만 하고 절대 읽지 않습니다.** **Pair a new device** 안의 **Copy code**와 **Copy link** 버튼만 클립보드에 씁니다. 플러그인의 어떤 부분도 클립보드를 읽지 않습니다.
- **당신의 브라우저, 대시보드를 요청했을 때만 해당합니다.** **Open dashboard**는 브라우저에서 로그인 링크를 열며, 그 링크가 당신 서버 자신의 오리진에 있을 때만 그렇게 합니다.
- **Obsidian의 보안 저장 공간입니다.** 보관함 키, 기기 비밀값, 그리고 엣지 헤더 값은 모두 그곳에 있고, 평문 플러그인 데이터에는 절대 남지 않습니다.

서버가 볼 수 있는 것과 볼 수 없는 것은 [`SECURITY.md`](../../SECURITY.md)와 [`docs/threat-model.md`](../threat-model.md)에 있습니다.

## 다섯 단계로 동기화하기

이 릴리스가 검증된 경로입니다. 빈 보관함에서 시작해 두 기기가 동기화되기까지의 길입니다. 다섯 단계 모두 자신의 서버가 이미 돌고 있다고 전제하며, 그 내용은 바로 아래 절에 있습니다. 각 단계는 빠른 시작에 전부 풀어서 적혀 있습니다.

1. **커뮤니티 플러그인에서 설치합니다.** 설정 → 커뮤니티 플러그인 → 탐색에서 **Self Hosted Private Sync**를 검색해 설치를 선택하고, 이어서 활성화를 선택합니다. 다른 모든 Obsidian 플러그인이 도착하는 방식과 같으며, 모든 플랫폼에서 동일합니다.

   ![Self Hosted Private Sync와 그 설치 버튼이 보이는 Obsidian의 커뮤니티 플러그인 탐색 화면](../captures/01-install-from-directory.png)

2. **서버를 가리키게 하고 설정합니다.** 플러그인의 설정 탭을 열어 **Server URL**을 자신의 서버로 맞추고, 이 기기가 동기화할 폴더를 고른 다음, **First-time setup** 아래에 설정 토큰을 붙여 넣습니다.

   ![폴더 선택, Pairing, First-time setup의 토큰 입력란까지 스크롤한 플러그인 설정 탭](../captures/02-first-time-setup.png)

3. **복구 문구를 보관합니다.** 설정 과정에서 이 기기에 보관함 키가 생성되고 24단어 문구가 한 번만 표시됩니다. 받아 적어 이 기기가 아닌 다른 곳에 보관하세요. 서버는 암호문만 가지고 있어 보관함을 대신 복구해 줄 수 없기 때문입니다.

   ![최초 설정 뒤에 나타난 복구 문구 대화 상자, 단어는 가려져 있음](../captures/03-recovery-phrase.png)

4. **일회용 코드로 두 번째 기기를 페어링합니다.** 첫 기기에서 **Pair a new device**를 실행하고, 표시된 코드를 10분 안에 두 번째 기기에 입력한 뒤, 그 기기를 이름으로 승인합니다. 보관함 키는 서버가 결코 보지 못하는 페어링 비밀값으로 암호화된 채 건너갑니다.

   ![첫 기기의 Pair a new device 대화 상자, 일회용 코드는 가려져 있음](../captures/04-pair-a-new-device.png)

5. **어느 쪽 기기에서든 편집하고 도착하는 것을 지켜봅니다.** 한 기기에서 노트에 입력하면 몇 초 안에 다른 기기에 나타납니다. 양방향 모두 그러하며, 상태바가 동기화가 무엇을 하고 있는지 보여 줍니다.

   ![두 기기의 편집 내용이 모두 담긴 임시 노트와 함께 보이는 동기화 상태바](../captures/05-sync-both-ways.png)

대시보드의 기기 목록과 그 해지 버튼은 [기기 확인하기](../daily-use.md#see-your-devices)에서 설명하며, [docs/validation-runs/2026-09-14.md](../validation-runs/2026-09-14.md)에 기록된 1.0.0 기기 실행에서는 시험되지 않았습니다.

## 동기화 시작하기

가장 짧고 올바른 길입니다. 자신이 가진 머신 한 대가 서버를 돌리고, 모든 기기가 HTTPS로 거기에 닿고, 각 기기를 한 번씩 페어링합니다. Obsidian에 로그인하는 것은 여기서 아무것도 승인해 주지 않습니다. 유일한 계정은 당신 서버에 있는 계정입니다.

### 1. 서버 시작하기

시작하는 방법은 두 가지입니다. 둘 다 게시자가 서명한 바로 그 바이트를 실행합니다. 서명을 검증하고, 검증된 출력에서 다이제스트를 읽어, 그 다이제스트를 실행하세요. `v1.0.6`은 이 페이지를 쓸 때 기준으로 삼은 릴리스입니다. 설치하려는 릴리스의 태그를 쓰세요.

```sh
cosign verify ghcr.io/snaraj/obsync:v1.0.6 \
  --certificate-identity https://github.com/snaraj/obsync/.github/workflows/release-publisher.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

**아직 HTTPS가 없나요?** `deploy/compose`는 어떤 네트워크에서든, 도메인 없이, 누구와의 계정도 없이 서버를 자체 TLS 종단 지점(Caddy) 뒤에서 시작합니다. 이 저장소를 체크아웃한 곳에서:

```sh
OBSYNC_IMAGE=ghcr.io/snaraj/obsync@sha256:<digest> \
  OBSYNC_HOST=sync.example.org \
  OBSYNC_BIND_ADDRESS=192.168.1.10 \
  docker compose -f deploy/compose/docker-compose.yml up -d
```

`OBSYNC_HOST`는 당신의 기기들이 입력하게 될 이름입니다. 자신의 네트워크에서만 풀리면 됩니다. `OBSYNC_BIND_ADDRESS`는 80번과 443번 포트가 공개되는 이 호스트의 주소입니다. 바인드 주소는 출발지가 아니라 목적지 인터페이스를 제한하므로, 누가 거기에 닿는지는 당신의 방화벽이 정합니다. 둘을 고르기 전까지 Compose는 시작을 거부합니다. 둘 다 [서버 실행하기](../server.md)에서 설명합니다.

신뢰하는 리버스 프록시나 터널 덕분에 **머신 앞에 이미 HTTPS가 있나요?** 그렇다면 단독 서버를 실행하세요. 8080 포트에서 평문 HTTP로 말하고, 당신의 종단 지점이 그쪽으로 전달합니다:

```sh
docker volume create obsync-blobs
docker volume create obsync-journal
docker run -d --name obsync -p 127.0.0.1:8080:8080 \
  -v obsync-blobs:/data/blobs -v obsync-journal:/data/journal \
  -e OBSYNC_BLOBS_CAPACITY=250GiB -e OBSYNC_JOURNAL_CAPACITY=4GiB \
  -e OBSYNC_PUBLIC_URL=https://sync.example.org \
  ghcr.io/snaraj/obsync@sha256:<the digest cosign just verified>
```

### 2. 설정 토큰 읽기

서버는 첫 부팅 때 설정 토큰을 발행해 저널 볼륨에 0600 모드로 기록하며, 로그에는 절대 남기지 않습니다. 이 토큰은 계정을 한 번 만들고, 그 뒤로는 서버가 살아 있는 내내 대시보드의 복구 로그인 수단으로 남습니다. 복구 문구와 똑같이 조심해서 보관하세요. 보조 이미지 없이 컨테이너에서 직접 읽으세요. Compose 경로에서는:

```sh
docker cp obsync-obsync-1:/data/journal/v1/setup-token - | tar -xO
```

단독 서버 경로에서는:

```sh
docker cp obsync:/data/journal/v1/setup-token - | tar -xO
```

### 3. 인증서 신뢰하기, 기기마다 한 번씩(Compose 경로)

Caddy는 처음 시작할 때 스스로 만든 인증 기관으로 인증서를 발급했습니다. 그래서 기기마다 한 번씩 그 기관을 신뢰하라고 알려 줘야 합니다. 루트 인증서를 내보내세요:

```sh
docker cp obsync-caddy-1:/data/caddy/pki/authorities/local/root.crt - | tar -xO > obsync-root.crt
```

각 기기에 `obsync-root.crt`를 설치하세요. macOS, Windows, Linux, iOS, Android의 단계는 [인증 기관 신뢰하기, 기기마다 한 번씩](../server.md#trust-the-certificate-authority-once-per-device)에 있습니다. iOS에서는 인증서를 설치한 다음 신뢰를 켜는 스위치가 한 번 더 있습니다.

### 4. 첫 기기 설정하기

1. 설정 → 커뮤니티 플러그인 → 탐색 → **Self Hosted Private Sync** → 설치 → 활성화.
2. 플러그인 설정에서 **Server URL**을 자신의 서버로 맞춥니다. 443이 아니면 포트까지 넣습니다: `https://sync.example.org`.

   ![플러그인의 설정 탭: 예시 호스트 이름이 들어 있는 Server URL 입력란, 엣지 헤더 상자, 그리고 Check와 Open dashboard 버튼이 있는 Connection 줄](../assets/settings-server.png)

3. 지금 **Whole vault**나 **Selected folders only** 중 하나를 고릅니다. 기기가 한 번 동기화하고 나면 그 선택은 좁히는 쪽으로만 바꿀 수 있습니다.
4. **First-time setup** 아래에 설정 토큰을 붙여 넣고 **Set up**을 선택합니다. 24단어 복구 문구를 받아 적고 이 기기에는 남기지 마세요.

   ![설정 탭의 This device 구역: Pair this device와 Pair a new device가 있는 Pairing 줄, Setup token 입력란과 Set up 버튼이 있는 First-time setup 줄, 그리고 Vault key 줄](../assets/settings-setup.png)

### 5. 두 번째 기기 페어링하기

1. 그 기기에도 플러그인을 설치해 활성화하고, 같은 **Server URL**을 넣고, 그 기기의 폴더를 고릅니다.
2. 첫 기기에서 **Pair a new device**를 실행합니다. 10분 동안 유효한 코드가 표시됩니다.

   ![첫 기기의 Pair a new device 대화 상자, 코드는 가려져 있고, Copy code와 Copy link 버튼, 그리고 Waiting for the new device 줄이 보임](../assets/pair-new-device.png)

3. 두 번째 기기에서 **Pair this device**를 열고 코드를 붙여 넣은 뒤 **Pair**를 선택합니다.

   ![두 번째 기기의 Pair this device 대화 상자, 비어 있는 Pairing code 입력란과 Pair 버튼](../assets/pair-this-device.png)

4. 다시 첫 기기로 돌아와 새 기기를 이름으로 승인합니다. 둘 중 아무 기기에서나 노트를 편집하면 몇 초 안에 다른 기기에 나타납니다.

   ![새 기기를 이름으로 승인할지 묻는 첫 기기, Approve와 Reject 버튼이 함께 있음](../assets/pair-approve.png)

   ![첫 기기에서 쓴 노트를 보여 주는 두 번째 기기, 상태바에는 obsync idle이 표시됨](../assets/first-sync.png)

페어링 절차 전체를 짧은 반복 영상으로:

![움직이는 이미지: 첫 기기에 표시된 페어링 코드, 두 번째 기기에 붙여 넣기, 첫 기기에서 승인, 그리고 첫 노트가 두 번째 기기에 도착](../assets/pairing.gif)

휴대폰 스크린샷은 아직 이 저장소에 없습니다. 메인테이너 본인의 기기에서 촬영하며, 검증 실행이 그것을 기록할 때 추가됩니다.

각 화면이 무엇을 왜 요구하는지까지, 모든 단계를 빠짐없이: [빠른 시작](../quickstart.md).

**컴퓨터 한 대로 시험해 보나요?** 컴퓨터에서는 플러그인이 평문 `http://` 주소도 받아들이므로, `http://127.0.0.1:8080`이면 종단 지점 없이 위의 단독 서버에 닿습니다. 휴대폰은 그렇지 않습니다. iOS와 Android의 Obsidian은 평문 HTTP를 거부합니다.

## 심화: Cloudflare

기준 배포에는 **공개 호스트 이름이 없습니다**. Cloudflare Tunnel이 서버의 사설 네트워크를 Cloudflare에 연결하고, 사설 경로가 그 터널 뒤에 어떤 주소가 있는지 Cloudflare에 알리며, 각 기기의 Cloudflare One 클라이언트가 서버 URL을 그쪽으로 나릅니다. 인터넷에서 닿을 수 있는 것은 아무것도 없고, 대용량 첫 동기화가 공개 호스트 이름을 거쳐 프록시되지도 않습니다. 다른 형태, 즉 **Edge service-token headers**에 서비스 토큰을 넣고 서버를 `OBSYNC_EDGE=cloudflare`로 두는 Cloudflare Access 뒤의 공개 호스트 이름도 지원합니다. 둘 다 단계별로: [Cloudflare](cloudflare.md).

## 서버에 닿는 다른 방법들

각각 한 줄씩이고, 안내서는 아닙니다. 무엇을 고르든 플러그인에는 모든 기기가 신뢰하는 인증서를 갖춘 HTTPS가 필요하고, 서버 자체는 그 종단 지점 뒤에서 평문 HTTP로 남습니다.

- **LAN 전용.** 위의 Compose 경로를 집에서만 쓰는 방식입니다. 가장 간단하지만, 집 밖에서는 동기화가 되지 않습니다.
- **WireGuard.** 자기 네트워크로 돌아가는 자신만의 VPN입니다. 가장 빠르고 온전히 당신의 것이지만, 모든 기기에 피어 설정을 지니고 다녀야 하고 엔드포인트 하나를 계속 닿을 수 있게 유지해야 합니다.
- **Tailscale.** 자체 이름 체계를 갖춘 관리형 WireGuard 메시입니다. 기기 쪽 설정은 가장 적지만, 제3자가 메시를 조율하며, 그 요금제 한도는 당신이 직접 읽어야 합니다.
- **자동 TLS를 갖춘 리버스 프록시**, 예를 들어 공개 이름 위의 Caddy입니다. 공개적으로 신뢰받는 인증서와 영구 주소를 얻지만, 그러면 서버가 인터넷에서 닿을 수 있게 되고, 프록시와 그 업데이트를 제대로 유지하는 일은 당신 몫입니다.
- **Cloudflare Tunnel.** 위에서 설명했습니다. 인바운드 포트가 없지만, 자체 약관을 가진 공급자가 경로 위에 있습니다.

무엇을 고르든 밖을 돌아다니는 기기에 필요한 것(경로, 이름, 인증서, iOS의 로컬 네트워크 요청, 방화벽): [LAN 밖에서 닿기](../server.md#reaching-it-from-outside-your-lan).

## 문제 해결

| 증상 | 유력한 원인 | 가장 먼저 해 볼 것 |
| --- | --- | --- |
| `obsync: offline` | 기기가 서버 URL에 닿지 못합니다 | 같은 기기의 브라우저에서 그 URL을 열어 보고, 포트와 HTTPS와 경로를 확인하세요 |
| 컴퓨터는 동기화되는데 휴대폰이 연결되지 않습니다 | 휴대폰에서 사설 인증서를 신뢰하지 않습니다 | 루트 인증서를 설치하고, iOS에서는 “인증서 신뢰 설정”에서 켜기까지 하세요 |
| `401 stale_timestamp` | 시계가 300초 넘게 어긋나 있습니다 | 기기나 서버에서 시간 자동 설정을 켜세요 |
| `403 device_pending` | 아직 아무도 그 기기를 승인하지 않았습니다 | 페어링을 시작한 기기에서 이름으로 승인하세요 |
| 파일이 끝내 도착하지 않습니다 | 폴더 선택 범위 밖에 있거나 휴대폰의 크기 상한을 넘었습니다 | **Sync folders on this device**를 확인하고, 휴대폰에서는 **Show remote-only files**를 실행하세요 |

그 밖의 모든 증상과 모든 오류 코드, 그리고 보낼 만한 보고서를 모으는 방법: [문제 해결](../troubleshooting.md).

## 문서

| 페이지 | 답해 주는 것 |
| --- | --- |
| [빠른 시작](../quickstart.md) | 첫 기기와 두 번째 기기, 모든 단계를 빠짐없이 |
| [서버 실행하기](../server.md) | Docker, Caddy를 쓰는 Compose, 인증서, 백업, LAN 밖에서 닿기 |
| [Cloudflare](cloudflare.md) | 사설 경로와 Cloudflare One 클라이언트를 쓰는 터널, 또는 Access 뒤의 공개 호스트 이름 |
| [Kubernetes](../../chart/README.md) | 서명된 Helm 차트로 서버 설치하기 |
| [일상적인 사용](../daily-use.md) | 명령, 상태바, 무엇이 동기화되고 무엇이 되지 않는지, 버전 되돌리기, 대시보드 |
| [설정](../settings.md) | 모든 설정과 그 기본값, 그리고 언제 바꿔야 하는지 |
| [문제 해결](../troubleshooting.md) | 증상, 원인, 해결, 그리고 보고서를 모으는 방법 |
| [충돌](../conflicts.md) | 충돌 사본이 무엇이고 그것으로 무엇을 해야 하는지 |
| [복구](../recovery.md) | 잃어버린 기기, 잃어버린 서버, 옮긴 서버, 교체한 토큰 |
| [설치와 업데이트](../community-plugin.md) | Obsidian의 플러그인 목록, 업데이트, 자격 증명 보관, 등록 심사 |
| [위협 모델](../threat-model.md) | 무엇이 방어되고 무엇이 방어되지 않는지 |
| [대시보드의 위협 모델](../security/dashboard.md) | 세션, 로그인, 해지, 잔여 위험 |
| [아키텍처](../architecture.md) | 시스템 전체가 어떻게 지어졌는지, 그리고 모든 환경 변수 |
| [프로토콜](../protocol.md) | 플러그인과 서버 사이의 통신 규약 |
| [스토리지](../storage.md) | 볼륨, 내구성, 보존, 스크럽, 그리고 모든 거부 |
| [검증](../validation.md) | 기기 검증 계획과 “준비됨”이 뜻하는 것 |
| [릴리스](../release.md) | 릴리스를 자르고 서명하고 감사하는 방법 |
| [번역](../translations.md) | 안내 문서가 어떤 언어로 존재하는지, 그리고 어떻게 최신으로 유지되는지 |
| [`CHANGELOG.md`](../../CHANGELOG.md) | 각 버전에서 무엇이 바뀌었는지 |
| [`SECURITY.md`](../../SECURITY.md) | 보안 태도, 지원 버전, 그리고 취약점을 알리는 방법 |
| [`CONTRIBUTING.md`](../../CONTRIBUTING.md) | 이 저장소에서 작업하는 방법 |

## 질문, 버그, 보안

- **질문이거나, 버그인지 확신이 서지 않는 것:**
  [Discussions](https://github.com/snaraj/obsync/discussions).
- **버그:** 버그 보고 템플릿과 [문제 해결](../troubleshooting.md)에 설명된 보고서를 함께 담아 [이슈를 등록하세요](https://github.com/snaraj/obsync/issues/new/choose). 토큰도, 복구 문구도, 공개하고 싶지 않은 주소도 넣지 마세요.
- **취약점으로 의심되는 것:** 공개 이슈가 아니라 [`SECURITY.md`](../../SECURITY.md)를 통해 비공개로 알려 주세요.

## 라이선스

MIT. [`LICENSE`](../../LICENSE)를 보세요.
