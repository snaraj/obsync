> To tłumaczenie podąża za [angielskim oryginałem](../../README.md). Tekst angielski jest wersją kanoniczną; polecenia, flagi, adresy URL i symbole zastępcze pozostają bez zmian.

<img src="../../brand/obsync-icon-256.png" alt="ikona obsync: dwa splecione pierścienie" width="96" height="96">

# Self Hosted Private Sync

Samodzielnie hostowana, szyfrowana od końca do końca synchronizacja na żywo
dla [Obsidiana](https://obsidian.md): jeden pozbawiony zależności serwer
napisany w języku Rust, z wbudowanym panelem, który prowadzisz samodzielnie,
plus ta wtyczka. Pliki dowolnego rozmiaru, każda platforma Obsidiana, bez
abonamentu, bez podmiotów trzecich.

Zainstaluj ją przez Ustawienia → Wtyczki społeczności → Przeglądaj jako
**Self Hosted Private Sync** (identyfikator wtyczki `obsync-private-sync`), w
Obsidianie 1.13.0 lub nowszym.

**Jesteś tu pierwszy raz? Zacznij od [przewodnika konfiguracji](https://snaraj.github.io/obsync/setup/) (po angielsku).** Pomaga wybrać, jak urządzenia łączą się z serwerem, i prowadzi krok po kroku przez każdą opcję. W Obsidianie: Ustawienia → Self Hosted Private Sync → Setup guide.

> [!IMPORTANT]
> - Synchronizuje się z serwerem, który prowadzisz **Ty**: bez usługi hostowanej, bez konta gdziekolwiek indziej.
> - Najpierw zrób kopię zapasową sejfu; 24-wyrazową frazę odzyskiwania trzymaj poza urządzeniem, które ją wygenerowało.
> - Nigdy nie używaj jej obok innej synchronizacji (Obsidian Sync, folder w chmurze, inna wtyczka) na jednym sejfie.
> - Młode oprogramowanie: przeczytaj wpis [`CHANGELOG.md`](../../CHANGELOG.md) dotyczący Twojej wersji, zaktualizuj każde urządzenie i wiedz, co objął każdy [przebieg walidacyjny](../validation-runs/).

## Do czego ta wtyczka ma dostęp

- **Twój serwer i nic więcej.** Każde żądanie trafia pod **Server URL**, który wpisujesz; żadnej telemetrii, żadnego podmiotu trzeciego.
- **Konto na tym serwerze**, zakładane z tokenu konfiguracji; Twoje konto Obsidiana nie odgrywa tu żadnej roli.
- **Wydania GitHub, przez Obsidiana**, do instalacji i aktualizacji; dodatkowe zasoby wydania Obsidian ignoruje.
- **Lista plików Twojego sejfu**, aby zdecydować, co synchronizować; pomija foldery ukryte (`.obsidian`, `.git`) i te będące dowiązaniami symbolicznymi.
- **Schowek, wyłącznie zapisywany** przez **Copy code** i **Copy link** w **Pair a new device**, nigdy odczytywany.

Co serwer może, a czego nie może zobaczyć:
[`SECURITY.md`](../../SECURITY.md) i [model zagrożeń](../threat-model.md).

## Zacznij synchronizować

Pięć kroków od zera do dwóch zsynchronizowanych urządzeń. `v1.0.6` to wydanie,
pod które ta strona została napisana; użyj tagu wydania, które instalujesz.

### 1. Uruchom serwer

Sprawdź podpis, a potem uruchom dokładnie ten digest, który został wypisany:

```sh
cosign verify ghcr.io/snaraj/obsync:v1.0.6 \
  --certificate-identity https://github.com/snaraj/obsync/.github/workflows/release-publisher.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Najprostsza droga to Compose z Caddym, z lokalnej kopii tego repozytorium:
HTTPS w dowolnej sieci, bez domeny, bez konta u kogokolwiek.

```sh
OBSYNC_IMAGE=ghcr.io/snaraj/obsync@sha256:<digest> \
  OBSYNC_HOST=sync.example.org \
  OBSYNC_BIND_ADDRESS=192.168.1.10 \
  docker compose -f deploy/compose/docker-compose.yml up -d
```

`OBSYNC_HOST` to nazwa, którą będą wpisywać Twoje urządzenia; musi rozwiązywać
się tylko w Twojej własnej sieci. `OBSYNC_BIND_ADDRESS` to adres, na którym
publikowane są porty 80 i 443: adres nasłuchu ogranicza interfejs docelowy, a
nie źródło, więc o tym, kto go osiągnie, decyduje Twoja zapora. Compose odmawia
startu, dopóki nie dokonasz wyboru.

Masz już HTTPS przed serwerem, z proxy albo z tunelu, któremu ufasz? Uruchom
zamiast tego goły serwer: [Uruchamianie serwera](../server.md).

### 2. Odczytaj token konfiguracji

Przy pierwszym uruchomieniu serwer wybija token konfiguracji i zapisuje go na
swoim wolumenie dziennika, z uprawnieniami 0600, nigdy do logów. Token zakłada
Twoje konto jeden raz i pozostaje awaryjnym logowaniem do panelu: strzeż go tak
samo jak frazy odzyskiwania. Odczytaj go z kontenera:

```sh
docker cp obsync-obsync-1:/data/journal/v1/setup-token - | tar -xO
```

### 3. Zaufaj certyfikatowi, raz na urządzenie

Caddy podpisuje urzędem certyfikacji, który sam wygenerował przy pierwszym
starcie; każde urządzenie musi mu raz zaufać. Wyeksportuj certyfikat główny i
zainstaluj go na każdej platformie tak, jak pokazuje
[Uruchamianie serwera](../server.md#trust-the-certificate-authority-once-per-device);
na iOS zaufanie certyfikatowi to drugi przełącznik po jego zainstalowaniu.

### 4. Skonfiguruj pierwsze urządzenie

1. Ustawienia → Wtyczki społeczności → Przeglądaj → **Self Hosted Private
   Sync** → Instaluj → Włącz.
2. Ustaw **Server URL** na swój serwer (`https://sync.example.org`, z portem,
   jeśli nie jest to 443), a potem wybierz **Whole vault** albo **Selected
   folders only**; później wybór może się już tylko zawęzić.

   ![Karta ustawień wtyczki: pole Server URL z demonstracyjną nazwą hosta, pole nagłówków brzegu sieci i wiersz Connection z przyciskami Check oraz Open dashboard](../assets/settings-server.png)

3. Wklej token konfiguracji w **First-time setup**, wybierz **Set up** i zapisz
   24-wyrazową frazę odzyskiwania.

   ![Sekcja This device karty ustawień: wiersz Pairing z Pair this device i Pair a new device, wiersz First-time setup z polem Setup token i przyciskiem Set up oraz wiersz Vault key](../assets/settings-setup.png)

### 5. Sparuj drugie urządzenie

1. Zainstaluj tam wtyczkę z tym samym **Server URL**; na pierwszym urządzeniu
   uruchom **Pair a new device**, aby otrzymać kod ważny przez dziesięć minut.

   ![Okno Pair a new device na pierwszym urządzeniu, jego kod zamazany, z przyciskami Copy code i Copy link oraz wierszem Waiting for the new device](../assets/pair-new-device.png)

2. Na drugim urządzeniu otwórz **Pair this device**, wklej kod i wybierz
   **Pair**.
3. Wróć na pierwsze urządzenie i zatwierdź je po nazwie. Zmień notatkę na
   dowolnym z nich; pojawi się na drugim w ciągu kilku sekund.

   ![Pierwsze urządzenie pyta, czy zatwierdzić nowe urządzenie po nazwie, z przyciskami Approve i Reject](../assets/pair-approve.png)

![Animacja: kod parowania pokazany na pierwszym urządzeniu, wklejony na drugim, zatwierdzony na pierwszym, i pierwsza notatka docierająca na drugie](../assets/pairing.gif)

Próbujesz na jednym komputerze? Na komputerze `http://127.0.0.1:8080` sięga do
gołego serwera; Obsidian na iOS i Androidzie odmawia zwykłego HTTP.

Zrzutów ekranu z telefonu jeszcze w tym repozytorium nie ma; powstają na
własnych urządzeniach opiekuna i są dodawane, gdy odnotuje je przebieg
walidacyjny.

Każdy krok w całości: [Szybki start](../quickstart.md).

## Zaawansowane: Cloudflare

Instalacja referencyjna nie ma publicznej nazwy hosta: Cloudflare Tunnel i
trasa prywatna sięgają do sieci serwera, a klient Cloudflare One na każdym
urządzeniu przenosi tam Server URL. Publiczna nazwa hosta za Cloudflare
Access, z tokenem usługi w **Edge service-token headers** i
`OBSYNC_EDGE=cloudflare`, też działa. Oba warianty krok po kroku:
[Cloudflare](cloudflare.md).

## Inne sposoby dotarcia do Twojego serwera

Cokolwiek wybierzesz, wtyczka potrzebuje HTTPS z certyfikatem, któremu ufa
każde urządzenie; sam serwer zostaje przy zwykłym HTTP za tym terminatorem.

- **Tylko LAN.** Ścieżka Compose powyżej, osiągalna tylko w domu; żadnej synchronizacji poza domem.
- **WireGuard.** Twój własny VPN do domu: najszybszy i w całości Twój; konfiguracja peera na każdym urządzeniu.
- **Tailscale.** Zarządzana siatka WireGuard: najmniej konfiguracji; koordynuje ją podmiot trzeci, na warunkach swojego planu.
- **Reverse proxy z automatycznym TLS**, na przykład Caddy na publicznej nazwie: osiągalny z internetu, Twój do łatania.
- **Cloudflare Tunnel.** Powyżej. Żadnego portu przychodzącego; dostawca na ścieżce, na swoich warunkach.

Czego potrzebuje urządzenie w podróży (trasa, nazwa, certyfikat, zapora,
pytanie iOS o sieć lokalną):
[Sięganie do serwera spoza Twojej sieci LAN](../server.md#reaching-it-from-outside-your-lan).

## Rozwiązywanie problemów

| Objaw | Prawdopodobna przyczyna | Co spróbować najpierw |
| --- | --- | --- |
| `obsync: offline` | Urządzenie nie sięga do Server URL | Otwórz ten adres w przeglądarce na tym samym urządzeniu; sprawdź port, HTTPS i trasę |
| Telefon nie chce się połączyć, podczas gdy komputer synchronizuje | Telefon nie ufa prywatnemu certyfikatowi | Zainstaluj certyfikat główny; na iOS włącz go dodatkowo w „Ustawieniach zaufania certyfikatów” |
| `401 stale_timestamp` | Zegar myli się o więcej niż 300 sekund | Włącz automatyczny czas, na urządzeniu albo na serwerze |
| `403 device_pending` | Nikt jeszcze nie zatwierdził urządzenia | Zatwierdź je po nazwie na urządzeniu, z którego je sparowano |
| Plik nigdy nie dociera | Leży poza wyborem folderów albo powyżej limitu rozmiaru na telefonie | Sprawdź **Sync folders on this device**; na telefonie uruchom **Show remote-only files** |

Każdy inny objaw i kod błędu oraz jak zgłosić problem:
[Rozwiązywanie problemów](../troubleshooting.md).

## Dokumentacja

[Szybki start](../quickstart.md) · [Uruchamianie serwera](../server.md) ·
[Cloudflare](cloudflare.md) · [Codzienne użytkowanie](../daily-use.md) ·
[Ustawienia](../settings.md) ·
[Rozwiązywanie problemów](../troubleshooting.md) ·
[Odzyskiwanie](../recovery.md) · [Dziennik zmian](../../CHANGELOG.md)

Wszystko inne: [docs/README.md](../README.md).

## Pytania, błędy i bezpieczeństwo

- **Pytanie albo coś, przy czym nie masz pewności, czy to błąd:** [Discussions](https://github.com/snaraj/obsync/discussions).
- **Błąd:** [otwórz zgłoszenie](https://github.com/snaraj/obsync/issues/new/choose) z raportem opisanym w [Rozwiązywaniu problemów](../troubleshooting.md); bez tokenu, bez frazy, bez adresu, którego nie chcesz publikować.
- **Podejrzenie podatności:** prywatnie, przez [`SECURITY.md`](../../SECURITY.md), nigdy jako publiczne zgłoszenie.

## Licencja

MIT. Zobacz [`LICENSE`](../../LICENSE).
