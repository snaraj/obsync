> Bu çeviri [İngilizce aslını](../../README.md) izler. Esas olan İngilizce metindir; komutlar, seçenekler, URL'ler ve yer tutucular olduğu gibi kalır.

<img src="../../brand/obsync-icon-256.png" alt="obsync simgesi: iç içe geçmiş iki halka" width="96" height="96">

# Self Hosted Private Sync

[Obsidian](https://obsidian.md) için kendi sunucunuzda barındırılan, uçtan uca
şifreli canlı eşitleme. Notlarınız kendi çalıştırdığınız bir sunucu üzerinden
eşitlenir. Notlar, ekler ve dosya adları cihazınızda şifrelenir ve sunucu
anahtarı hiçbir zaman almaz. Eklenti, Obsidian'ın çalıştığı her platformda,
masaüstünde ve mobilde çalışır. Abonelik yok, başka hiçbir yerde hesap yok.

**Bir şey çalışmıyor mu? → [Sorun giderme](https://snaraj.github.io/obsync/troubleshooting/) (İngilizce)**

## Aradığınızı bulun

Her sayfa [belge sitesinde](https://snaraj.github.io/obsync/) de var (İngilizce).

### obsync'i kullanmak

| Şunu istiyorum… | Gidilecek yer |
| --- | --- |
| Cihazlarımın sunucuma nasıl ulaşacağını seçmek | [Kurulumunuzu seçin](../setup.md) |
| Her şeyi ev ağımda, telefonun her ekranıyla kurmak | [Aynı ağ, adım adım](../same-network.md) |
| Eklentiyi kurmak | [Eklentiyi kurun](../community-plugin.md) |
| İlk cihazımı kurmak | [Hızlı başlangıç](../quickstart.md) |
| Bir telefonu ya da başka bir bilgisayarı eşlemek | [Telefonunuzu eşleyin](../quickstart.md#pair-your-phone) |
| Durum simgesinin ve komutların ne anlama geldiğini bilmek | [Günlük kullanım](../daily-use.md) ve [Durum çubuğunu okumak](../troubleshooting.md#reading-the-status-bar) |
| Bir notun eski bir sürümünü geri almak | [Saklanan bir sürümü geri yükleyin](../daily-use.md#restore-a-retained-version) |
| Bir ayarın ne yaptığını bilmek | [Ayarlar](../settings.md) |
| Bir çakışma kopyasıyla başa çıkmak | [Çakışmalar](../conflicts.md) |
| Bir sorunu düzeltmek | [Sorun giderme](../troubleshooting.md) |
| Bir cihazı kaybettikten sonra yeniden girmek | [Kurtarma](../recovery.md) |
| Kasamı başka bir sunucuya taşımak | [Bu kasayı başka bir sunucuya taşımak](../recovery.md#moving-this-vault-to-a-different-server) |

### Sunucu çalıştırmak

| Şunu istiyorum… | Gidilecek yer |
| --- | --- |
| Sunucumu Docker ya da Compose ile çalıştırmak | [Sunucuyu çalıştırma](../server.md) |
| Onu kendi vekil sunucumun arkasına koymak (Caddy, nginx, Traefik, HAProxy) | [Zaten bir TLS sonlandırıcınız var](../server.md#already-have-a-tls-terminator-docker) |
| Onu konteyner olmadan, systemd altında çalıştırmak | [Statik ikili dosya](../server.md#without-a-container-the-static-binary) |
| Sunucumu Kubernetes'te çalıştırmak | [Kubernetes](../kubernetes.md) ve [chart başvurusu](../../chart/README.md) |
| Sunucuma evden uzaktayken kendi VPN'im ya da vekil sunucum üzerinden ulaşmak | [Ona yerel ağınızın dışından ulaşmak](../server.md#reaching-it-from-outside-your-lan) |
| Cloudflare kullanmak (isteğe bağlı) | [Cloudflare](cloudflare.md) |
| Sunucumun sertifikasına her cihazda güvenmek | [Sertifika yetkilisine güvenin](../server.md#trust-the-certificate-authority-once-per-device) |
| Ne kadar bellek ve disk gerektiğini bilmek | [Ne kadar bellek gerekir](../server.md#how-much-memory-it-needs) ve [Depolama](../storage.md) |
| Sunucumu yedeklemek | [İki birimi yedekleyin](../server.md#back-up-the-two-volumes) |
| Sunucumu yükseltmek | [Digest ile yükseltin](../server.md#upgrade-by-digest) |
| Cihazlarımı görmek ve birini iptal etmek | [Pano](../dashboard.md) |
| Sunucumu silip baştan başlamak | [Bir sunucuyu temizlemek](../purge.md) |
| Her sürümde neyin değiştiğini görmek | [`CHANGELOG.md`](../../CHANGELOG.md) |

### Güven ve gizlilik

| Şunu istiyorum… | Gidilecek yer |
| --- | --- |
| Bu eklentinin cihazımda ve ağımda neye dokunduğunu bilmek | [Bu eklenti neye erişir](#bu-eklenti-neye-erişir) |
| Neyin şifrelendiğini ve sunucunun neyi görebildiğini anlamak | [Tehdit modeli](../threat-model.md) ve [panonun tehdit modeli](../security/dashboard.md) |
| Bir güvenlik sorununu bildirmek | [`SECURITY.md`](../../SECURITY.md) |

### Projenin içi

Katkıda bulunanlar ve gözden geçirenler için: [`CONTRIBUTING.md`](../../CONTRIBUTING.md),
[mimari](../architecture.md), [protokol](../protocol.md),
[kıyaslamalar](../benchmarks.md), [cihaz doğrulama çalıştırmaları](../validation-runs/)
ve [tüm sayfalar](../README.md).

## Kurulum

![Eklentinin ayarları Get started ile açılıyor: Setup guide satırı ve Open the guide düğmesi, Server URL alanının üstünde](../assets/settings-get-started.png)

Eklentiyi **Ayarlar → Topluluk Eklentileri → Göz at** yolundan kurun.
**Self Hosted Private Sync** adını arayın (eklenti kimliği
`obsync-private-sync`). Obsidian 1.13.0 veya daha yenisi gerekir. Ayarları
kurulum kılavuzuyla başlar; kılavuzu tek bir düğmeyle açarsınız.

> [!IMPORTANT]
> - **Sizin** çalıştırdığınız bir sunucuyla eşitlenir: barındırılan bir hizmet yok, başka hiçbir yerde hesap yok.
> - Önce kasanızı yedekleyin; 24 kelimelik kurtarma ifadesini, onu üreten cihazın dışında saklayın.
> - Onu tek bir kasa üzerinde başka bir eşitlemenin (Obsidian Sync, bir bulut klasörü, başka bir eklenti) yanında asla çalıştırmayın.
> - Genç yazılım: sürümünüzün [`CHANGELOG.md`](../../CHANGELOG.md) girdisini okuyun, her cihazı güncelleyin ve her [doğrulama çalıştırmasının](../validation-runs/) neyi kapsadığını bilin.

## Eşitlemeye başlayın

En kısa eksiksiz yol, bu deponun bir kopyasından, kendi ağınızda Caddy ile
Compose'dur. Size her ağda HTTPS verir; alan adı da, herhangi bir yerde hesap
da gerekmez. [Aynı ağ, adım adım](../same-network.md) bu yolu her ekranıyla
anlatır. Aşağıdaki `vX.Y.Z` değerini kurduğunuz sürümle değiştirin: bu,
[Releases sayfasındaki](https://github.com/snaraj/obsync/releases/latest) en
yeni etikettir.

**1. İmajı doğrulayın.** Sonra tam olarak doğrulamanın yazdırdığı özeti
(digest) çalıştırın:

```sh
cosign verify ghcr.io/snaraj/obsync:vX.Y.Z \
  --certificate-identity https://github.com/snaraj/obsync/.github/workflows/release-publisher.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

**2. Sunucuyu başlatın:**

```sh
OBSYNC_IMAGE=ghcr.io/snaraj/obsync@sha256:<digest> \
  OBSYNC_HOST=sync.example.org \
  OBSYNC_BIND_ADDRESS=192.168.1.10 \
  docker compose -f deploy/compose/docker-compose.yml up -d
```

`OBSYNC_HOST`, cihazlarınızın yazacağı addır. Yalnızca kendi ağınızda
çözümlenmesi yeterlidir. `OBSYNC_BIND_ADDRESS`, 80 ve 443 portlarının
yayımlandığı adrestir: bir bağlama adresi kaynağı değil hedef arayüzü
sınırlar, bu yüzden ona kimin ulaşacağına güvenlik duvarınız karar verir.
Siz seçim yapana kadar Compose başlamayı reddeder.

**3. Kurulum belirtecini okuyun.** Sunucu ilk açılışta bir kurulum belirteci
üretir ve onu journal birimine 0600 kipiyle yazar; belirteç hiçbir günlüğe
geçmez. Hesabınızı bir kez oluşturur ve panonun kurtarma amaçlı oturum açma
yolu olarak kalır. Onu kurtarma ifadesi kadar özenle koruyun:

```sh
docker cp obsync-obsync-1:/data/journal/v1/setup-token - | tar -xO
```

**4. Her cihazı kurun.** Sunucunun sertifikasına bir kez güvenin
([nasıl](../server.md#trust-the-certificate-authority-once-per-device)).
Eklentiyi kurun, ardından [Hızlı başlangıç](../quickstart.md) sayfasını
izleyin: ilk cihazı kurun, sonra diğerlerini eşleyin.

Önünde zaten güvendiğiniz bir vekil sunucudan ya da tünelden gelen HTTPS mi
var? Bunun yerine
[yalın sunucuyu](../server.md#already-have-a-tls-terminator-docker)
çalıştırın.

## Bu eklenti neye erişir

- **Kendi sunucunuz, başka hiçbir yer.** Her istek, yazdığınız **Server URL** adresine gider; telemetri yok, üçüncü taraf yok.
- **O sunucudaki bir hesap**, kurulum belirtecinden oluşturulur; Obsidian hesabınızın bunda hiçbir rolü yoktur.
- **Kurulum ve güncelleme için, Obsidian üzerinden GitHub Releases**; Obsidian sürümdeki fazladan dosyaları yok sayar.
- **Kasanızın dosya listesi**, neyin eşitleneceğine karar vermek için; gizli (`.obsidian`, `.git`) ve sembolik bağlantılı klasörler atlanır.
- **Kopyalama panosu, yalnızca yazılır**: ona yalnızca **Pair a new device** içindeki **Copy code** ve **Copy link** yazar, asla okunmaz.
- **Kurulum kılavuzunu istediğinizde tarayıcınız.** Projenin kılavuzu orada açılır; eklentinin kendisi hiçbir şey göndermez.

Sunucunun neyi görebildiği ve neyi göremediği: [`SECURITY.md`](../../SECURITY.md) ve [tehdit modeli](../threat-model.md).

## Sürümler

LATEST sürüm, [Releases sayfasındaki](https://github.com/snaraj/obsync/releases/latest)
en yeni etikettir. Obsidian'ın kurduğu ve güncellediği sürüm budur. `main` ise
EDGE'dir: birleştirilmiş ama henüz yayımlanmamış iş, kaynaktan derleyenler
için. Beta kanalı ve ön sürüm etiketi yoktur. Değişiklik günlüğünün
Unreleased bölümü EDGE'in kaydıdır.

## Sorular, hatalar ve güvenlik

- **Bir soru ya da hata olup olmadığından emin değilseniz:** [Discussions](https://github.com/snaraj/obsync/discussions).
- **Bir hata:** [Sorun giderme](../troubleshooting.md#how-to-collect-a-report) sayfasının anlattığı raporla [bir issue açın](https://github.com/snaraj/obsync/issues/new/choose). Yayımlamayacağınız hiçbir belirteci, ifadeyi ya da adresi eklemeyin.
- **Şüphelenilen bir güvenlik açığı:** gizlice, [`SECURITY.md`](../../SECURITY.md) üzerinden; asla herkese açık bir issue ile değil.

## Lisans

MIT. Bkz. [`LICENSE`](../../LICENSE).
