> To tłumaczenie podąża za [angielskim oryginałem](../cloudflare.md). Tekst angielski jest wersją kanoniczną; polecenia, flagi, adresy URL i symbole zastępcze pozostają bez zmian.

# Cloudflare

Dwa sposoby na umieszczenie Cloudflare między Twoimi urządzeniami a Twoim
serwerem oraz informacja, którego z nich używa instalacja referencyjna. Żaden
nie jest wymagany: serwer nie zna żadnego dostawcy z nazwy, a
[Uruchamianie serwera](../server.md) nie wymaga konta u nikogo. Ta strona jest
dla Ciebie, jeśli chcesz sięgać do serwera poza domem bez otwierania portu na
routerze albo jeśli chcesz opublikowaną nazwę hosta z polityką dostępu przed
nią.

Menu Cloudflare i warunki planów się zmieniają. Każdy krok poniżej podaje
ścieżkę menu tak, jak podawała ją dokumentacja Cloudflare 2026-09-22; sprawdź
aktualną stronę, zanim polegasz na limicie lub cenie.

## Który wariant

| Wariant | Co widzą urządzenia | Co widzi internet | Duża pierwsza synchronizacja |
| --- | --- | --- | --- |
| **Trasa prywatna** (instalacja referencyjna) | Twój własny prywatny adres i nazwę, przez klienta Cloudflare One | nic: ani nazwy hosta, ani otwartego portu | ruch w sieci prywatnej, nie przechodzi przez publiczną nazwę hosta |
| **Publiczna nazwa hosta z Access** | publiczną nazwę, politykę Access, token usługi we wtyczce | nazwę hosta, za Access | przechodzi przez Cloudflare, na warunkach dostawcy dla dużych plików |

Trasa prywatna jest wariantem referencyjnym, bo serwer pozostaje niewidoczny
i bo sama dokumentacja Cloudflare kieruje tamtędy duże transfery: trasa przez
publiczną nazwę hosta przepuszcza ruch przez Cloudflare, a w planach Free, Pro
i Business warunki właściwe dla usługi wymagają płatnej usługi dla wideo i
innych dużych plików, podczas gdy trasa sieci prywatnej przenosi je jako Twój
własny ruch. Dużą pierwszą synchronizację wykonaj w sieci LAN w obu
wariantach.

Cokolwiek kończy TLS, czyta Twoje dane uwierzytelniające, a nigdy Twoje
notatki: każdy fragment i każdy manifest jest szyfrowany na urządzeniu, a
żaden klucz, który by je odszyfrował, nie przechodzi przez sieć
([model zagrożeń](../threat-model.md)). Na trasie prywatnej terminator jest
Twój, wewnątrz Twojej sieci. Przy publicznej nazwie hosta terminatorem jest
także brzeg sieci.

## Wariant A: trasa prywatna i klient Cloudflare One

Serwer zachowuje prywatny adres w Twojej własnej sieci. Obok niego działa
łącznik tunelu, trasa mówi Cloudflare, jakie adresy kryją się za tym tunelem,
a klient Cloudflare One (dawniej WARP) na każdym urządzeniu przenosi ruch do
tych adresów przez tunel. Adres URL serwera, który wpisują Twoje urządzenia,
to prywatna nazwa rozwiązywana na ten prywatny adres.

Czego potrzebujesz: konta Cloudflare z organizacją Zero Trust („nazwą
zespołu”), maszyny w sieci serwera, która może uruchomić łącznik tunelu, oraz
klienta Cloudflare One na każdym urządzeniu, które ma synchronizować poza
domem.

1. **Utwórz tunel.** W panelu Cloudflare przejdź do **Networking** >
   **Tunnels** i utwórz tunel `cloudflared`. Uruchom otrzymany łącznik na
   maszynie wewnątrz sieci serwera: w klastrze obok serwera albo na tym samym
   hoście.
2. **Skieruj prywatny adres serwera przez tunel.** Przejdź do
   **Networking** > **Routes**, wybierz **Create route** > **Tunnel CIDR**,
   wskaż tunel i wpisz prywatny adres lub podsieć serwera. Jeden adres
   wystarczy; podsieć można później rozszerzyć.
3. **Zarejestruj każde urządzenie.** Zainstaluj klienta Cloudflare One, wpisz
   nazwę zespołu, przejdź logowanie wymagane przez Twoją organizację i włącz
   połączenie. Na iOS i Androidzie klient prosi o zainstalowanie profilu
   VPN; zgódź się. Ustaw uprawnienia rejestracji urządzeń tak, aby tylko
   Twoja tożsamość mogła je rejestrować.
4. **Przepuść prywatny zakres przez klienta.** W konfiguracji Split Tunnels
   klienta upewnij się, że adres z kroku 2 jest kierowany przez klienta. W
   trybie **Exclude** usuń blok RFC 1918, który go zawiera, i dodaj z
   powrotem zakresy, które nadal chcesz wykluczyć; w trybie **Include** dodaj
   adres lub podsieć.
5. **Spraw, by nazwa rozwiązywała się na urządzeniu.** Wtyczka wysyła każde
   żądanie na wpisany adres URL serwera, więc ta nazwa musi rozwiązywać się
   na urządzeniu poza domem: trasa nazwy hosta, Local Domain Fallback do
   Twojego własnego resolvera albo prywatny wpis DNS. Nazwa rozwiązywana na
   adres, którego klient nie kieruje, zawodzi dokładnie tak jak wyłączony
   serwer.
6. **Zakończ TLS samodzielnie.** Trasa niesie Twój ruch do Twojego własnego
   terminatora: ingressu lub reverse proxy przed serwerem z certyfikatem,
   któremu ufa każde urządzenie, jak w
   [Uruchamianiu serwera](../server.md). Serwer działa z
   `OBSYNC_EDGE=none` i ufa przekazywanym adresom tylko z
   `OBSYNC_TRUSTED_PROXY_CIDRS`, czyli własnego zakresu terminatora.
7. **Opcjonalnie filtruj przez Gateway.** Polityka sieciowa Gateway może
   pozwolić tylko Twoim zarejestrowanym urządzeniom na dostęp do adresu i
   portu serwera, a wszystko inne na tej trasie zablokować.
8. **Sprawdź z urządzenia poza Twoją siecią.** Otwórz adres URL serwera w
   przeglądarce na tym urządzeniu i spodziewaj się strony logowania panelu.
   We wtyczce wybierz **Check** w sekcji **Connection**: jedna wymiana
   dowodzi naraz adresu, certyfikatu i danych uwierzytelniających.

Kompromisy:

- Każde synchronizujące urządzenie uruchamia klienta Cloudflare One, a klient
  musi być połączony, zanim synchronizacja poza domem zadziała.
- Cloudflare przenosi ruch między urządzeniem a łącznikiem tunelu. Zostaw
  deszyfrowanie TLS w Gateway wyłączone; ruch jest wtedy dla niego
  nieprzejrzysty poza adresami, rozmiarami i czasem, na co
  [model zagrożeń](../threat-model.md) i tak przystaje przy każdej ścieżce
  sieciowej.
- Łącznik to proces w Twojej sieci, który utrzymuje otwarte połączenie
  wychodzące do Cloudflare. Gdy pada, urządzenia poza domem pokazują
  `obsync: offline`, a LAN działa dalej.

## Wariant B: publiczna nazwa hosta za Access

Serwer dostaje nazwę hosta w domenie, którą masz w Cloudflare. Tunel
publikuje tę nazwę na prywatny adres serwera, a przed nią stoi Cloudflare
Access: polityka tożsamości dla panelu i token usługi dla wywołań API
wtyczki. To wariant, który
[wdrożenie platformy](../platform-onboarding.md) opisuje dla klastra
referencyjnego, i ten, którego instalacja referencyjna nie wybrała.

1. **Opublikuj nazwę hosta.** W konfiguracji tunelu dodaj trasę
   opublikowanej aplikacji ze swojej nazwy hosta (`sync.example.com` zastępuje
   Twoją) na prywatny adres HTTP serwera, port 8080. Cloudflare tworzy rekord
   DNS.
2. **Postaw Access z przodu.** Przejdź do **Zero Trust** > **Access
   controls** > **Applications**, utwórz aplikację **Self-hosted** na tej
   nazwie hosta i dodaj politykę tożsamości, która dopuszcza tylko Ciebie,
   na przykład jednorazowy PIN wysyłany na Twój własny adres, dla panelu.
3. **Utwórz token usługi dla wtyczki.** Przejdź do **Zero Trust** > **Access
   controls** > **Service credentials** > **Service Tokens**, utwórz token i
   skopiuj Client ID oraz Client Secret; sekret jest pokazywany tylko raz.
   Dodaj do aplikacji politykę **Service Auth** obejmującą ten token dla
   ścieżek używanych przez wtyczkę (`/v1/*`).
4. **Wklej token do wtyczki.** W **Edge service-token headers**, po jednym w
   wierszu, dokładnie tak, jak nazywa je Cloudflare:

   ```text
   CF-Access-Client-Id: <the client id>
   CF-Access-Client-Secret: <the client secret>
   ```

   Podróżują z każdym żądaniem do adresu URL serwera i z niczym innym.
5. **Powiedz serwerowi, że stoi za brzegiem sieci.** Uruchom go z
   `OBSYNC_EDGE=cloudflare`. W tym trybie każde żądanie musi nieść nagłówki
   brzegu z adresem łączącym i identyfikatorem żądania, a żądanie, które
   dociera z pominięciem brzegu, jest odrzucane z `421 edge_required`
   ([rozwiązywanie problemów](../troubleshooting.md#edge_required)).
6. **Sprawdź.** Otwórz nazwę hosta w przeglądarce i spodziewaj się logowania
   Access, a potem panelu. We wtyczce wybierz **Check** w sekcji
   **Connection**.

Kompromisy:

- Nazwa hosta jest publiczna. Access odrzuca obcych, a serwer nadal sam
  uwierzytelnia każde żądanie urządzenia, ale nazwa istnieje i da się ją
  odkryć.
- Token usługi to dane uwierzytelniające. Kto go ma, dociera do frontowych
  drzwi API; własne uwierzytelnianie urządzeń przez serwer nadal stoi za
  nimi. Zrotuj go w Cloudflare, jeśli kiedykolwiek wycieknie.
- Duże transfery przechodzą przez Cloudflare na powyższych warunkach. Dużą
  pierwszą synchronizację wykonaj w sieci LAN.
- Nagłówki brzegu z adresem łączącym i krajem są tym, co strona Urządzenia w
  panelu pokazuje jako adres i kraj w tym trybie.

## Co zostało dowiedzione

Trasa prywatna to trasa instalacji referencyjnej.
[Przebieg z 2026-09-14](../validation-runs/2026-09-14.md) odnotowuje, że
tego dnia nie została sprawdzona, i dlaczego;
[przebieg z 2026-09-20](../validation-runs/2026-09-20.md) odnotowuje
przebieg na urządzeniach na trasie referencyjnej z zaliczonymi kontrolami
łączności i TLS. Wariant z publiczną nazwą hosta nie został sprawdzony w
żadnym odnotowanym przebiegu.

## Dalej

- [Uruchamianie serwera](../server.md): terminator, wolumeny, token
  konfiguracji.
- [Kubernetes](https://github.com/snaraj/obsync/blob/main/chart/README.md): chart używany przez instalację
  referencyjną.
- [Wdrożenie platformy](../platform-onboarding.md): co klaster referencyjny
  dodałby dla opublikowanej nazwy hosta.
- [Rozwiązywanie problemów](../troubleshooting.md): `edge_required`,
  `offline` i certyfikat.
