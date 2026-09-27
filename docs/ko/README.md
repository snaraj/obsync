> 이 번역은 [영어 원문](../../README.md)을 따릅니다. 영어 문서가 기준이며, 명령어·플래그·URL·자리표시자는 영어 그대로 두었습니다.

<img src="../../brand/obsync-icon-256.png" alt="obsync 아이콘: 서로 맞물린 두 개의 고리" width="96" height="96">

# Self Hosted Private Sync

[Obsidian](https://obsidian.md)을 위한 자체 호스팅 종단 간 암호화 실시간 동기화입니다. 노트는 직접 운영하는 서버를 통해 동기화됩니다. 노트, 첨부 파일, 파일 이름은 기기에서 암호화되며, 서버는 키를 절대 받지 않습니다. 플러그인은 데스크톱과 모바일을 가리지 않고 Obsidian이 실행되는 모든 플랫폼에서 동작합니다. 구독도, 다른 어딘가의 계정도 없습니다.

**문제가 있나요? → [문제 해결](https://snaraj.github.io/obsync/troubleshooting/)(영어)**

## 필요한 문서 찾기

모든 페이지는 [문서 사이트](https://snaraj.github.io/obsync/)(영어)에도 있습니다.

### obsync 사용하기

| 하고 싶은 일 | 볼 문서 |
| --- | --- |
| 기기가 서버에 연결되는 방식 고르기 | [구성 고르기](../setup.md) |
| 휴대폰 화면 하나하나를 보며 집 네트워크에서 모두 설정하기 | [같은 네트워크, 단계별로](../same-network.md) |
| 플러그인 설치하기 | [플러그인 설치하기](../community-plugin.md) |
| 첫 기기 설정하기 | [빠른 시작](../quickstart.md) |
| 휴대폰이나 다른 컴퓨터 페어링하기 | [휴대폰 페어링하기](../quickstart.md#pair-your-phone) |
| 상태 아이콘과 명령어의 의미 알기 | [일상 사용](../daily-use.md)과 [상태 표시줄 읽기](../troubleshooting.md#reading-the-status-bar) |
| 노트의 이전 버전 되찾기 | [보관된 버전 복원하기](../daily-use.md#restore-a-retained-version) |
| 설정 항목이 하는 일 알기 | [설정](../settings.md) |
| 충돌 사본 처리하기 | [충돌](../conflicts.md) |
| 문제 해결하기 | [문제 해결](../troubleshooting.md) |
| 기기를 잃어버린 뒤 다시 들어가기 | [복구](../recovery.md) |
| 보관함을 다른 서버로 옮기기 | [이 보관함을 다른 서버로 옮기기](../recovery.md#moving-this-vault-to-a-different-server) |

### 서버 운영하기

| 하고 싶은 일 | 볼 문서 |
| --- | --- |
| Docker나 Compose로 서버 실행하기 | [서버 실행하기](../server.md) |
| 내 프록시(Caddy, nginx, Traefik, HAProxy) 뒤에 두기 | [TLS 종단이 이미 있다면](../server.md#already-have-a-tls-terminator-docker) |
| 컨테이너 없이 systemd로 실행하기 | [정적 바이너리](../server.md#without-a-container-the-static-binary) |
| Kubernetes에서 서버 실행하기 | [Kubernetes](../kubernetes.md)와 [차트 레퍼런스](../../chart/README.md) |
| 내 VPN이나 프록시를 통해 집 밖에서 서버에 닿기 | [LAN 밖에서 닿기](../server.md#reaching-it-from-outside-your-lan) |
| Cloudflare 쓰기(선택 사항) | [Cloudflare](cloudflare.md) |
| 각 기기에서 서버 인증서 신뢰하기 | [인증 기관 신뢰하기](../server.md#trust-the-certificate-authority-once-per-device) |
| 필요한 메모리와 디스크 용량 알기 | [필요한 메모리](../server.md#how-much-memory-it-needs)와 [저장소](../storage.md) |
| 서버 백업하기 | [두 볼륨 백업하기](../server.md#back-up-the-two-volumes) |
| 서버 업그레이드하기 | [다이제스트로 업그레이드하기](../server.md#upgrade-by-digest) |
| 내 기기 목록을 보고 하나를 해지하기 | [대시보드](../dashboard.md) |
| 서버를 지우고 처음부터 다시 시작하기 | [서버 초기화](../purge.md) |
| 버전마다 무엇이 바뀌었는지 보기 | [`CHANGELOG.md`](../../CHANGELOG.md) |

### 신뢰와 개인정보

| 하고 싶은 일 | 볼 문서 |
| --- | --- |
| 이 플러그인이 내 기기와 네트워크에서 무엇을 건드리는지 알기 | [이 플러그인이 접근하는 것](#이-플러그인이-접근하는-것) |
| 무엇이 암호화되고 서버가 무엇을 볼 수 있는지 이해하기 | [위협 모델](../threat-model.md)과 [대시보드의 위협 모델](../security/dashboard.md) |
| 보안 문제 신고하기 | [`SECURITY.md`](../../SECURITY.md) |

### 프로젝트 내부

기여자와 리뷰어를 위한 문서: [`CONTRIBUTING.md`](../../CONTRIBUTING.md), [아키텍처](../architecture.md), [프로토콜](../protocol.md), [벤치마크](../benchmarks.md), [기기 검증 실행](../validation-runs/), 그리고 [모든 페이지](../README.md).

## 설치

![Get started로 시작하는 플러그인 설정: Server URL 입력란 위에 Setup guide 행과 그 행의 Open the guide 버튼이 있습니다](../assets/settings-get-started.png)

**설정 → 커뮤니티 플러그인 → 탐색**에서 플러그인을 설치하세요. **Self Hosted Private Sync**(플러그인 ID `obsync-private-sync`)를 검색합니다. Obsidian 1.13.0 이상이 필요합니다. 플러그인 설정은 설정 가이드로 시작하며, 버튼 한 번이면 열립니다.

> [!IMPORTANT]
> - **당신이** 직접 운영하는 서버와 동기화합니다. 호스팅 서비스도, 다른 어딘가의 계정도 없습니다.
> - 먼저 보관함을 백업하고, 24단어 복구 문구는 그것을 만든 기기가 아닌 곳에 보관하세요.
> - 하나의 보관함에서 다른 동기화 수단(Obsidian Sync, 클라우드 폴더, 또 다른 플러그인)과 나란히 쓰지 마세요.
> - 아직 어린 소프트웨어입니다. 쓰는 버전의 [`CHANGELOG.md`](../../CHANGELOG.md) 항목을 읽고, 모든 기기를 업데이트하고, 각 [검증 실행](../validation-runs/)이 무엇을 다뤘는지 알아 두세요.

## 동기화 시작하기

빠짐없이 갖춘 가장 짧은 경로는, 이 저장소를 체크아웃해 자신의 네트워크에서 Caddy와 함께 Compose를 쓰는 것입니다. 어느 네트워크에서나 HTTPS를 쓸 수 있고, 도메인도 어디의 계정도 필요 없습니다. [같은 네트워크, 단계별로](../same-network.md)가 모든 화면과 함께 이 경로를 안내합니다. 아래의 `vX.Y.Z`는 설치하려는 릴리스, 즉 [Releases 페이지](https://github.com/snaraj/obsync/releases/latest)의 최신 태그로 바꾸세요.

**1. 이미지를 검증합니다.** 그다음 검증이 출력한 다이제스트를 그대로 실행합니다:

```sh
cosign verify ghcr.io/snaraj/obsync:vX.Y.Z \
  --certificate-identity https://github.com/snaraj/obsync/.github/workflows/release-publisher.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

**2. 서버를 시작합니다:**

```sh
OBSYNC_IMAGE=ghcr.io/snaraj/obsync@sha256:<digest> \
  OBSYNC_HOST=sync.example.org \
  OBSYNC_BIND_ADDRESS=192.168.1.10 \
  docker compose -f deploy/compose/docker-compose.yml up -d
```

`OBSYNC_HOST`는 기기에 입력할 이름입니다. 자신의 네트워크 안에서만 풀리면 됩니다. `OBSYNC_BIND_ADDRESS`는 포트 80과 443이 게시되는 주소입니다. 바인드 주소는 출발지가 아니라 목적지 인터페이스를 제한하므로, 누가 여기에 닿을지는 방화벽이 결정합니다. 선택하기 전까지 Compose는 시작되지 않습니다.

**3. 설정 토큰을 읽습니다.** 첫 부팅 때 서버는 설정 토큰을 발급해 저널 볼륨에 모드 0600으로 기록하며, 로그에는 절대 남기지 않습니다. 이 토큰은 계정을 한 번 만들고, 그 뒤에도 대시보드의 복구용 로그인으로 남습니다. 복구 문구만큼 소중히 보관하세요:

```sh
docker cp obsync-obsync-1:/data/journal/v1/setup-token - | tar -xO
```

**4. 각 기기를 설정합니다.** 서버의 인증서를 한 번 신뢰합니다([방법](../server.md#trust-the-certificate-authority-once-per-device)). 플러그인을 설치한 다음 [빠른 시작](../quickstart.md)을 따라 첫 기기를 설정하고, 나머지 기기를 페어링합니다.

신뢰하는 프록시나 터널이 이미 앞단에서 HTTPS를 제공하나요? 그렇다면 대신 [단독 서버](../server.md#already-have-a-tls-terminator-docker)를 실행하세요.

## 이 플러그인이 접근하는 것

- **당신의 서버, 그 밖에는 없습니다.** 모든 요청은 직접 입력한 **Server URL**로 갑니다. 텔레메트리도, 제3자도 없습니다.
- **그 서버의 계정**, 설정 토큰으로 만들어집니다. 당신의 Obsidian 계정은 아무 역할도 하지 않습니다.
- **Obsidian을 통한 GitHub Releases**, 설치와 업데이트에 쓰입니다. Obsidian은 그 밖의 릴리스 자산을 무시합니다.
- **보관함의 파일 목록**, 무엇을 동기화할지 정하는 데 씁니다. 숨김 폴더(`.obsidian`, `.git`)와 심볼릭 링크 폴더는 건너뜁니다.
- **클립보드, 쓰기만 합니다.** **Pair a new device** 안의 **Copy code**와 **Copy link**만 쓰며, 절대 읽지 않습니다.
- **설정 가이드를 요청할 때의 브라우저.** 프로젝트의 가이드가 브라우저에서 열립니다. 플러그인 자체는 아무것도 보내지 않습니다.

서버가 볼 수 있는 것과 볼 수 없는 것: [`SECURITY.md`](../../SECURITY.md)와 [위협 모델](../threat-model.md).

## 버전

LATEST 릴리스는 [Releases 페이지](https://github.com/snaraj/obsync/releases/latest)의 최신 태그입니다. Obsidian이 설치하고 업데이트하는 대상이 바로 이것입니다. `main`은 EDGE입니다. 병합됐지만 아직 릴리스되지 않은 작업으로, 소스에서 빌드하는 사람을 위한 것입니다. 베타 채널도, 프리릴리스 태그도 없습니다. 변경 기록의 Unreleased 섹션이 EDGE의 기록입니다.

## 질문, 버그, 보안

- **질문이 있거나 버그인지 확실하지 않을 때:** [Discussions](https://github.com/snaraj/obsync/discussions).
- **버그:** [문제 해결](../troubleshooting.md#how-to-collect-a-report)에서 설명하는 보고서를 첨부해 [이슈를 여세요](https://github.com/snaraj/obsync/issues/new/choose). 공개하고 싶지 않은 토큰, 문구, 주소는 빼 주세요.
- **취약점이 의심될 때:** 공개 이슈가 아니라 [`SECURITY.md`](../../SECURITY.md)를 통해 비공개로 알려 주세요.

## 라이선스

MIT. [`LICENSE`](../../LICENSE)를 참고하세요.
