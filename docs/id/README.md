> Terjemahan ini mengikuti [teks asli berbahasa Inggris](../../README.md). Teks bahasa Inggris adalah acuan resminya; perintah, opsi, URL, dan placeholder tidak diubah.

# Self Hosted Private Sync

Sinkronisasi langsung yang Anda hosting sendiri dan terenkripsi ujung ke
ujung untuk [Obsidian](https://obsidian.md): satu server Rust tanpa
dependensi dengan dasbor bawaan yang Anda jalankan sendiri, plus plugin ini.
Berkas sebesar apa pun, semua platform Obsidian, tanpa langganan, tanpa pihak
ketiga.

Pasang lewat Pengaturan → Plugin komunitas → Telusuri sebagai **Self Hosted
Private Sync** (id plugin `obsync-private-sync`), pada Obsidian 1.13.0 atau
yang lebih baru.

> [!IMPORTANT]
> Plugin ini menyinkronkan ke server yang **Anda** jalankan. Tidak ada layanan
> yang dihosting pihak lain dan tidak ada akun pada siapa pun selain diri Anda
> sendiri: tanpa `obsyncd` milik Anda sendiri yang bisa dijangkau lewat HTTPS,
> plugin ini tidak punya tempat tujuan untuk menyinkronkan.

> [!IMPORTANT]
> Cadangkan vault Anda sebelum sinkronisasi pertama, dan simpan frasa
> pemulihan 24 kata di tempat selain perangkat yang membuatnya. Server hanya
> menyimpan data terenkripsi dan tidak bisa memulihkan vault untuk Anda.

> [!IMPORTANT]
> Jangan jalankan plugin ini berdampingan dengan solusi sinkronisasi lain pada
> vault yang sama — Obsidian Sync, folder cloud yang menyinkronkan berkas,
> atau plugin sinkronisasi lain. Dua penulis pada satu vault menghasilkan
> konflik yang tidak bisa diselesaikan oleh keduanya.

## Sebelum Anda mengandalkannya

Ini perangkat lunak yang masih muda dan menyinkronkan satu-satunya salinan
catatan Anda.

- **[`CHANGELOG.md`](../../CHANGELOG.md) adalah daftar terpelihara tentang apa
  yang sudah diketahui.** Baca entri untuk versi yang sedang Anda pakai, dan
  entri-entri di atasnya. Halaman rilis mempertahankan catatan yang
  menyertainya saat diterbitkan; temuan yang datang kemudian ditambahkan di
  sini.
- **Perbarui setiap perangkat yang menyinkronkan sebuah vault.** Satu
  perangkat yang tertinggal pada versi lama masih bisa bertindak menurut
  perilaku lama dan memengaruhi perangkat lain.
- **Apa yang benar-benar diuji di perangkat keras** dicatat per sesi di
  [`docs/validation-runs/`](../validation-runs/), termasuk apa yang tidak
  dicakup setiap sesi. Platform yang tidak disebut satu sesi pun belum
  terbukti.
- **Aliran pemberitahuan "merged concurrent edits"** pada dua perangkat yang
  menyunting satu catatan: tutup Obsidian di salah satunya agar yang lain bisa
  menuntaskan pekerjaannya, perbarui keduanya, lalu lanjutkan.

## Apa yang diakses plugin ini

Singkat dan lengkap, agar Anda bisa memutuskan sebelum memasangnya.

- **Satu tujuan jaringan: server Anda sendiri.** Setiap permintaan menuju
  **Server URL** yang Anda ketik di pengaturan plugin, dan tidak ke mana pun
  selain itu. Tidak ada telemetri, tidak ada analitik, tidak ada pelapor
  kerusakan, tidak ada iklan, dan tidak ada layanan pihak ketiga di mana pun
  pada jalur sinkronisasi. Plugin ini juga tidak pernah mengunduh atau
  menjalankan kode dari server tersebut.
- **Sebuah akun di server itu, yang Anda buat sendiri.** Perangkat pertama
  memakai token penyiapan yang ditulis server Anda saat pertama kali
  dijalankan; setiap perangkat lain disandingkan dari perangkat yang sudah
  menyinkronkan. Akun Obsidian Anda tidak berperan sama sekali.
- **Obsidian dan GitHub, hanya untuk pemasangan dan pembaruan.** Obsidian
  sendirilah yang mengunduh `main.js`, `manifest.json`, dan `styles.css` dari
  GitHub Releases repositori ini. Setiap Release juga membawa ZIP plugin dan
  manifes rilis untuk orang yang menyiapkan server; Obsidian mengabaikan
  keduanya.
- **Edge Anda, hanya jika Anda mengonfigurasinya.** Header yang Anda tempel di
  bawah **Edge service-token headers** ikut pada setiap permintaan ke URL
  server di atas, karena proksi yang membutuhkannya berada di jalur menuju
  server Anda.
- **Daftar berkas vault Anda.** Plugin mendaftar setiap berkas di dalam vault
  untuk memutuskan apa yang masuk cakupan, membaca berkas di dalam pilihan
  folder Anda, dan menulis apa yang diubah perangkat lain. Folder tersembunyi
  (`.obsidian`, `.git`) dan folder yang berupa tautan simbolik dilewati.
- **Papan klip, hanya ditulis dan tidak pernah dibaca.** Hanya tombol **Copy
  code** dan **Copy link** di **Pair a new device** yang menulis ke sana.
  Tidak ada bagian plugin ini yang membaca papan klip.
- **Peramban Anda, saat Anda meminta dasbor.** **Open dashboard** membuka
  tautan masuk di peramban Anda, dan hanya jika tautan itu berada di domain
  asal server Anda sendiri.
- **Penyimpanan rahasia milik Obsidian.** Kunci vault, rahasia perangkat, dan
  nilai header edge mana pun tersimpan di sana, tidak pernah di data plugin
  biasa.

Apa yang bisa dan tidak bisa dilihat server ada di
[`SECURITY.md`](../../SECURITY.md) dan
[`docs/threat-model.md`](../threat-model.md).

## Tersinkron dalam lima langkah

Jalur yang dipakai untuk memvalidasi rilis ini, dari vault kosong sampai dua
perangkat yang tersinkron. Kelimanya mengandaikan server Anda sendiri sudah
berjalan, yang dibahas di bagian bawah; setiap langkah ditulis lengkap di
panduan cepat.

1. **Pasang dari Plugin komunitas.** Di Pengaturan → Plugin komunitas →
   Telusuri, cari **Self Hosted Private Sync** lalu pilih Pasang, kemudian
   Aktifkan — persis seperti cara setiap plugin Obsidian lain tiba, di semua
   platform.

   ![Penjelajah Plugin komunitas milik Obsidian menampilkan Self Hosted Private Sync beserta tombol Pasang miliknya](../captures/01-install-from-directory.png)

2. **Arahkan ke server Anda lalu siapkan.** Buka tab pengaturan plugin, setel
   **Server URL** ke server Anda sendiri, pilih folder mana saja yang
   disinkronkan perangkat ini, lalu tempel token penyiapan Anda di bawah
   **First-time setup**.

   ![Tab pengaturan plugin yang digulir ke pilihan folder, baris Pairing, dan kolom token First-time setup](../captures/02-first-time-setup.png)

3. **Simpan frasa pemulihan.** Penyiapan membuat kunci vault di perangkat ini
   dan menampilkan frasa 24 kata satu kali saja: tulislah dan simpan di tempat
   selain perangkat ini, karena server hanya menyimpan data terenkripsi dan
   tidak bisa memulihkan vault untuk Anda.

   ![Dialog frasa pemulihan yang muncul setelah penyiapan pertama, kata-katanya disamarkan](../captures/03-recovery-phrase.png)

4. **Sandingkan perangkat kedua dengan kode sekali pakai.** Jalankan **Pair a
   new device** di perangkat pertama, masukkan kode yang ditampilkannya di
   perangkat kedua dalam sepuluh menit, lalu setujui perangkat itu berdasarkan
   namanya — kunci vault berpindah dalam keadaan terenkripsi di bawah rahasia
   penyandingan yang tidak pernah dilihat server.

   ![Dialog Pair a new device di perangkat pertama, kode sekali pakainya disamarkan](../captures/04-pair-a-new-device.png)

5. **Sunting di salah satu perangkat dan lihat hasilnya tiba.** Ketik pada
   sebuah catatan di satu perangkat dan catatan itu muncul di perangkat lain
   dalam hitungan detik, di kedua arah, dengan bilah status menunjukkan apa
   yang sedang dikerjakan sinkronisasi.

   ![Catatan sekali pakai yang memuat suntingan kedua perangkat, dengan bilah status sinkronisasi terlihat](../captures/05-sync-both-ways.png)

Daftar perangkat di dasbor dan tombol pencabutannya dijelaskan di
[Melihat perangkat Anda](../daily-use.md#see-your-devices) dan tidak diuji
pada sesi perangkat 1.0.0 yang tercatat di
[docs/validation-runs/2026-09-14.md](../validation-runs/2026-09-14.md).

## Mulai menyinkronkan

Jalur benar yang terpendek: satu mesin milik Anda menjalankan server, setiap
perangkat menjangkaunya lewat HTTPS, dan setiap perangkat disandingkan satu
kali. Masuk ke Obsidian tidak memberi wewenang apa pun di sini; satu-satunya
akun adalah akun di server Anda.

### 1. Jalankan server

Ada dua cara menjalankannya. Keduanya menjalankan persis byte yang
ditandatangani penerbit: verifikasi tanda tangannya, baca digest dari keluaran
yang terverifikasi, lalu jalankan digest itu. `v1.0.6` adalah rilis yang
menjadi acuan penulisan halaman ini; pakai tag rilis yang sedang Anda pasang.

```sh
cosign verify ghcr.io/snaraj/obsync:v1.0.6 \
  --certificate-identity https://github.com/snaraj/obsync/.github/workflows/release-publisher.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

**Belum punya HTTPS?** `deploy/compose` menjalankan server di belakang
terminator TLS miliknya sendiri (Caddy), di jaringan mana pun, tanpa domain
dan tanpa akun pada siapa pun. Dari hasil checkout repositori ini:

```sh
OBSYNC_IMAGE=ghcr.io/snaraj/obsync@sha256:<digest> \
  OBSYNC_HOST=sync.example.org \
  OBSYNC_BIND_ADDRESS=192.168.1.10 \
  docker compose -f deploy/compose/docker-compose.yml up -d
```

`OBSYNC_HOST` adalah nama yang akan diketik perangkat Anda. Nama itu cukup
bisa diselesaikan di jaringan Anda sendiri. `OBSYNC_BIND_ADDRESS` adalah
alamat host ini tempat port 80 dan 443 dipublikasikan: alamat bind membatasi
antarmuka tujuan, bukan sumbernya, jadi firewall Andalah yang menentukan siapa
yang bisa menjangkaunya. Compose menolak berjalan sebelum Anda memilih.
Keduanya dijelaskan di [Menjalankan server](../server.md).

**Sudah punya HTTPS di depan** mesin itu, dari reverse proxy atau tunnel yang
Anda percayai? Jalankan server polos. Ia berbicara HTTP biasa di port 8080,
dan terminator Anda meneruskan ke sana:

```sh
docker volume create obsync-blobs
docker volume create obsync-journal
docker run -d --name obsync -p 127.0.0.1:8080:8080 \
  -v obsync-blobs:/data/blobs -v obsync-journal:/data/journal \
  -e OBSYNC_BLOBS_CAPACITY=250GiB -e OBSYNC_JOURNAL_CAPACITY=4GiB \
  -e OBSYNC_PUBLIC_URL=https://sync.example.org \
  ghcr.io/snaraj/obsync@sha256:<the digest cosign just verified>
```

### 2. Baca token penyiapan

Saat pertama kali dijalankan, server mencetak token penyiapan dan
menuliskannya ke volume jurnalnya, mode 0600, tidak pernah masuk log. Token
itu membuat akun Anda satu kali, lalu tetap menjadi cara masuk pemulihan bagi
dasbor selama server itu hidup: jagalah dengan kehati-hatian yang sama seperti
frasa pemulihan. Bacalah langsung dari kontainernya, tanpa image bantuan. Pada
jalur Compose:

```sh
docker cp obsync-obsync-1:/data/journal/v1/setup-token - | tar -xO
```

Pada jalur server polos:

```sh
docker cp obsync:/data/journal/v1/setup-token - | tar -xO
```

### 3. Percayai sertifikatnya, sekali per perangkat (jalur Compose)

Caddy menerbitkan sertifikat itu dari otoritas yang dibuatnya sendiri saat
pertama kali dijalankan, jadi setiap perangkat harus diberi tahu satu kali
agar memercayai otoritas tersebut. Ekspor sertifikat akarnya:

```sh
docker cp obsync-caddy-1:/data/caddy/pki/authorities/local/root.crt - | tar -xO > obsync-root.crt
```

Pasang `obsync-root.crt` di setiap perangkat. Langkah untuk macOS, Windows,
Linux, iOS, dan Android ada di
[Memercayai otoritas sertifikat, sekali per perangkat](../server.md#trust-the-certificate-authority-once-per-device).
Di iOS, memercayai sertifikat adalah sakelar kedua setelah memasangnya.

### 4. Siapkan perangkat pertama

1. Pengaturan → Plugin komunitas → Telusuri → **Self Hosted Private Sync** →
   Pasang → Aktifkan.
2. Di pengaturan plugin, setel **Server URL** ke server Anda, lengkap dengan
   port bila bukan 443: `https://sync.example.org`.

   ![Tab pengaturan plugin: kolom Server URL yang memuat nama host contoh, kotak header edge, dan baris Connection dengan tombol Check dan Open dashboard miliknya](../assets/settings-server.png)

3. Pilih **Whole vault** atau **Selected folders only** sekarang. Begitu
   sebuah perangkat sudah menyinkronkan, pilihannya hanya bisa dipersempit.
4. Tempel token penyiapan di bawah **First-time setup** lalu pilih **Set up**.
   Tulis frasa pemulihan 24 kata itu dan simpan di luar perangkat ini.

   ![Bagian This device pada tab pengaturan: baris Pairing dengan Pair this device dan Pair a new device, baris First-time setup dengan kolom Setup token dan tombol Set up, serta baris Vault key](../assets/settings-setup.png)

### 5. Sandingkan perangkat kedua

1. Pasang dan aktifkan plugin di perangkat itu, setel **Server URL** yang
   sama, lalu pilih foldernya.
2. Di perangkat pertama, jalankan **Pair a new device**. Perintah itu
   menampilkan kode yang berlaku sepuluh menit.

   ![Dialog Pair a new device di perangkat pertama, kodenya disamarkan, dengan tombol Copy code dan Copy link serta baris Waiting for the new device](../assets/pair-new-device.png)

3. Di perangkat kedua, buka **Pair this device**, tempel kodenya, lalu pilih
   **Pair**.

   ![Dialog Pair this device di perangkat kedua, dengan kolom Pairing code yang kosong dan tombol Pair](../assets/pair-this-device.png)

4. Kembali di perangkat pertama, setujui perangkat baru itu berdasarkan
   namanya. Sunting sebuah catatan di salah satunya; catatan itu muncul di
   perangkat lain dalam hitungan detik.

   ![Perangkat pertama menanyakan apakah perangkat baru itu disetujui berdasarkan namanya, dengan tombol Approve dan Reject](../assets/pair-approve.png)

   ![Perangkat kedua menampilkan catatan yang ditulis di perangkat pertama, dengan bilah status bertuliskan obsync idle](../assets/first-sync.png)

Seluruh pertukaran penyandingan, dalam satu putaran singkat:

![Animasi: kode penyandingan ditampilkan di perangkat pertama, ditempel di perangkat kedua, disetujui di perangkat pertama, dan catatan pertama tiba di perangkat kedua](../assets/pairing.gif)

Tangkapan layar dari ponsel belum ada di repositori ini; tangkapan itu diambil
di perangkat milik pengelola sendiri dan ditambahkan ketika sebuah sesi
validasi mencatatnya.

Setiap langkah selengkapnya, beserta apa yang diminta setiap layar dan
mengapa: [Panduan cepat](../quickstart.md).

**Mencobanya di satu komputer saja?** Di komputer, plugin juga menerima alamat
`http://` biasa, sehingga `http://127.0.0.1:8080` menjangkau server polos di
atas tanpa terminator. Ponsel tidak: Obsidian di iOS dan Android menolak HTTP
biasa.

## Lanjutan: Cloudflare

Penyiapan acuan **tidak punya nama host publik**. Sebuah Cloudflare Tunnel
menghubungkan jaringan privat server ke Cloudflare, sebuah rute privat memberi
tahu Cloudflare alamat mana yang berada di balik tunnel itu, dan klien
Cloudflare One di setiap perangkat membawa URL server ke sana. Tidak ada yang
bisa dijangkau dari internet, dan sinkronisasi pertama yang besar tidak
diproksi lewat nama host publik. Bentuk yang lain, yaitu nama host publik di
belakang Cloudflare Access dengan token layanan di **Edge service-token
headers** dan `OBSYNC_EDGE=cloudflare` di server, juga didukung. Keduanya,
langkah demi langkah: [Cloudflare](cloudflare.md).

## Cara lain menjangkau server Anda

Satu baris untuk masing-masing, bukan tutorial. Apa pun yang Anda pilih,
plugin memerlukan HTTPS dengan sertifikat yang dipercaya setiap perangkat, dan
server itu sendiri tetap memakai HTTP biasa di belakang terminator tersebut.

- **Hanya LAN.** Jalur Compose di atas, hanya terjangkau di rumah. Paling
  sederhana; tidak ada sinkronisasi saat bepergian.
- **WireGuard.** VPN Anda sendiri yang kembali ke jaringan Anda. Paling cepat
  dan sepenuhnya milik Anda; Anda membawa konfigurasi peer di setiap perangkat
  dan menjaga satu endpoint tetap terjangkau.
- **Tailscale.** Mesh WireGuard terkelola dengan nama-namanya sendiri. Paling
  sedikit penyiapan di perangkat; ada pihak ketiga yang mengoordinasikan mesh
  itu, dan batasan paketnya Anda sendiri yang harus membacanya.
- **Reverse proxy dengan TLS otomatis**, misalnya Caddy pada nama publik.
  Sertifikat yang dipercaya publik dan alamat permanen; server lalu bisa
  dijangkau dari internet, dan proksi beserta pembaruannya menjadi tanggung
  jawab Anda untuk dijaga tetap benar.
- **Cloudflare Tunnel.** Lihat di atas. Tanpa port masuk; ada penyedia di
  jalur dengan ketentuannya sendiri.

Apa yang dibutuhkan perangkat yang sedang bepergian, apa pun pilihan Anda
(rute, nama, sertifikat, permintaan izin jaringan lokal di iOS, firewall):
[Menjangkaunya dari luar LAN Anda](../server.md#reaching-it-from-outside-your-lan).

## Pemecahan masalah

| Gejala | Kemungkinan penyebab | Hal pertama yang bisa dicoba |
| --- | --- | --- |
| `obsync: offline` | Perangkat tidak bisa menjangkau URL server | Buka URL itu di peramban pada perangkat yang sama; periksa port, HTTPS, dan rutenya |
| Ponsel tidak mau terhubung padahal komputer menyinkronkan | Sertifikat privat itu tidak dipercaya di ponsel | Pasang sertifikat akarnya; di iOS, nyalakan juga di bawah "Certificate Trust Settings" |
| `401 stale_timestamp` | Ada jam yang meleset lebih dari 300 detik | Nyalakan waktu otomatis, di perangkat atau di server |
| `403 device_pending` | Belum ada yang menyetujui perangkat itu | Setujui berdasarkan namanya di perangkat tempat Anda menyandingkannya |
| Sebuah berkas tidak pernah tiba | Berkas itu di luar pilihan folder, atau di atas batas ukuran sebuah ponsel | Periksa **Sync folders on this device**; di ponsel jalankan **Show remote-only files** |

Setiap gejala lain, setiap kode galat, dan cara mengumpulkan laporan yang
layak dikirim: [Pemecahan masalah](../troubleshooting.md).

## Dokumentasi

| Halaman | Yang dijawabnya |
| --- | --- |
| [Panduan cepat](../quickstart.md) | Perangkat pertama dan perangkat kedua, setiap langkah selengkapnya |
| [Menjalankan server](../server.md) | Docker, Compose dengan Caddy, sertifikat, cadangan, menjangkaunya dari luar LAN Anda |
| [Cloudflare](cloudflare.md) | Tunnel dengan rute privat dan klien Cloudflare One, atau nama host publik di belakang Access |
| [Kubernetes](../../chart/README.md) | Memasang server dengan chart Helm yang ditandatangani |
| [Penggunaan sehari-hari](../daily-use.md) | Perintah, bilah status, apa yang disinkronkan dan apa yang tidak, memulihkan sebuah versi, dasbor |
| [Pengaturan](../settings.md) | Setiap pengaturan, nilai bawaannya, dan kapan harus mengubahnya |
| [Pemecahan masalah](../troubleshooting.md) | Gejala, penyebab, perbaikan, dan cara mengumpulkan laporan |
| [Konflik](../conflicts.md) | Apa itu salinan konflik dan apa yang harus dilakukan dengannya |
| [Pemulihan](../recovery.md) | Perangkat yang hilang, server yang hilang, server yang pindah, token yang dirotasi |
| [Memasang dan memperbarui](../community-plugin.md) | Direktori Obsidian, pembaruan, penyimpanan kredensial, peninjauan entri direktori |
| [Model ancaman](../threat-model.md) | Apa yang dipertahankan, dan apa yang tidak |
| [Model ancaman dasbor](../security/dashboard.md) | Sesi, proses masuk, pencabutan, sisa risiko |
| [Arsitektur](../architecture.md) | Bagaimana seluruh sistem dibangun, dan setiap variabel lingkungan |
| [Protokol](../protocol.md) | Kontrak protokol antara plugin dan server |
| [Penyimpanan](../storage.md) | Volume, daya tahan, retensi, scrub, dan setiap penolakan |
| [Validasi](../validation.md) | Rencana validasi perangkat dan apa arti "siap" |
| [Rilis](../release.md) | Bagaimana sebuah rilis dibuat, ditandatangani, dan diaudit |
| [Terjemahan](../translations.md) | Dalam bahasa apa saja panduan ini tersedia, dan bagaimana semuanya dijaga tetap mutakhir |
| [`CHANGELOG.md`](../../CHANGELOG.md) | Apa yang berubah di setiap versi |
| [`SECURITY.md`](../../SECURITY.md) | Sikap keamanan, versi yang didukung, dan cara melaporkan kerentanan |
| [`CONTRIBUTING.md`](../../CONTRIBUTING.md) | Cara mengerjakan repositori ini |

## Pertanyaan, bug, dan keamanan

- **Sebuah pertanyaan, atau sesuatu yang Anda tidak yakin apakah itu bug:**
  [Discussions](https://github.com/snaraj/obsync/discussions).
- **Sebuah bug:** [buka issue](https://github.com/snaraj/obsync/issues/new/choose)
  dengan templat laporan bug dan laporan yang dijelaskan di
  [Pemecahan masalah](../troubleshooting.md). Jangan sertakan token, frasa
  pemulihan, atau alamat yang tidak ingin Anda publikasikan.
- **Dugaan kerentanan:** secara privat, lewat
  [`SECURITY.md`](../../SECURITY.md) — jangan pernah sebagai issue publik.

## Lisensi

MIT. Lihat [`LICENSE`](../../LICENSE).
