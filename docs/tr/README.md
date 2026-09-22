> Bu çeviri [İngilizce aslını](../../README.md) izler. Esas olan İngilizce metindir; komutlar, seçenekler, URL'ler ve yer tutucular olduğu gibi kalır.

# Self Hosted Private Sync

[Obsidian](https://obsidian.md) için kendi sunucunuzda barındırılan, uçtan uca
şifreli canlı eşitleme: kendi çalıştırdığınız, yerleşik panosu olan,
bağımlılıksız tek bir Rust sunucusu ve bu eklenti. Her boyutta dosya, her
Obsidian platformu, abonelik yok, üçüncü taraf yok.

Ayarlar → Topluluk Eklentileri → Göz at yolundan **Self Hosted Private Sync**
adıyla kurun (eklenti kimliği `obsync-private-sync`); Obsidian 1.13.0 veya
daha yenisi gerekir.

> [!IMPORTANT]
> Bu eklenti, **sizin** çalıştırdığınız bir sunucuyla eşitlenir. Barındırılan
> bir hizmet yoktur ve kendinizden başka kimsede hesabınız olmaz: HTTPS
> üzerinden erişilebilen kendi `obsyncd` sunucunuz olmadan eklentinin
> eşitleyeceği bir yer yoktur.

> [!IMPORTANT]
> Kasanızı ilk eşitlemeden önce yedekleyin ve 24 kelimelik kurtarma ifadesini,
> onu üreten cihazdan başka bir yerde saklayın. Sunucu yalnızca şifreli metin
> tutar ve bir kasayı sizin için kurtaramaz.

> [!IMPORTANT]
> Bu eklentiyi aynı kasa üzerinde başka bir eşitleme çözümünün yanında
> çalıştırmayın — Obsidian Sync, dosya eşitleyen bir bulut klasörü ya da başka
> bir eşitleme eklentisi. Aynı kasaya yazan iki taraf, hiçbirinin
> uzlaştıramayacağı çakışmalar üretir.

## Buna güvenmeden önce

Bu, notlarınızın tek kopyasını eşitleyen genç bir yazılımdır.

- **[`CHANGELOG.md`](../../CHANGELOG.md), bilinenlerin bakımı yapılan
  listesidir.** Kullandığınız sürümün girdisini ve onun üstündeki girdileri
  okuyun. Sürüm sayfaları, yayımlandıkları sırada taşıdıkları notları korur;
  sonraki bulgular buraya eklenir.
- **Bir kasayı eşitleyen her cihazı güncelleyin.** Eski bir sürümde kalan tek
  bir cihaz bile hâlâ eski davranışa göre hareket edip diğerlerini
  etkileyebilir.
- **Donanım üzerinde neyin denendiği**, her çalıştırma için
  [`docs/validation-runs/`](../validation-runs/) altında kayıtlıdır; her
  çalıştırmanın neyi kapsamadığı da dahil. Hiçbir çalıştırmanın adını anmadığı
  bir platform kanıtlanmış sayılmaz.
- **Bir notu düzenleyen iki cihazda akan "merged concurrent edits" bildirimi
  seli**: birinde Obsidian'dan çıkın ki diğeri işini bitirebilsin, ikisini de
  güncelleyin, sonra devam edin.

## Bu eklenti neye erişir

Kısa ve eksiksiz; kurmadan önce karar verebilesiniz diye.

- **Tek bir ağ hedefi: kendi sunucunuz.** Her istek, eklentinin ayarlarına
  yazdığınız **Server URL** adresine gider, başka hiçbir yere değil. Eşitleme
  yolunun hiçbir yerinde telemetri, analiz, çökme bildirici, reklam ya da
  üçüncü taraf hizmet yoktur. Eklenti o sunucudan kod da indirmez, çalıştırmaz.
- **O sunucuda, sizin oluşturduğunuz bir hesap.** İlk cihaz, sunucunuzun ilk
  açılışta yazdığı kurulum belirtecini kullanır; diğer her cihaz, hâlihazırda
  eşitleyen bir cihazdan eşleştirilir. Obsidian hesabınızın bunda hiçbir rolü
  yoktur.
- **Obsidian ve GitHub, yalnızca kurulum ve güncelleme için.** `main.js`,
  `manifest.json` ve `styles.css` dosyalarını bu deponun GitHub Releases
  sayfalarından Obsidian'ın kendisi indirir. Her sürüm ayrıca sunucuyu
  kuranlar için bir eklenti ZIP'i ve bir sürüm manifestosu taşır; Obsidian
  ikisini de yok sayar.
- **Uç noktanız, yalnızca birini yapılandırdıysanız.** **Edge service-token
  headers** altına yapıştırdığınız başlıklar, yukarıdaki Server URL'ye giden
  her istekle birlikte gider; çünkü onlara ihtiyaç duyan vekil, sunucunuza
  giden yolun üzerindedir.
- **Kasanızın dosya listesi.** Eklenti, kapsamda neyin olduğuna karar vermek
  için kasadaki her dosyayı listeler, klasör seçiminizin içindeki dosyaları
  okur ve diğer cihazların değiştirdiklerini yazar. Gizli klasörler
  (`.obsidian`, `.git`) ve sembolik bağlantılı klasörler atlanır.
- **Kopyalama panosu, yalnızca yazılır, asla okunmaz.** Ona yalnızca **Pair a
  new device** içindeki **Copy code** ve **Copy link** düğmeleri yazar.
  Eklentide kopyalama panosunu okuyan hiçbir şey yoktur.
- **Tarayıcınız, panoyu istediğinizde.** **Open dashboard**, tarayıcınızda bir
  oturum açma bağlantısı açar; yalnızca o bağlantı kendi sunucunuzun
  kökenindeyse.
- **Obsidian'ın gizli deposu.** Kasa anahtarı, cihaz sırrı ve varsa uç nokta
  başlık değerleri orada durur, asla düz eklenti verisinde değil.

Sunucunun neyi görebildiği ve neyi göremediği
[`SECURITY.md`](../../SECURITY.md) ve
[`docs/threat-model.md`](../threat-model.md) sayfalarındadır.

## Beş adımda eşitlenin

Bu sürümün doğrulandığı yol: boş bir kasadan birbiriyle eşitlenen iki cihaza.
Beşi de kendi sunucunuzun zaten çalışıyor olmasını varsayar; o da aşağıdaki
bölümdür. Her adım hızlı başlangıçta tam olarak yazılmıştır.

1. **Topluluk Eklentileri'nden kurun.** Ayarlar → Topluluk Eklentileri → Göz
   at bölümünde **Self Hosted Private Sync** eklentisini arayın, İndir'i,
   sonra Etkinleştir'i seçin — diğer her Obsidian eklentisinin geldiği gibi,
   her platformda.

   ![Obsidian'ın Topluluk Eklentileri tarayıcısı, Self Hosted Private Sync'i İndir düğmesiyle gösteriyor](../captures/01-install-from-directory.png)

2. **Sunucunuza yöneltin ve kurulumu yapın.** Eklentinin ayarlar sekmesini
   açın, **Server URL** değerini kendi sunucunuza ayarlayın, bu cihazın hangi
   klasörleri eşitleyeceğini seçin, sonra kurulum belirtecinizi **First-time
   setup** altına yapıştırın.

   ![Eklentinin ayarlar sekmesi, klasör seçimine, Pairing satırına ve First-time setup altındaki Setup token alanına kadar kaydırılmış](../captures/02-first-time-setup.png)

3. **Kurtarma ifadesini saklayın.** Kurulum, kasa anahtarını bu cihazda üretir
   ve 24 kelimelik bir ifadeyi bir kez gösterir: yazın ve bu cihazdan başka
   bir yerde saklayın; çünkü sunucu yalnızca şifreli metin tutar ve bir kasayı
   sizin için kurtaramaz.

   ![İlk kurulumdan sonra gösterilen kurtarma ifadesi iletişim kutusu, kelimeleri okunmaz hâlde](../captures/03-recovery-phrase.png)

4. **İkinci bir cihazı tek kullanımlık bir kodla eşleştirin.** İlk cihazda
   **Pair a new device** komutunu çalıştırın, gösterdiği kodu on dakika içinde
   ikincisine girin ve cihazı adıyla onaylayın — kasa anahtarı, sunucunun hiç
   görmediği bir eşleştirme sırrıyla şifrelenmiş olarak yol alır.

   ![İlk cihazdaki Pair a new device iletişim kutusu, tek kullanımlık kodu okunmaz hâlde](../captures/04-pair-a-new-device.png)

5. **İki cihazdan birinde yazın ve karşıya düşmesini izleyin.** Bir cihazda
   bir nota yazın; saniyeler içinde diğerinde, iki yönde de belirir ve durum
   çubuğu eşitlemenin ne yaptığını gösterir.

   ![Her iki cihazın düzenlemelerini taşıyan tek kullanımlık not, eşitleme durum çubuğu görünür hâlde](../captures/05-sync-both-ways.png)

Panonun cihaz listesi ve iptal düğmesi
[Cihazlarınızı görün](../daily-use.md#see-your-devices) başlığı altında
anlatılır ve
[docs/validation-runs/2026-09-14.md](../validation-runs/2026-09-14.md)
dosyasına kaydedilen 1.0.0 cihaz çalıştırmasında denenmemiştir.

## Eşitlemeye başlayın

En kısa doğru yol: sahip olduğunuz bir makine sunucuyu çalıştırır, her cihaz
ona HTTPS üzerinden ulaşır ve her cihaz bir kez eşleştirilir. Obsidian'da
oturum açmak burada hiçbir şeyi yetkilendirmez; tek hesap, sunucunuzdaki
hesaptır.

### 1. Sunucuyu başlatın

Başlatmanın iki yolu var. İkisi de yayımcının imzaladığı baytların tam olarak
kendisini çalıştırır: imzayı doğrulayın, özeti doğrulanmış çıktıdan okuyun ve
o özeti çalıştırın. `v1.0.6`, bu sayfanın yazıldığı sürümdür;
kurduğunuz sürümün etiketini kullanın.

```sh
cosign verify ghcr.io/snaraj/obsync:v1.0.6 \
  --certificate-identity https://github.com/snaraj/obsync/.github/workflows/release-publisher.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

**Henüz HTTPS yok mu?** `deploy/compose`, sunucuyu kendi TLS sonlandırıcısının
(Caddy) arkasında, herhangi bir ağda, alan adı olmadan ve kimsede hesap
olmadan başlatır. Bu deponun bir çalışma kopyasından:

```sh
OBSYNC_IMAGE=ghcr.io/snaraj/obsync@sha256:<digest> \
  OBSYNC_HOST=sync.example.org \
  OBSYNC_BIND_ADDRESS=192.168.1.10 \
  docker compose -f deploy/compose/docker-compose.yml up -d
```

`OBSYNC_HOST`, cihazlarınızın yazacağı addır. Yalnızca kendi ağınızda
çözümlenmesi yeterlidir. `OBSYNC_BIND_ADDRESS`, bu ana makinenin 80 ve 443
portlarının yayımlandığı adresidir: bağlanma adresi kaynağı değil hedef
arayüzü sınırlar, dolayısıyla ona kimin ulaşacağına güvenlik duvarınız karar
verir. Siz seçene kadar Compose başlamayı reddeder. İkisi de
[Sunucuyu çalıştırma](../server.md) sayfasında anlatılır.

Makinenin **önünde zaten HTTPS var mı**, güvendiğiniz bir ters vekil ya da bir
tünel sayesinde? Çıplak sunucuyu çalıştırın. 8080 portunda düz HTTP konuşur ve
sonlandırıcınız ona iletir:

```sh
docker volume create obsync-blobs
docker volume create obsync-journal
docker run -d --name obsync -p 127.0.0.1:8080:8080 \
  -v obsync-blobs:/data/blobs -v obsync-journal:/data/journal \
  -e OBSYNC_BLOBS_CAPACITY=250GiB -e OBSYNC_JOURNAL_CAPACITY=4GiB \
  -e OBSYNC_PUBLIC_URL=https://sync.example.org \
  ghcr.io/snaraj/obsync@sha256:<the digest cosign just verified>
```

### 2. Kurulum belirtecini okuyun

İlk açılışta sunucu bir kurulum belirteci üretir ve onu journal birimine 0600
kipiyle yazar; hiçbir günlüğe yazılmaz. Belirteç hesabınızı bir kez oluşturur
ve sonrasında sunucunun ömrü boyunca panoda kurtarma amaçlı oturum açma yolu
olarak kalır: kurtarma ifadesiyle aynı özenle saklayın. Onu yardımcı bir imaj
olmadan doğrudan konteynerin kendisinden okuyun. Compose yolunda:

```sh
docker cp obsync-obsync-1:/data/journal/v1/setup-token - | tar -xO
```

Çıplak sunucu yolunda:

```sh
docker cp obsync:/data/journal/v1/setup-token - | tar -xO
```

### 3. Sertifikaya güvenin, cihaz başına bir kez (Compose yolu)

Caddy sertifikayı, ilk başlangıçta kendi ürettiği bir otoriteden verdi; bu
yüzden her cihaza o otoriteye güvenmesi bir kez söylenmelidir. Kök sertifikayı
dışa aktarın:

```sh
docker cp obsync-caddy-1:/data/caddy/pki/authorities/local/root.crt - | tar -xO > obsync-root.crt
```

`obsync-root.crt` dosyasını her cihaza kurun. macOS, Windows, Linux, iOS ve
Android adımları
[Sertifika otoritesine güvenin, cihaz başına bir kez](../server.md#trust-the-certificate-authority-once-per-device)
başlığındadır. iOS'ta sertifikaya güvenmek, onu kurduktan sonra açılacak
ikinci bir anahtardır.

### 4. İlk cihazı kurun

1. Ayarlar → Topluluk Eklentileri → Göz at → **Self Hosted Private Sync** →
   İndir → Etkinleştir.
2. Eklentinin ayarlarında **Server URL** değerini kendi sunucunuza ayarlayın,
   443 değilse port dahil: `https://sync.example.org`.

   ![Eklentinin ayarlar sekmesi: örnek bir ana bilgisayar adı taşıyan Server URL alanı, uç nokta başlıkları kutusu ve Check ile Open dashboard düğmelerini taşıyan Connection satırı](../assets/settings-server.png)

3. Şimdi **Whole vault** ya da **Selected folders only** seçin. Bir cihaz bir
   kez eşitledikten sonra seçimi yalnızca daralabilir.
4. Kurulum belirtecini **First-time setup** altına yapıştırın ve **Set up**
   seçin. 24 kelimelik kurtarma ifadesini yazın ve bu cihazın dışında tutun.

   ![Ayarlar sekmesinin This device bölümü: Pair this device ve Pair a new device düğmeleriyle Pairing satırı, Setup token alanı ve Set up düğmesiyle First-time setup satırı ve Vault key satırı](../assets/settings-setup.png)

### 5. İkinci cihazı eşleştirin

1. Eklentiyi orada da kurup etkinleştirin, aynı **Server URL** değerini
   ayarlayın ve klasörlerini seçin.
2. İlk cihazda **Pair a new device** komutunu çalıştırın. On dakika geçerli
   bir kod gösterir.

   ![İlk cihazdaki Pair a new device iletişim kutusu, kodu okunmaz hâlde, Copy code ve Copy link düğmeleri ve Waiting for the new device satırıyla](../assets/pair-new-device.png)

3. İkinci cihazda **Pair this device** kutusunu açın, kodu yapıştırın ve
   **Pair** seçin.

   ![İkinci cihazdaki Pair this device iletişim kutusu, boş Pairing code alanı ve Pair düğmesiyle](../assets/pair-this-device.png)

4. İlk cihaza dönüp yeni cihazı adıyla onaylayın. İkisinden birinde bir notu
   düzenleyin; saniyeler içinde diğerinde belirir.

   ![İlk cihaz, yeni cihazın adıyla onaylanıp onaylanmayacağını soruyor, Approve ve Reject düğmeleriyle](../assets/pair-approve.png)

   ![İkinci cihaz, ilk cihazda yazılan notu gösteriyor, durum çubuğunda obsync idle yazıyor](../assets/first-sync.png)

Bütün eşleştirme alışverişi, kısa bir döngüde:

![Animasyon: eşleştirme kodu ilk cihazda gösteriliyor, ikincisine yapıştırılıyor, ilkinde onaylanıyor ve ilk not ikincisine ulaşıyor](../assets/pairing.gif)

Telefon ekran görüntüleri bu depoda henüz yok; bakımcının kendi cihazlarında
çekiliyor ve bir doğrulama çalıştırması onları kayda geçirdiğinde ekleniyor.

Her adım tam hâliyle, her ekranın ne istediği ve neden istediğiyle birlikte:
[Hızlı başlangıç](../quickstart.md).

**Tek bir bilgisayarda mı deniyorsunuz?** Bilgisayarda eklenti düz bir
`http://` adresini de kabul eder; böylece `http://127.0.0.1:8080`, yukarıdaki
çıplak sunucuya sonlandırıcı olmadan ulaşır. Telefonlarda öyle değil: iOS ve
Android'deki Obsidian düz HTTP'yi reddeder.

## İleri düzey: Cloudflare

Referans kurulumun **herkese açık bir ana bilgisayar adı yoktur**. Bir
Cloudflare Tunnel, sunucunun özel ağını Cloudflare'e bağlar; bir özel rota
Cloudflare'e o tünelin arkasında hangi adreslerin bulunduğunu söyler ve her
cihazdaki Cloudflare One istemcisi sunucu URL'sini oraya taşır. İnternetten
hiçbir şeye erişilemez ve büyük ilk eşitlemeler herkese açık bir ana bilgisayar
adı üzerinden geçmez. Diğer biçim de desteklenir: Cloudflare Access arkasında
herkese açık bir ana bilgisayar adı, **Edge service-token headers** içinde bir
hizmet belirteci ve sunucuda `OBSYNC_EDGE=cloudflare`. İkisi de, adım adım:
[Cloudflare](cloudflare.md).

## Sunucunuza ulaşmanın diğer yolları

Her biri için bir satır, öğretici değil. Ne seçerseniz seçin, eklentinin her
cihazın güvendiği bir sertifikayla HTTPS'e ihtiyacı vardır ve sunucunun
kendisi o sonlandırıcının arkasında düz HTTP'de kalır.

- **Yalnızca LAN.** Yukarıdaki Compose yolu, yalnızca evde erişilebilir. En
  basiti; evden uzakta eşitleme yok.
- **WireGuard.** Kendi ağınıza geri dönen kendi VPN'iniz. En hızlısı ve
  tamamen sizin; her cihazda bir eş yapılandırması taşırsınız ve bir uç
  noktayı erişilebilir tutarsınız.
- **Tailscale.** Kendi adları olan, yönetilen bir WireGuard örgüsü. Cihazlarda
  en az kurulum gerektireni; örgüyü üçüncü bir taraf koordine eder ve plan
  sınırlarını okumak size düşer.
- **Otomatik TLS'li bir ters vekil**, örneğin herkese açık bir adda Caddy.
  Herkesçe güvenilen bir sertifika ve kalıcı bir adres; sunucu o zaman
  internetten erişilebilir olur ve vekili ve güncellemelerini doğru tutmak
  size düşer.
- **Cloudflare Tunnel.** Yukarıda. Gelen port yok; yolda kendi koşulları olan
  bir sağlayıcı var.

Hangisini seçerseniz seçin, dolaşımdaki bir cihazın neye ihtiyaç duyduğu
(rota, ad, sertifika, iOS'un yerel ağ sorusu, güvenlik duvarı):
[LAN'ınızın dışından erişme](../server.md#reaching-it-from-outside-your-lan).

## Sorun giderme

| Belirti | Olası neden | İlk denenecek şey |
| --- | --- | --- |
| `obsync: offline` | Cihaz, Server URL adresine ulaşamıyor | URL'yi aynı cihazdaki bir tarayıcıda açın; portu, HTTPS'i ve rotayı denetleyin |
| Bir bilgisayar eşitlerken telefon bağlanmıyor | Özel sertifikaya telefonda güvenilmiyor | Kök sertifikayı kurun; iOS'ta ayrıca "Certificate Trust Settings" altından açın |
| `401 stale_timestamp` | Bir saat 300 saniyeden fazla şaşmış | Cihazda ya da sunucuda otomatik saati açın |
| `403 device_pending` | Cihazı henüz kimse onaylamamış | Eşleştirmeyi yaptığınız cihazda onu adıyla onaylayın |
| Bir dosya hiç ulaşmıyor | Klasör seçiminin dışında ya da telefonun boyut tavanının üstünde | **Sync folders on this device** ayarını denetleyin; telefonda **Show remote-only files** komutunu çalıştırın |

Diğer her belirti, her hata kodu ve gönderilmeye değer bir raporun nasıl
toplanacağı: [Sorun giderme](../troubleshooting.md).

## Belgeler

| Sayfa | Neyi yanıtlar |
| --- | --- |
| [Hızlı başlangıç](../quickstart.md) | İlk cihaz ve ikincisi, her adım tam hâliyle |
| [Sunucuyu çalıştırma](../server.md) | Docker, Caddy ile Compose, sertifikalar, yedekler, LAN'ınızın dışından erişim |
| [Cloudflare](cloudflare.md) | Özel rotalı tünel ve Cloudflare One istemcisi ya da Access arkasında herkese açık bir ana bilgisayar adı |
| [Kubernetes](../../chart/README.md) | Sunucuyu imzalı Helm chart'ıyla kurma |
| [Günlük kullanım](../daily-use.md) | Komutlar, durum çubuğu, neyin eşitlendiği ve neyin eşitlenmediği, bir sürümü geri getirme, pano |
| [Ayarlar](../settings.md) | Her ayar, varsayılanı ve ne zaman değiştirileceği |
| [Sorun giderme](../troubleshooting.md) | Belirti, neden, çözüm ve bir raporun nasıl toplanacağı |
| [Çakışmalar](../conflicts.md) | Çakışma kopyası nedir ve onunla ne yapılır |
| [Kurtarma](../recovery.md) | Kaybolan bir cihaz, kaybolan bir sunucu, taşınan bir sunucu, döndürülen bir belirteç |
| [Kurulum ve güncelleme](../community-plugin.md) | Obsidian'ın dizini, güncellemeler, kimlik bilgilerinin saklanması, liste incelemesi |
| [Tehdit modeli](../threat-model.md) | Neyin savunulduğu ve neyin savunulmadığı |
| [Panonun tehdit modeli](../security/dashboard.md) | Oturumlar, oturum açma, iptal, artık riskler |
| [Mimari](../architecture.md) | Bütün sistemin nasıl kurulduğu ve her ortam değişkeni |
| [Protokol](../protocol.md) | Eklenti ile sunucu arasındaki hat sözleşmesi |
| [Depolama](../storage.md) | Birimler, dayanıklılık, saklama, temizleme ve her ret |
| [Doğrulama](../validation.md) | Cihaz doğrulama planı ve "hazır" ne demek |
| [Sürümler](../release.md) | Bir sürümün nasıl kesildiği, imzalandığı ve denetlendiği |
| [Çeviriler](../translations.md) | Kılavuzların hangi dillerde bulunduğu ve nasıl güncel tutulduğu |
| [`CHANGELOG.md`](../../CHANGELOG.md) | Her sürümde neyin değiştiği |
| [`SECURITY.md`](../../SECURITY.md) | Duruş, desteklenen sürümler ve bir açığın nasıl bildirileceği |
| [`CONTRIBUTING.md`](../../CONTRIBUTING.md) | Bu depoda nasıl çalışılacağı |

## Sorular, hatalar ve güvenlik

- **Bir soru ya da hata olduğundan emin olmadığınız bir şey:**
  [Discussions](https://github.com/snaraj/obsync/discussions).
- **Bir hata:** hata bildirimi şablonu ve
  [Sorun giderme](../troubleshooting.md) sayfasında anlatılan raporla birlikte
  [bir issue açın](https://github.com/snaraj/obsync/issues/new/choose).
  İçinde belirteç, kurtarma ifadesi ve yayımlamayacağınız bir adres olmasın.
- **Şüphelendiğiniz bir güvenlik açığı:** gizlice,
  [`SECURITY.md`](../../SECURITY.md) üzerinden — asla herkese açık bir issue
  olarak değil.

## Lisans

MIT. Bkz. [`LICENSE`](../../LICENSE).
