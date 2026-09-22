> Bu çeviri [İngilizce aslını](../cloudflare.md) izler. Esas olan İngilizce metindir; komutlar, seçenekler, URL'ler ve yer tutucular olduğu gibi kalır.

# Cloudflare

Cloudflare'i cihazlarınızla sunucunuzun arasına koymanın iki yolu ve referans
kurulumun hangisini kullandığı. İkisi de zorunlu değil: sunucu hiçbir
sağlayıcıyı adıyla tanımaz ve [Sunucuyu çalıştırma](../server.md) kimsede
hesap gerektirmez. Bu sayfa, yönlendiricinizde port açmadan evden uzaktayken
sunucuya ulaşmak istiyorsanız ya da önünde bir erişim politikası olan
yayımlanmış bir ana bilgisayar adı istiyorsanız size göre.

Cloudflare'in menüleri ve plan koşulları değişir. Aşağıdaki her adım, menü
yolunu Cloudflare belgelerinin 2026-09-22 tarihinde verdiği haliyle anar;
bir sınıra ya da fiyata güvenmeden önce güncel sayfaya bakın.

## Hangi seçenek

| Seçenek | Cihazların gördüğü | İnternetin gördüğü | Büyük ilk eşitleme |
| --- | --- | --- | --- |
| **Özel rota** (referans kurulum) | Cloudflare One istemcisi üzerinden kendi özel adresiniz ve adınız | hiçbir şey: ne ana bilgisayar adı ne de açık port | özel ağ trafiği, herkese açık bir ana bilgisayar adı üzerinden geçmez |
| **Access arkasında herkese açık ana bilgisayar adı** | herkese açık bir ad, bir Access politikası, eklentide bir hizmet belirteci | Access'in arkasındaki ana bilgisayar adı | Cloudflare üzerinden geçer, büyük dosyalar için sağlayıcının koşullarına tabidir |

Özel rota referans seçenektir; çünkü sunucu görünmez kalır ve Cloudflare'in
kendi belgeleri büyük aktarımları o yola gönderir: herkese açık ana
bilgisayar adı rotası trafiği Cloudflare üzerinden geçirir ve Free, Pro ve
Business planlarında hizmete özel koşullar video ve diğer büyük dosyalar için
ücretli bir hizmet ister; özel ağ rotası ise bunları sizin kendi trafiğiniz
olarak taşır. Her iki seçenekte de büyük ilk eşitlemeyi yerel ağda yapın.

TLS'yi ne sonlandırıyorsa kimlik bilgilerinizi okur, notlarınızı asla: her
parça ve her manifest cihazda şifrelenir ve onları çözebilecek hiçbir anahtar
hattan geçmez ([tehdit modeli](../threat-model.md)). Özel rotada sonlandırıcı
sizindir, kendi ağınızın içindedir. Herkese açık ana bilgisayar adında uç
nokta da bir sonlandırıcıdır.

## Seçenek A: özel bir rota ve Cloudflare One istemcisi

Sunucu kendi ağınızda özel bir adres tutar. Yanında bir tünel bağlayıcısı
çalışır, bir rota Cloudflare'e o tünelin arkasında hangi adreslerin
bulunduğunu söyler ve her cihazdaki Cloudflare One istemcisi (eski adıyla
WARP) bu adreslere giden trafiği tünelden taşır. Cihazlarınızın yazdığı
sunucu URL'si, bu özel adrese çözümlenen özel bir addır.

Gerekenler: Zero Trust kuruluşu ("takım adı") olan bir Cloudflare hesabı,
sunucunun ağında tünel bağlayıcısını çalıştırabilecek bir makine ve evden
uzakta eşitleme yapacak her cihazda Cloudflare One istemcisi.

1. **Bir tünel oluşturun.** Cloudflare panosunda **Networking** >
   **Tunnels** bölümüne gidin ve bir `cloudflared` tüneli oluşturun. Size
   verdiği bağlayıcıyı sunucunun ağındaki bir makinede çalıştırın: kümede
   sunucunun yanında ya da aynı ana makinede.
2. **Sunucunun özel adresini tünelden yönlendirin.** **Networking** >
   **Routes** bölümüne gidin, **Create route** > **Tunnel CIDR** seçin,
   tüneli seçin ve sunucunun özel adresini ya da alt ağını girin. Tek adres
   yeter; alt ağ sonradan genişletilebilir.
3. **Her cihazı kaydedin.** Cloudflare One istemcisini kurun, takım adınızı
   girin, kuruluşunuzun istediği oturum açmayı tamamlayın ve bağlantıyı
   açın. iOS ve Android'de istemci bir VPN profili kurmak ister; kabul edin.
   Cihaz kayıt izinlerini yalnızca kendi kimliğiniz kayıt yapabilecek şekilde
   ayarlayın.
4. **Özel aralığı istemciden geçirin.** İstemcinin Split Tunnels
   yapılandırmasında 2. adımdaki adresin istemci üzerinden yönlendirildiğinden
   emin olun. **Exclude** modunda onu içeren RFC 1918 bloğunu kaldırıp hâlâ
   dışarıda tutmak istediğiniz aralıkları yeniden ekleyin; **Include**
   modunda adresi ya da alt ağı ekleyin.
5. **Adın cihazda çözümlenmesini sağlayın.** Eklenti her isteği yazdığınız
   sunucu URL'sine gönderir; bu yüzden o adın dışarıdaki cihazda
   çözümlenmesi gerekir: bir ana bilgisayar adı rotası, kendi çözümleyicinize
   Local Domain Fallback ya da özel bir DNS kaydı. İstemcinin yönlendirmediği
   bir adrese çözümlenen ad, tıpkı kapalı bir sunucu gibi başarısız olur.
6. **TLS'yi kendiniz sonlandırın.** Rota trafiğinizi kendi
   sonlandırıcınıza taşır: sunucunun önünde, her cihazın güvendiği bir
   sertifikaya sahip bir ingress ya da ters vekil, tıpkı
   [Sunucuyu çalıştırma](../server.md) sayfasındaki gibi. Sunucu
   `OBSYNC_EDGE=none` ile çalışır ve iletilen adreslere yalnızca
   sonlandırıcının kendi aralığı olan `OBSYNC_TRUSTED_PROXY_CIDRS` içinden
   güvenir.
7. **İsterseniz Gateway ile süzün.** Bir Gateway ağ politikası, sunucunun
   adresine ve portuna yalnızca kayıtlı cihazlarınızın ulaşmasına izin verip
   o rotadaki diğer her şeyi engelleyebilir.
8. **Ağınızın dışındaki bir cihazdan doğrulayın.** O cihazdaki tarayıcıda
   sunucu URL'sini açın ve panonun oturum açma sayfasını bekleyin. Eklentide
   **Connection** altındaki **Check** düğmesine basın: tek bir gidiş-dönüş
   adresi, sertifikayı ve kimlik bilgisini birlikte kanıtlar.

Ödünler:

- Eşitleme yapan her cihaz Cloudflare One istemcisini çalıştırır ve evden
  uzakta eşitlemenin çalışması için istemcinin bağlı olması gerekir.
- Cloudflare, cihaz ile tünel bağlayıcısı arasındaki trafiği taşır. Gateway
  TLS şifre çözmeyi kapalı bırakın; o zaman trafik, adresler, boyutlar ve
  zamanlama dışında ona kapalıdır; bunları [tehdit modeli](../threat-model.md)
  zaten her ağ yoluna tanır.
- Bağlayıcı, ağınızda Cloudflare'e giden bir çıkış bağlantısını açık tutan bir
  süreçtir. Düştüğünde dışarıdaki cihazlar `obsync: offline` gösterir, yerel
  ağ ise çalışmaya devam eder.

## Seçenek B: Access arkasında herkese açık bir ana bilgisayar adı

Sunucu, Cloudflare'de sahip olduğunuz bir alan adında bir ana bilgisayar adı
alır. Tünel bu adı sunucunun özel adresine yayımlar ve önünde Cloudflare
Access durur: pano için bir kimlik politikası, eklentinin API çağrıları için
bir hizmet belirteci. Bu, [platform entegrasyonu](../platform-onboarding.md)
sayfasının referans küme için anlattığı ve referans kurulumun tercih etmediği
seçenektir.

1. **Ana bilgisayar adını yayımlayın.** Tünelin yapılandırmasında, ana
   bilgisayar adınızdan (`sync.example.com` sizinkinin yerine geçer)
   sunucunun özel HTTP adresine, 8080 portuna giden bir yayımlanmış uygulama
   rotası ekleyin. DNS kaydını Cloudflare oluşturur.
2. **Access'i öne koyun.** **Zero Trust** > **Access controls** >
   **Applications** bölümüne gidin, o ana bilgisayar adında bir
   **Self-hosted** uygulama oluşturun ve pano için yalnızca size izin veren
   bir kimlik politikası ekleyin; örneğin kendi adresinize gönderilen tek
   kullanımlık bir PIN.
3. **Eklenti için bir hizmet belirteci oluşturun.** **Zero Trust** >
   **Access controls** > **Service credentials** > **Service Tokens**
   bölümüne gidin, bir tane oluşturun ve Client ID ile Client Secret'ı
   kopyalayın; gizli anahtar yalnızca bir kez gösterilir. Uygulamaya, bu
   belirteci kapsayan bir **Service Auth** politikasını eklentinin kullandığı
   yollar (`/v1/*`) için ekleyin.
4. **Belirteci eklentiye yapıştırın.** **Edge service-token headers**
   altında, satır başına bir tane, Cloudflare'in adlandırdığı gibi:

   ```text
   CF-Access-Client-Id: <the client id>
   CF-Access-Client-Secret: <the client secret>
   ```

   Bunlar sunucu URL'sine giden her istekle birlikte gider, başka hiçbir
   şeyle değil.
5. **Sunucuya uç noktanın arkasında olduğunu söyleyin.** Onu
   `OBSYNC_EDGE=cloudflare` ile çalıştırın. Bu modda her istek, uç noktanın
   bağlanan adres ve istek kimliği başlıklarını taşımak zorundadır; uç
   noktayı atlayarak gelen bir istek `421 edge_required` ile reddedilir
   ([sorun giderme](../troubleshooting.md#edge_required)).
6. **Doğrulayın.** Ana bilgisayar adını tarayıcıda açın; önce Access oturum
   açmasını, sonra panoyu bekleyin. Eklentide **Connection** altındaki
   **Check** düğmesine basın.

Ödünler:

- Ana bilgisayar adı herkese açıktır. Access yabancıları reddeder ve sunucu
  her cihaz isteğini yine kendisi doğrular; ama ad vardır ve bulunabilir.
- Hizmet belirteci bir kimlik bilgisidir. Elinde olan herkes API'nin ön
  kapısına ulaşır; sunucunun kendi cihaz doğrulaması yine arkasında durur.
  Açığa çıkarsa Cloudflare'de yenileyin.
- Büyük aktarımlar yukarıdaki koşullarla Cloudflare üzerinden geçer. Büyük
  ilk eşitlemeyi yerel ağda yapın.
- Bu modda panonun Cihazlar sayfasının adres ve ülke olarak gösterdiği şey,
  uç noktanın bağlanan adres ve ülke başlıklarıdır.

## Neyin kanıtlandığı

Özel rota, referans kurulumun rotasıdır.
[2026-09-14 çalıştırması](../validation-runs/2026-09-14.md) o gün
denenmediğini ve nedenini kaydeder;
[2026-09-20 çalıştırması](../validation-runs/2026-09-20.md) referans rotada,
bağlantı ve TLS denetimleri geçilmiş bir cihaz çalıştırmasını kaydeder.
Herkese açık ana bilgisayar adı seçeneği kayıtlı hiçbir çalıştırmada
denenmemiştir.

## Sonraki adım

- [Sunucuyu çalıştırma](../server.md): sonlandırıcı, birimler, kurulum
  belirteci.
- [Kubernetes](https://github.com/snaraj/obsync/blob/main/chart/README.md): referans kurulumun kullandığı chart.
- [Platform entegrasyonu](../platform-onboarding.md): referans kümenin
  yayımlanmış bir ana bilgisayar adı için ekleyecekleri.
- [Sorun giderme](../troubleshooting.md): `edge_required`, `offline` ve
  sertifika.
