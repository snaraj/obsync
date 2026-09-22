> To tłumaczenie podąża za [angielskim oryginałem](../../README.md). Tekst angielski jest wersją kanoniczną; polecenia, flagi, adresy URL i symbole zastępcze pozostają bez zmian.

# Self Hosted Private Sync

Samodzielnie hostowana, szyfrowana od końca do końca synchronizacja na żywo
dla [Obsidiana](https://obsidian.md): jeden pozbawiony zależności serwer
napisany w języku Rust, z wbudowanym panelem, który prowadzisz samodzielnie,
plus ta wtyczka. Pliki dowolnego rozmiaru, każda platforma Obsidiana, bez
abonamentu, bez podmiotów trzecich.

Zainstaluj ją przez Ustawienia → Wtyczki społeczności → Przeglądaj jako
**Self Hosted Private Sync** (identyfikator wtyczki `obsync-private-sync`), w
Obsidianie 1.13.0 lub nowszym.

> [!IMPORTANT]
> Ta wtyczka synchronizuje się z serwerem, który prowadzisz **Ty**. Nie ma
> żadnej usługi hostowanej ani konta u kogokolwiek poza Tobą: bez własnego
> `obsyncd`, osiągalnego przez HTTPS, wtyczka nie ma się z czym
> synchronizować.

> [!IMPORTANT]
> Zrób kopię zapasową swojego sejfu przed pierwszą synchronizacją i trzymaj
> 24-wyrazową frazę odzyskiwania gdzie indziej niż na urządzeniu, które ją
> wygenerowało. Serwer przechowuje wyłącznie szyfrogram i nie odzyska sejfu
> za Ciebie.

> [!IMPORTANT]
> Nie używaj tej wtyczki obok innego rozwiązania synchronizującego ten sam
> sejf — Obsidian Sync, folderu w chmurze synchronizującego pliki ani innej
> wtyczki synchronizacji. Dwa programy zapisujące do jednego sejfu tworzą
> konflikty, których żaden z nich nie potrafi pogodzić.

## Zanim zaczniesz na tym polegać

To młode oprogramowanie, które synchronizuje jedyną kopię Twoich notatek.

- **[`CHANGELOG.md`](../../CHANGELOG.md) jest utrzymywaną listą tego, co
  wiadomo.** Przeczytaj wpis dotyczący wersji, której używasz, oraz wpisy nad
  nim. Strony wydań zachowują notatki, z którymi zostały opublikowane;
  późniejsze ustalenia trafiają tutaj.
- **Zaktualizuj każde urządzenie, które synchronizuje sejf.** Jedno
  urządzenie pozostawione na starszej wersji nadal może działać według
  starego zachowania i wpływać na pozostałe.
- **Co zostało sprawdzone na sprzęcie**, jest odnotowane osobno dla każdego
  przebiegu w [`docs/validation-runs/`](../validation-runs/), łącznie z tym,
  czego dany przebieg nie objął. Platforma, której nie wymienia żaden
  przebieg, nie jest dowiedziona.
- **Strumień powiadomień „merged concurrent edits”** na dwóch urządzeniach
  edytujących jedną notatkę: zamknij Obsidiana na jednym z nich, aby drugie
  mogło dokończyć pracę, zaktualizuj oba, a potem wróć do pracy.

## Do czego ta wtyczka ma dostęp

Krótko i wyczerpująco, aby można było zdecydować przed instalacją.

- **Jeden cel sieciowy: Twój własny serwer.** Każde żądanie trafia pod
  **Server URL**, który wpisujesz w ustawieniach wtyczki, i nigdzie indziej.
  Nigdzie na ścieżce synchronizacji nie ma telemetrii, analityki,
  raportowania awarii, reklam ani żadnej usługi podmiotu trzeciego. Wtyczka
  nigdy też nie pobiera z tego serwera kodu ani go nie uruchamia.
- **Konto na tym serwerze, które zakładasz samodzielnie.** Pierwsze
  urządzenie używa tokenu konfiguracji, który Twój serwer zapisał przy
  pierwszym uruchomieniu; każde kolejne urządzenie jest parowane z
  urządzenia, które już synchronizuje. Twoje konto Obsidiana nie odgrywa tu
  żadnej roli.
- **Obsidian i GitHub, wyłącznie do instalacji i aktualizacji.** Sam Obsidian
  pobiera `main.js`, `manifest.json` i `styles.css` z wydań GitHub tego
  repozytorium. Każde wydanie niesie też ZIP wtyczki i manifest wydania dla
  osób wdrażających serwer; Obsidian ignoruje oba.
- **Twój brzeg sieci, tylko jeśli go skonfigurujesz.** Nagłówki, które
  wklejasz w **Edge service-token headers**, podróżują z każdym żądaniem do
  powyższego Server URL, ponieważ proxy, które ich potrzebuje, leży na drodze
  do Twojego serwera.
- **Lista plików Twojego sejfu.** Wtyczka wypisuje każdy plik w sejfie, aby
  zdecydować, co jest w zakresie, czyta pliki wewnątrz Twojego wyboru
  folderów i zapisuje to, co zmieniły inne urządzenia. Ukryte foldery
  (`.obsidian`, `.git`) oraz foldery będące dowiązaniami symbolicznymi są
  pomijane.
- **Schowek, tylko zapisywany, nigdy odczytywany.** Zapisują do niego
  wyłącznie przyciski **Copy code** i **Copy link** w **Pair a new device**.
  Nic we wtyczce nie czyta schowka.
- **Twoja przeglądarka, gdy poprosisz o panel.** **Open dashboard** otwiera
  link logowania w Twojej przeglądarce, i tylko wtedy, gdy ten link leży w
  obrębie własnego origin Twojego serwera.
- **Bezpieczny magazyn sekretów Obsidiana.** Klucz sejfu, sekret urządzenia i
  ewentualne wartości nagłówków brzegu sieci leżą tam, nigdy w zwykłych
  danych wtyczki.

Co serwer może, a czego nie może zobaczyć, opisują
[`SECURITY.md`](../../SECURITY.md) i
[`docs/threat-model.md`](../threat-model.md).

## Synchronizacja w pięciu krokach

Ścieżka, na której zweryfikowano to wydanie, od pustego sejfu do dwóch
zsynchronizowanych urządzeń. Wszystkie pięć kroków zakłada, że Twój własny
serwer już działa, czym zajmuje się sekcja poniżej; każdy krok jest w całości
rozpisany w szybkim starcie.

1. **Zainstaluj z Wtyczek społeczności.** W sekcji Ustawienia → Wtyczki
   społeczności → Przeglądaj wyszukaj **Self Hosted Private Sync** i wybierz
   Instaluj, a potem Włącz — tak samo, jak trafia tu każda inna wtyczka
   Obsidiana, na każdej platformie.

   ![Przeglądarka Wtyczek społeczności w Obsidianie pokazująca Self Hosted Private Sync z przyciskiem Instaluj](../captures/01-install-from-directory.png)

2. **Skieruj ją na swój serwer i skonfiguruj.** Otwórz kartę ustawień
   wtyczki, ustaw **Server URL** na swój własny serwer, wybierz, które
   foldery synchronizuje to urządzenie, a potem wklej swój token konfiguracji
   w **First-time setup**.

   ![Karta ustawień wtyczki przewinięta do wyboru folderów, wiersza Pairing i pola tokenu w First-time setup](../captures/02-first-time-setup.png)

3. **Zachowaj frazę odzyskiwania.** Konfiguracja generuje klucz sejfu na tym
   urządzeniu i pokazuje jeden raz frazę z 24 wyrazów: zapisz ją i trzymaj
   gdzie indziej niż na tym urządzeniu, bo serwer trzyma wyłącznie szyfrogram
   i nie odzyska sejfu za Ciebie.

   ![Okno z frazą odzyskiwania pokazane po pierwszej konfiguracji, jego wyrazy zamazane](../captures/03-recovery-phrase.png)

4. **Sparuj drugie urządzenie jednorazowym kodem.** Uruchom **Pair a new
   device** na pierwszym urządzeniu, wpisz pokazany kod na drugim w ciągu
   dziesięciu minut i zatwierdź urządzenie po nazwie — klucz sejfu podróżuje
   zaszyfrowany sekretem parowania, którego serwer nigdy nie widzi.

   ![Okno Pair a new device na pierwszym urządzeniu, jego jednorazowy kod zamazany](../captures/04-pair-a-new-device.png)

5. **Edytuj na dowolnym z urządzeń i patrz, jak zmiana dociera.** Napisz coś
   w notatce na jednym urządzeniu, a pojawi się to na drugim w ciągu kilku
   sekund, w obie strony, podczas gdy pasek stanu pokazuje, co robi
   synchronizacja.

   ![Jednorazowa notatka niosąca zmiany z obu urządzeń, z widocznym paskiem stanu synchronizacji](../captures/05-sync-both-ways.png)

Lista urządzeń w panelu i jej przycisk unieważniania są opisane w
[Zobacz swoje urządzenia](../daily-use.md#see-your-devices) i nie zostały
sprawdzone w przebiegu na urządzeniach dla 1.0.0, odnotowanym w
[docs/validation-runs/2026-09-14.md](../validation-runs/2026-09-14.md).

## Zacznij synchronizować

Najkrótsza poprawna droga: jedna maszyna, która należy do Ciebie, prowadzi
serwer, każde urządzenie sięga do niego przez HTTPS, a każde urządzenie
parowane jest raz. Zalogowanie się do Obsidiana niczego tutaj nie autoryzuje;
jedyne konto to to na Twoim serwerze.

### 1. Uruchom serwer

Dwa sposoby uruchomienia. Oba uruchamiają dokładnie te bajty, które podpisał
wydawca: sprawdź podpis, odczytaj digest ze zweryfikowanego wyniku i uruchom
właśnie ten digest. `v1.0.6` to wydanie, pod które ta strona została
napisana; użyj tagu wydania, które instalujesz.

```sh
cosign verify ghcr.io/snaraj/obsync:v1.0.6 \
  --certificate-identity https://github.com/snaraj/obsync/.github/workflows/release-publisher.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

**Nie masz jeszcze HTTPS?** `deploy/compose` uruchamia serwer za jego własnym
terminatorem TLS (Caddy), w dowolnej sieci, bez domeny i bez konta u
kogokolwiek. Z lokalnej kopii tego repozytorium:

```sh
OBSYNC_IMAGE=ghcr.io/snaraj/obsync@sha256:<digest> \
  OBSYNC_HOST=sync.example.org \
  OBSYNC_BIND_ADDRESS=192.168.1.10 \
  docker compose -f deploy/compose/docker-compose.yml up -d
```

`OBSYNC_HOST` to nazwa, którą będą wpisywać Twoje urządzenia. Musi
rozwiązywać się tylko w Twojej własnej sieci. `OBSYNC_BIND_ADDRESS` to adres
tego hosta, na którym publikowane są porty 80 i 443: adres nasłuchu ogranicza
interfejs docelowy, a nie źródło, więc o tym, kto go osiągnie, decyduje Twoja
zapora. Compose odmawia startu, dopóki nie dokonasz wyboru. Oba wyjaśnia
[Uruchamianie serwera](../server.md).

**Masz już HTTPS przed** tą maszyną, z reverse proxy albo z tunelu, któremu
ufasz? Uruchom goły serwer. Mówi zwykłym HTTP na porcie 8080, a Twój
terminator przekazuje do niego ruch:

```sh
docker volume create obsync-blobs
docker volume create obsync-journal
docker run -d --name obsync -p 127.0.0.1:8080:8080 \
  -v obsync-blobs:/data/blobs -v obsync-journal:/data/journal \
  -e OBSYNC_BLOBS_CAPACITY=250GiB -e OBSYNC_JOURNAL_CAPACITY=4GiB \
  -e OBSYNC_PUBLIC_URL=https://sync.example.org \
  ghcr.io/snaraj/obsync@sha256:<the digest cosign just verified>
```

### 2. Odczytaj token konfiguracji

Przy pierwszym uruchomieniu serwer wybija token konfiguracji i zapisuje go na
swoim wolumenie dziennika, z uprawnieniami 0600, nigdy do logów. Token
zakłada Twoje konto jeden raz, a potem pozostaje awaryjnym logowaniem do
panelu przez całe życie serwera: traktuj go z taką samą troską jak frazę
odzyskiwania. Odczytaj go wprost z kontenera, bez obrazu pomocniczego. Na
ścieżce Compose:

```sh
docker cp obsync-obsync-1:/data/journal/v1/setup-token - | tar -xO
```

Na ścieżce z gołym serwerem:

```sh
docker cp obsync:/data/journal/v1/setup-token - | tar -xO
```

### 3. Zaufaj certyfikatowi, raz na urządzenie (ścieżka Compose)

Caddy wystawił certyfikat z urzędu certyfikacji, który sam wygenerował przy
pierwszym starcie, więc każdemu urządzeniu trzeba raz powiedzieć, aby ufało
temu urzędowi. Wyeksportuj certyfikat główny:

```sh
docker cp obsync-caddy-1:/data/caddy/pki/authorities/local/root.crt - | tar -xO > obsync-root.crt
```

Zainstaluj `obsync-root.crt` na każdym urządzeniu. Kroki dla macOS, Windows,
Linux, iOS i Androida są w
[Zaufaj urzędowi certyfikacji, raz na urządzenie](../server.md#trust-the-certificate-authority-once-per-device).
Na iOS zaufanie certyfikatowi to drugi przełącznik po jego zainstalowaniu.

### 4. Skonfiguruj pierwsze urządzenie

1. Ustawienia → Wtyczki społeczności → Przeglądaj → **Self Hosted Private
   Sync** → Instaluj → Włącz.
2. W ustawieniach wtyczki ustaw **Server URL** na swój serwer, wraz z portem,
   jeśli nie jest to 443: `https://sync.example.org`.

   ![Karta ustawień wtyczki: pole Server URL z demonstracyjną nazwą hosta, pole nagłówków brzegu sieci i wiersz Connection z przyciskami Check oraz Open dashboard](../assets/settings-server.png)

3. Wybierz teraz **Whole vault** albo **Selected folders only**. Gdy
   urządzenie już się zsynchronizuje, jego wybór może się tylko zawęzić.
4. Wklej token konfiguracji w **First-time setup** i wybierz **Set up**.
   Zapisz 24-wyrazową frazę odzyskiwania i trzymaj ją poza tym urządzeniem.

   ![Sekcja This device karty ustawień: wiersz Pairing z Pair this device i Pair a new device, wiersz First-time setup z polem Setup token i przyciskiem Set up oraz wiersz Vault key](../assets/settings-setup.png)

### 5. Sparuj drugie urządzenie

1. Zainstaluj i włącz tam wtyczkę, ustaw ten sam **Server URL** i wybierz
   jego foldery.
2. Na pierwszym urządzeniu uruchom **Pair a new device**. Pokaże kod ważny
   przez dziesięć minut.

   ![Okno Pair a new device na pierwszym urządzeniu, jego kod zamazany, z przyciskami Copy code i Copy link oraz wierszem Waiting for the new device](../assets/pair-new-device.png)

3. Na drugim urządzeniu otwórz **Pair this device**, wklej kod i wybierz
   **Pair**.

   ![Okno Pair this device na drugim urządzeniu, z pustym polem Pairing code i przyciskiem Pair](../assets/pair-this-device.png)

4. Wróć na pierwsze urządzenie i zatwierdź nowe urządzenie po nazwie. Zmień
   notatkę na dowolnym z nich; pojawi się na drugim w ciągu kilku sekund.

   ![Pierwsze urządzenie pyta, czy zatwierdzić nowe urządzenie po nazwie, z przyciskami Approve i Reject](../assets/pair-approve.png)

   ![Drugie urządzenie pokazuje notatkę napisaną na pierwszym urządzeniu, pasek stanu pokazuje obsync idle](../assets/first-sync.png)

Cała wymiana parowania w jednej krótkiej pętli:

![Animacja: kod parowania pokazany na pierwszym urządzeniu, wklejony na drugim, zatwierdzony na pierwszym, i pierwsza notatka docierająca na drugie](../assets/pairing.gif)

Zrzutów ekranu z telefonu jeszcze w tym repozytorium nie ma; powstają na
własnych urządzeniach opiekuna i są dodawane, gdy odnotuje je przebieg
walidacyjny.

Każdy krok w całości, z tym, o co pyta każdy ekran i dlaczego:
[Szybki start](../quickstart.md).

**Próbujesz na jednym komputerze?** Na komputerze wtyczka przyjmuje też
zwykły adres `http://`, więc `http://127.0.0.1:8080` sięga do gołego serwera
powyżej bez terminatora. Telefony nie: Obsidian na iOS i Androidzie odmawia
zwykłego HTTP.

## Zaawansowane: Cloudflare

Instalacja referencyjna nie ma **żadnej publicznej nazwy hosta**. Cloudflare
Tunnel łączy prywatną sieć serwera z Cloudflare, trasa prywatna mówi
Cloudflare, jakie adresy kryją się za tym tunelem, a klient Cloudflare One na
każdym urządzeniu przenosi tam Server URL. Nic nie jest osiągalne z
internetu, a duże pierwsze synchronizacje nie przechodzą przez publiczną
nazwę hosta. Druga postać, publiczna nazwa hosta za Cloudflare Access z
tokenem usługi w **Edge service-token headers** i `OBSYNC_EDGE=cloudflare` na
serwerze, też jest wspierana. Oba warianty krok po kroku:
[Cloudflare](cloudflare.md).

## Inne sposoby dotarcia do Twojego serwera

Po jednym wierszu na każdy, bez instruktażu. Cokolwiek wybierzesz, wtyczka
potrzebuje HTTPS z certyfikatem, któremu ufa każde urządzenie, a sam serwer
zostaje przy zwykłym HTTP za tym terminatorem.

- **Tylko LAN.** Ścieżka Compose powyżej, osiągalna tylko w domu.
  Najprostsza; żadnej synchronizacji poza domem.
- **WireGuard.** Twój własny VPN z powrotem do Twojej sieci. Najszybszy i w
  całości Twój; na każdym urządzeniu nosisz konfigurację peera i utrzymujesz
  jeden punkt końcowy osiągalny.
- **Tailscale.** Zarządzana siatka WireGuard z własnymi nazwami. Najmniej
  konfiguracji na urządzeniach; siatkę koordynuje podmiot trzeci, a jego
  limity w planach musisz przeczytać samodzielnie.
- **Reverse proxy z automatycznym TLS**, na przykład Caddy na publicznej
  nazwie. Publicznie zaufany certyfikat i stały adres; serwer jest wtedy
  osiągalny z internetu, a proxy i jego aktualizacje pozostają Twoją
  odpowiedzialnością.
- **Cloudflare Tunnel.** Powyżej. Żadnego portu przychodzącego; dostawca na
  ścieżce z własnymi warunkami.

Czego potrzebuje urządzenie w podróży, cokolwiek wybierzesz (trasa, nazwa,
certyfikat, pytanie iOS o sieć lokalną, zapora):
[Sięganie do serwera spoza Twojej sieci LAN](../server.md#reaching-it-from-outside-your-lan).

## Rozwiązywanie problemów

| Objaw | Prawdopodobna przyczyna | Co spróbować najpierw |
| --- | --- | --- |
| `obsync: offline` | Urządzenie nie sięga do Server URL | Otwórz ten adres w przeglądarce na tym samym urządzeniu; sprawdź port, HTTPS i trasę |
| Telefon nie chce się połączyć, podczas gdy komputer synchronizuje | Telefon nie ufa prywatnemu certyfikatowi | Zainstaluj certyfikat główny; na iOS włącz go dodatkowo w „Ustawieniach zaufania certyfikatów” |
| `401 stale_timestamp` | Zegar myli się o więcej niż 300 sekund | Włącz automatyczny czas, na urządzeniu albo na serwerze |
| `403 device_pending` | Nikt jeszcze nie zatwierdził urządzenia | Zatwierdź je po nazwie na urządzeniu, z którego je sparowano |
| Plik nigdy nie dociera | Leży poza wyborem folderów albo powyżej limitu rozmiaru na telefonie | Sprawdź **Sync folders on this device**; na telefonie uruchom **Show remote-only files** |

Każdy inny objaw, każdy kod błędu i jak zebrać raport wart wysłania:
[Rozwiązywanie problemów](../troubleshooting.md).

## Dokumentacja

| Strona | Na co odpowiada |
| --- | --- |
| [Szybki start](../quickstart.md) | Pierwsze urządzenie i drugie, każdy krok w całości |
| [Uruchamianie serwera](../server.md) | Docker, Compose z Caddym, certyfikaty, kopie zapasowe, sięganie do serwera spoza Twojej sieci LAN |
| [Cloudflare](cloudflare.md) | Tunel z trasą prywatną i klientem Cloudflare One albo publiczna nazwa hosta za Access |
| [Kubernetes](../../chart/README.md) | Instalacja serwera podpisanym chartem Helm |
| [Codzienne użytkowanie](../daily-use.md) | Polecenia, pasek stanu, co się synchronizuje, a co nie, przywracanie wersji, panel |
| [Ustawienia](../settings.md) | Każde ustawienie, jego wartość domyślna i kiedy je zmienić |
| [Rozwiązywanie problemów](../troubleshooting.md) | Objaw, przyczyna, naprawa i jak zebrać raport |
| [Konflikty](../conflicts.md) | Czym jest kopia konfliktu i co z nią zrobić |
| [Odzyskiwanie](../recovery.md) | Utracone urządzenie, utracony serwer, przeniesiony serwer, zrotowany token |
| [Instalacja i aktualizacje](../community-plugin.md) | Katalog Obsidiana, aktualizacje, przechowywanie danych uwierzytelniających, przegląd wpisu w katalogu |
| [Model zagrożeń](../threat-model.md) | Co jest bronione, a co nie |
| [Model zagrożeń panelu](../security/dashboard.md) | Sesje, logowanie, unieważnianie, ryzyka szczątkowe |
| [Architektura](../architecture.md) | Jak zbudowany jest cały system i każda zmienna środowiskowa |
| [Protokół](../protocol.md) | Kontrakt komunikacyjny między wtyczką a serwerem |
| [Przechowywanie](../storage.md) | Wolumeny, trwałość, retencja, scrub i każda odmowa |
| [Walidacja](../validation.md) | Plan walidacji na urządzeniach i co znaczy „gotowe” |
| [Wydania](../release.md) | Jak wydanie jest cięte, podpisywane i audytowane |
| [Tłumaczenia](../translations.md) | W jakich językach istnieją przewodniki i jak są utrzymywane w aktualności |
| [`CHANGELOG.md`](../../CHANGELOG.md) | Co zmieniło się w każdej wersji |
| [`SECURITY.md`](../../SECURITY.md) | Postawa, wspierane wersje i jak zgłosić podatność |
| [`CONTRIBUTING.md`](../../CONTRIBUTING.md) | Jak pracować nad tym repozytorium |

## Pytania, błędy i bezpieczeństwo

- **Pytanie albo coś, przy czym nie masz pewności, czy to błąd:**
  [Discussions](https://github.com/snaraj/obsync/discussions).
- **Błąd:** [otwórz zgłoszenie](https://github.com/snaraj/obsync/issues/new/choose)
  z szablonem raportu błędu i raportem opisanym w
  [Rozwiązywaniu problemów](../troubleshooting.md). Bez tokenu, bez frazy
  odzyskiwania i bez adresu, którego nie chcesz publikować.
- **Podejrzenie podatności:** prywatnie, przez
  [`SECURITY.md`](../../SECURITY.md) — nigdy jako publiczne zgłoszenie.

## Licencja

MIT. Zobacz [`LICENSE`](../../LICENSE).
