> Bu çeviri [İngilizce aslını](../../README.md) izler. Esas olan İngilizce metindir; komutlar, seçenekler, URL'ler ve yer tutucular olduğu gibi kalır.

<img src="../../brand/obsync-icon-256.png" alt="obsync simgesi: iç içe geçmiş iki halka" width="96" height="96">

# Self Hosted Private Sync

[Obsidian](https://obsidian.md) için kendi sunucunuzda barındırılan, uçtan uca
şifreli canlı eşitleme: kendi çalıştırdığınız, yerleşik panosu olan,
bağımlılıksız tek bir Rust sunucusu ve bu eklenti. Her boyutta dosya, her
Obsidian platformu, abonelik yok, üçüncü taraf yok.

Ayarlar → Topluluk Eklentileri → Göz at yolundan **Self Hosted Private Sync**
adıyla kurun (eklenti kimliği `obsync-private-sync`); Obsidian 1.13.0 veya
daha yenisi gerekir.

> [!IMPORTANT]
> - **Sizin** çalıştırdığınız bir sunucuyla eşitlenir: barındırılan bir hizmet
>   yok, başka hiçbir yerde hesap yok.
> - Önce kasanızı yedekleyin; 24 kelimelik kurtarma ifadesini, onu üreten
>   cihazın dışında saklayın.
> - Onu tek bir kasa üzerinde başka bir eşitlemenin (Obsidian Sync, bir bulut
>   klasörü, başka bir eklenti) yanında asla çalıştırmayın.
> - Genç yazılım: sürümünüzün [`CHANGELOG.md`](../../CHANGELOG.md) girdisini
>   okuyun, her cihazı güncelleyin ve her
>   [doğrulama çalıştırmasının](../validation-runs/) neyi kapsadığını bilin.

## Bu eklenti neye erişir

- **Kendi sunucunuz, başka hiçbir yer.** Her istek, yazdığınız **Server URL**
  adresine gider; telemetri yok, üçüncü taraf yok.
- **O sunucudaki bir hesap**, kurulum belirtecinden oluşturulur; Obsidian
  hesabınızın bunda hiçbir rolü yoktur.
- **Kurulum ve güncelleme için, Obsidian üzerinden GitHub Releases**; Obsidian
  sürümdeki fazladan dosyaları yok sayar.
- **Kasanızın dosya listesi**, neyin eşitleneceğine karar vermek için; gizli
  (`.obsidian`, `.git`) ve sembolik bağlantılı klasörler atlanır.
- **Kopyalama panosu, yalnızca yazılır**: ona yalnızca **Pair a new device**
  içindeki **Copy code** ve **Copy link** yazar, asla okunmaz.

Sunucunun neyi görebildiği ve neyi göremediği:
[`SECURITY.md`](../../SECURITY.md) ve [tehdit modeli](../threat-model.md).

## Eşitlemeye başlayın

Sıfırdan, birbiriyle eşitlenen iki cihaza beş adım. `v1.0.6`, bu sayfanın
yazıldığı sürümdür; kurduğunuz sürümün etiketini kullanın.

### 1. Sunucuyu başlatın

İmzayı doğrulayın, sonra tam olarak yazdırdığı özeti çalıştırın:

```sh
cosign verify ghcr.io/snaraj/obsync:v1.0.6 \
  --certificate-identity https://github.com/snaraj/obsync/.github/workflows/release-publisher.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Basit yol, bu deponun bir çalışma kopyasından Caddy ile Compose: herhangi bir
ağda HTTPS, alan adı yok, hiçbir yerde hesap yok.

```sh
OBSYNC_IMAGE=ghcr.io/snaraj/obsync@sha256:<digest> \
  OBSYNC_HOST=sync.example.org \
  OBSYNC_BIND_ADDRESS=192.168.1.10 \
  docker compose -f deploy/compose/docker-compose.yml up -d
```

`OBSYNC_HOST`, cihazlarınızın yazacağı addır; yalnızca kendi ağınızda
çözümlenmesi yeterlidir. `OBSYNC_BIND_ADDRESS`, 80 ve 443 portlarının
yayımlandığı adrestir: bağlanma adresi kaynağı değil hedef arayüzü sınırlar,
dolayısıyla ona kimin ulaşacağına güvenlik duvarınız karar verir. Siz seçene
kadar Compose başlamayı reddeder.

Önünde, güvendiğiniz bir vekil ya da tünel sayesinde, zaten HTTPS var mı? O
zaman çıplak sunucuyu çalıştırın: [Sunucuyu çalıştırma](../server.md).

### 2. Kurulum belirtecini okuyun

İlk açılışta sunucu bir kurulum belirteci üretir ve onu journal birimine 0600
kipiyle yazar; hiçbir günlüğe geçmez. Belirteç hesabınızı bir kez oluşturur ve
sonrasında panonun kurtarma amaçlı oturum açma yolu olarak kalır: kurtarma
ifadesiyle aynı özenle saklayın. Onu konteynerden okuyun:

```sh
docker cp obsync-obsync-1:/data/journal/v1/setup-token - | tar -xO
```

### 3. Sertifikaya güvenin, cihaz başına bir kez

Caddy, ilk başlangıçta kendi ürettiği bir otoriteyle imzalar; her cihazın ona
bir kez güvenmesi gerekir. Kök sertifikayı dışa aktarın ve
[Sunucuyu çalıştırma](../server.md#trust-the-certificate-authority-once-per-device)
sayfasının gösterdiği gibi her platforma kurun; iOS'ta ona güvenmek, onu
kurduktan sonra açılacak ikinci bir anahtardır.

### 4. İlk cihazı kurun

1. Ayarlar → Topluluk Eklentileri → Göz at → **Self Hosted Private Sync** →
   İndir → Etkinleştir.
2. **Server URL** değerini kendi sunucunuza ayarlayın
   (`https://sync.example.org`, 443 değilse port dahil), sonra **Whole vault**
   ya da **Selected folders only** seçin; seçim sonradan yalnızca daralabilir.

   ![Eklentinin ayarlar sekmesi: örnek bir ana bilgisayar adı taşıyan Server URL alanı, uç nokta başlıkları kutusu ve Check ile Open dashboard düğmelerini taşıyan Connection satırı](../assets/settings-server.png)

3. Kurulum belirtecini **First-time setup** altına yapıştırın, **Set up**
   seçin ve 24 kelimelik kurtarma ifadesini yazın.

   ![Ayarlar sekmesinin This device bölümü: Pair this device ve Pair a new device düğmeleriyle Pairing satırı, Setup token alanı ve Set up düğmesiyle First-time setup satırı ve Vault key satırı](../assets/settings-setup.png)

### 5. İkinci cihazı eşleştirin

1. Eklentiyi orada da aynı **Server URL** ile kurun; ilk cihazda, on dakika
   geçerli bir kod için **Pair a new device** komutunu çalıştırın.

   ![İlk cihazdaki Pair a new device iletişim kutusu, kodu okunmaz hâlde, Copy code ve Copy link düğmeleri ve Waiting for the new device satırıyla](../assets/pair-new-device.png)

2. İkinci cihazda **Pair this device** kutusunu açın, kodu yapıştırın ve
   **Pair** seçin.
3. İlk cihaza dönüp onu adıyla onaylayın. İkisinden birinde bir notu
   düzenleyin; saniyeler içinde diğerinde belirir.

   ![İlk cihaz, yeni cihazın adıyla onaylanıp onaylanmayacağını soruyor, Approve ve Reject düğmeleriyle](../assets/pair-approve.png)

![Animasyon: eşleştirme kodu ilk cihazda gösteriliyor, ikincisine yapıştırılıyor, ilkinde onaylanıyor ve ilk not ikincisine ulaşıyor](../assets/pairing.gif)

Tek bir bilgisayarda mı deniyorsunuz? Bilgisayarda `http://127.0.0.1:8080`
çıplak sunucuya ulaşır; iOS ve Android'deki Obsidian düz HTTP'yi reddeder.

Telefon ekran görüntüleri bu depoda henüz yok; bakımcının kendi cihazlarında
çekiliyor ve bir doğrulama çalıştırması onları kayda geçirdiğinde ekleniyor.

Her adım tam hâliyle: [Hızlı başlangıç](../quickstart.md).

## İleri düzey: Cloudflare

Referans kurulumun herkese açık bir ana bilgisayar adı yoktur: bir Cloudflare
Tunnel ve bir özel rota sunucunun ağına ulaşır, her cihazdaki Cloudflare One
istemcisi de sunucu URL'sini oraya taşır. Cloudflare Access arkasında herkese
açık bir ana bilgisayar adı da çalışır: **Edge service-token headers** içinde
bir hizmet belirteci ve `OBSYNC_EDGE=cloudflare` ile. İkisi de, adım adım:
[Cloudflare](cloudflare.md).

## Sunucunuza ulaşmanın diğer yolları

Ne seçerseniz seçin, eklentinin her cihazın güvendiği bir sertifikayla HTTPS'e
ihtiyacı vardır; sunucunun kendisi o sonlandırıcının arkasında düz HTTP'de
kalır.

- **Yalnızca LAN.** Yukarıdaki Compose yolu, yalnızca evde erişilir; evden
  uzakta eşitleme yok.
- **WireGuard.** Kendi ağınıza dönen kendi VPN'iniz: en hızlısı, tamamen
  sizin; her cihazda bir eş yapılandırması.
- **Tailscale.** Yönetilen bir WireGuard örgüsü: en az kurulum; üçüncü bir
  taraf onu kendi planının koşullarıyla koordine eder.
- **Otomatik TLS'li bir ters vekil**, örneğin herkese açık bir adda Caddy:
  internetten erişilebilir, yamalamak size düşer.
- **Cloudflare Tunnel.** Yukarıda. Gelen port yok; yolda, kendi koşulları olan
  bir sağlayıcı.

Dolaşımdaki bir cihazın neye ihtiyaç duyduğu (rota, ad, sertifika, güvenlik
duvarı, iOS'un yerel ağ sorusu):
[LAN'ınızın dışından erişme](../server.md#reaching-it-from-outside-your-lan).

## Sorun giderme

| Belirti | Olası neden | İlk denenecek şey |
| --- | --- | --- |
| `obsync: offline` | Cihaz, Server URL adresine ulaşamıyor | URL'yi aynı cihazdaki bir tarayıcıda açın; portu, HTTPS'i ve rotayı denetleyin |
| Bir bilgisayar eşitlerken telefon bağlanmıyor | Özel sertifikaya telefonda güvenilmiyor | Kök sertifikayı kurun; iOS'ta ayrıca "Certificate Trust Settings" altından açın |
| `401 stale_timestamp` | Bir saat 300 saniyeden fazla şaşmış | Cihazda ya da sunucuda otomatik saati açın |
| `403 device_pending` | Cihazı henüz kimse onaylamamış | Eşleştirmeyi yaptığınız cihazda onu adıyla onaylayın |
| Bir dosya hiç ulaşmıyor | Klasör seçiminin dışında ya da telefonun boyut tavanının üstünde | **Sync folders on this device** ayarını denetleyin; telefonda **Show remote-only files** komutunu çalıştırın |

Diğer her belirti, her hata kodu ve birinin nasıl bildirileceği:
[Sorun giderme](../troubleshooting.md).

## Belgeler

[Hızlı başlangıç](../quickstart.md) · [Sunucuyu çalıştırma](../server.md) ·
[Cloudflare](cloudflare.md) · [Günlük kullanım](../daily-use.md) ·
[Ayarlar](../settings.md) · [Sorun giderme](../troubleshooting.md) ·
[Kurtarma](../recovery.md) · [Değişiklik günlüğü](../../CHANGELOG.md)

Geri kalan her şey: [docs/README.md](../README.md).

## Sorular, hatalar ve güvenlik

- **Bir soru ya da hata olduğundan emin olmadığınız bir şey:**
  [Discussions](https://github.com/snaraj/obsync/discussions).
- **Bir hata:** [Sorun giderme](../troubleshooting.md) sayfasının anlattığı
  raporla [bir issue açın](https://github.com/snaraj/obsync/issues/new/choose);
  belirteç, kurtarma ifadesi ve yayımlamayacağınız bir adres olmasın.
- **Şüphelendiğiniz bir güvenlik açığı:** gizlice,
  [`SECURITY.md`](../../SECURITY.md) üzerinden; asla herkese açık bir issue
  olarak değil.

## Lisans

MIT. Bkz. [`LICENSE`](../../LICENSE).
