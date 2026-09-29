> To tłumaczenie podąża za [angielskim oryginałem](../../README.md). Tekst angielski jest wersją kanoniczną; polecenia, flagi, adresy URL i symbole zastępcze pozostają bez zmian.

<img src="../../brand/obsync-icon-256.png" alt="ikona obsync: dwa splecione pierścienie" width="96" height="96">

# Self Hosted Private Sync

Samodzielnie hostowana, szyfrowana od końca do końca synchronizacja na żywo
dla [Obsidiana](https://obsidian.md). Twoje notatki synchronizują się przez
serwer, który prowadzisz sam. Notatki, załączniki i nazwy plików są
szyfrowane na Twoim urządzeniu, a serwer nigdy nie dostaje klucza. Wtyczka
działa na każdej platformie, na której działa Obsidian, na komputerze i na
telefonie. Bez abonamentu i bez konta gdziekolwiek indziej.

**Coś nie działa? → [Rozwiązywanie problemów](https://snaraj.github.io/obsync/troubleshooting/)**

## Znajdź to, czego potrzebujesz

Każda strona jest też w [serwisie dokumentacji](https://snaraj.github.io/obsync/).
Strony, do których prowadzą linki, są po angielsku.

### Korzystanie z obsync

| Chcę… | Przejdź do |
| --- | --- |
| Wybrać, jak moje urządzenia łączą się z moim serwerem | [Wybierz konfigurację](../setup.md) |
| Skonfigurować wszystko w sieci domowej, z każdym ekranem telefonu | [Ta sama sieć, krok po kroku](../same-network.md) |
| Zainstalować wtyczkę | [Instalacja wtyczki](../community-plugin.md) |
| Skonfigurować pierwsze urządzenie | [Szybki start](../quickstart.md) |
| Sparować telefon lub inny komputer | [Sparuj telefon](../quickstart.md#pair-your-phone) |
| Wiedzieć, co oznaczają ikona stanu i polecenia | [Codzienne użytkowanie](../daily-use.md) i [Jak czytać pasek stanu](../troubleshooting.md#reading-the-status-bar) |
| Odzyskać starszą wersję notatki | [Przywracanie zachowanej wersji](../daily-use.md#restore-a-retained-version) |
| Wiedzieć, co robi dane ustawienie | [Ustawienia](../settings.md) |
| Poradzić sobie z kopią konfliktu | [Konflikty](../conflicts.md) |
| Naprawić problem | [Rozwiązywanie problemów](../troubleshooting.md) |
| Wrócić do sejfu po utracie urządzenia | [Odzyskiwanie](../recovery.md) |
| Przenieść sejf na inny serwer | [Przenoszenie tego sejfu na inny serwer](../recovery.md#moving-this-vault-to-a-different-server) |

### Prowadzenie serwera

| Chcę… | Przejdź do |
| --- | --- |
| Uruchomić serwer przez Dockera lub Compose | [Uruchamianie serwera](../server.md) |
| Postawić go za własnym proxy (Caddy, nginx, Traefik, HAProxy) | [Masz już terminator TLS](../server.md#already-have-a-tls-terminator-docker) |
| Uruchomić go bez kontenera, pod systemd | [Statyczna binarka](../server.md#without-a-container-the-static-binary) |
| Uruchomić serwer na Kubernetesie | [Kubernetes](../kubernetes.md) i [dokumentacja chartu](../../chart/README.md) |
| Łączyć się z serwerem poza domem, przez własny VPN lub proxy | [Dostęp spoza sieci LAN](../server.md#reaching-it-from-outside-your-lan) |
| Użyć Cloudflare (opcjonalnie) | [Cloudflare](cloudflare.md) |
| Zaufać certyfikatowi serwera na każdym urządzeniu | [Zaufaj urzędowi certyfikacji](../server.md#trust-the-certificate-authority-once-per-device) |
| Wiedzieć, ile pamięci i miejsca na dysku potrzebuje | [Ile pamięci potrzebuje](../server.md#how-much-memory-it-needs) i [Przechowywanie danych](../storage.md) |
| Zrobić kopię zapasową serwera | [Kopia zapasowa dwóch wolumenów](../server.md#back-up-the-two-volumes) |
| Zaktualizować serwer | [Aktualizacja przez digest](../server.md#upgrade-by-digest) |
| Zobaczyć swoje urządzenia i unieważnić jedno z nich | [Panel](../dashboard.md) |
| Wyczyścić serwer i zacząć od nowa | [Czyszczenie serwera](../purge.md) |
| Zobaczyć, co zmieniło się w każdej wersji | [`CHANGELOG.md`](../../CHANGELOG.md) |

### Zaufanie i prywatność

| Chcę… | Przejdź do |
| --- | --- |
| Wiedzieć, do czego ta wtyczka ma dostęp na moim urządzeniu i w mojej sieci | [Do czego ta wtyczka ma dostęp](#do-czego-ta-wtyczka-ma-dostęp) |
| Zrozumieć, co jest szyfrowane i co widzi serwer | [Model zagrożeń](../threat-model.md) i [model zagrożeń panelu](../security/dashboard.md) |
| Zgłosić problem z bezpieczeństwem | [`SECURITY.md`](../../SECURITY.md) |

### Wnętrze projektu

Dla współtwórców i recenzentów: [`CONTRIBUTING.md`](../../CONTRIBUTING.md),
[architektura](../architecture.md), [protokół](../protocol.md),
[benchmarki](../benchmarks.md),
[przebiegi walidacyjne na urządzeniach](../validation-runs/) i
[wszystkie strony](../README.md).

## Instalacja

![Ustawienia wtyczki otwierają się sekcją Get started: wiersz Setup guide z przyciskiem Open the guide, nad polem Server URL](../assets/settings-get-started.png)

Zainstaluj wtyczkę przez **Ustawienia → Wtyczki społeczności → Przeglądaj**.
Wyszukaj **Self Hosted Private Sync** (identyfikator wtyczki
`obsync-private-sync`). Wymaga Obsidiana 1.13.0 lub nowszego. Jej ustawienia
otwierają się przewodnikiem konfiguracji, jedno kliknięcie dalej.

> [!IMPORTANT]
> - Synchronizuje się z serwerem, który prowadzisz **Ty**: bez usługi hostowanej, bez konta gdziekolwiek indziej.
> - Najpierw zrób kopię zapasową sejfu; 24-wyrazową frazę odzyskiwania trzymaj poza urządzeniem, które ją wygenerowało.
> - Nigdy nie używaj jej obok innej synchronizacji (Obsidian Sync, folder w chmurze, inna wtyczka) na jednym sejfie.
> - Młode oprogramowanie: przeczytaj wpis [`CHANGELOG.md`](../../CHANGELOG.md) dotyczący Twojej wersji, zaktualizuj każde urządzenie i wiedz, co objął każdy [przebieg walidacyjny](../validation-runs/).

## Zacznij synchronizować

Najkrótsza pełna droga to Compose z Caddym we własnej sieci, z lokalnej kopii
tego repozytorium. Daje HTTPS w dowolnej sieci, bez domeny i bez konta
gdziekolwiek. [Ta sama sieć, krok po kroku](../same-network.md) prowadzi przez
nią z każdym ekranem. Zastąp poniżej `vX.Y.Z` wydaniem, które instalujesz:
najnowszym tagiem na
[stronie Releases](https://github.com/snaraj/obsync/releases/latest).

**1. Zweryfikuj obraz.** Potem uruchom dokładnie ten digest, który wypisało
polecenie:

```sh
cosign verify ghcr.io/snaraj/obsync:vX.Y.Z \
  --certificate-identity https://github.com/snaraj/obsync/.github/workflows/release-publisher.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

**2. Uruchom serwer:**

```sh
OBSYNC_IMAGE=ghcr.io/snaraj/obsync@sha256:<digest> \
  OBSYNC_HOST=sync.example.org \
  OBSYNC_BIND_ADDRESS=192.168.1.10 \
  docker compose -f deploy/compose/docker-compose.yml up -d
```

`OBSYNC_HOST` to nazwa, którą będą wpisywać Twoje urządzenia. Musi się
rozwiązywać tylko w Twojej własnej sieci. `OBSYNC_BIND_ADDRESS` to adres, na
którym publikowane są porty 80 i 443: adres nasłuchu ogranicza interfejs
docelowy, a nie źródło, więc o tym, kto go osiągnie, decyduje Twoja zapora.
Compose odmawia startu, dopóki nie dokonasz wyboru.

**3. Odczytaj token konfiguracji.** Przy pierwszym uruchomieniu serwer
generuje token konfiguracji i zapisuje go na swoim wolumenie dziennika, z
uprawnieniami 0600, nigdy do logów. Token zakłada Twoje konto jeden raz i
pozostaje awaryjnym logowaniem do panelu. Strzeż go tak samo jak frazy
odzyskiwania:

```sh
docker exec obsync-obsync-1 obsyncd setup-token
```

```sh
docker cp obsync-obsync-1:/data/journal/v1/setup-token - | tar -xO
```

**4. Skonfiguruj każde urządzenie.** Zaufaj certyfikatowi serwera, raz na
urządzenie ([jak](../server.md#trust-the-certificate-authority-once-per-device)).
Zainstaluj wtyczkę, a potem postępuj według [Szybkiego startu](../quickstart.md):
skonfiguruj pierwsze urządzenie, a następnie sparuj pozostałe.

Masz już HTTPS przed serwerem, z proxy albo z tunelu, któremu ufasz? Uruchom
zamiast tego [goły serwer](../server.md#already-have-a-tls-terminator-docker).

## Do czego ta wtyczka ma dostęp

- **Twój serwer i nic więcej.** Każde żądanie trafia pod **Server URL**, który wpisujesz; żadnej telemetrii, żadnego podmiotu trzeciego.
- **Konto na tym serwerze**, zakładane z tokenu konfiguracji; Twoje konto Obsidiana nie odgrywa tu żadnej roli.
- **Wydania GitHub, przez Obsidiana**, do instalacji i aktualizacji; dodatkowe zasoby wydania Obsidian ignoruje.
- **Lista plików Twojego sejfu**, aby zdecydować, co synchronizować; pomija foldery ukryte (`.obsidian`, `.git`) i te będące dowiązaniami symbolicznymi.
- **Schowek, wyłącznie do zapisu**, przez **Copy code** i **Copy link** w **Pair a new device**; nigdy nie jest odczytywany.
- **Twoja przeglądarka, gdy poprosisz o przewodnik konfiguracji.** Otwiera się w niej przewodnik projektu; sama wtyczka niczego nie wysyła.

Co serwer może, a czego nie może zobaczyć: [`SECURITY.md`](../../SECURITY.md) i [model zagrożeń](../threat-model.md).

## Wersje

Wydanie LATEST to najnowszy tag na
[stronie Releases](https://github.com/snaraj/obsync/releases/latest). To je
Obsidian instaluje i do niego aktualizuje. `main` to EDGE: praca scalona, ale
jeszcze niewydana, dla osób budujących ze źródeł. Nie ma kanału beta ani
tagów przedpremierowych. Sekcja „Unreleased” w dzienniku zmian opisuje, co
jest w EDGE.

## Pytania, błędy i bezpieczeństwo

- **Pytanie albo coś, przy czym nie masz pewności, czy to błąd:** [Discussions](https://github.com/snaraj/obsync/discussions).
- **Błąd:** [otwórz zgłoszenie](https://github.com/snaraj/obsync/issues/new/choose) z raportem opisanym w [Rozwiązywaniu problemów](../troubleshooting.md#how-to-collect-a-report). Pomiń każdy token, frazę i adres, których nie chcesz publikować.
- **Podejrzenie podatności:** prywatnie, przez [`SECURITY.md`](../../SECURITY.md), nigdy jako publiczne zgłoszenie.

## Licencja

MIT. Zobacz [`LICENSE`](../../LICENSE).
