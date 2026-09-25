> Terjemahan ini mengikuti [teks asli berbahasa Inggris](../../README.md). Teks bahasa Inggris adalah acuan resminya; perintah, opsi, URL, dan placeholder tidak diubah.

<img src="../../brand/obsync-icon-256.png" alt="ikon obsync: dua cincin yang saling terkait" width="96" height="96">

# Self Hosted Private Sync

Sinkronisasi langsung yang Anda hosting sendiri dan terenkripsi ujung ke
ujung untuk [Obsidian](https://obsidian.md): satu server Rust tanpa
dependensi dengan dasbor bawaan yang Anda jalankan sendiri, plus plugin ini.
Berkas sebesar apa pun, semua platform Obsidian, tanpa langganan, tanpa pihak
ketiga.

Pasang lewat Pengaturan → Plugin komunitas → Telusuri sebagai **Self Hosted
Private Sync** (id plugin `obsync-private-sync`), pada Obsidian 1.13.0 atau
yang lebih baru.

**Baru di sini? Mulailah dari [panduan penyiapan](https://snaraj.github.io/obsync/setup/) (berbahasa Inggris).** Panduan ini membantu Anda memilih cara perangkat menjangkau server Anda dan menjelaskan setiap cara langkah demi langkah. Di Obsidian: Pengaturan → Self Hosted Private Sync → Setup guide.

> [!IMPORTANT]
> - Plugin ini menyinkronkan ke server yang **Anda** jalankan: tidak ada layanan yang dihosting pihak lain, tidak ada akun di tempat lain.
> - Cadangkan vault Anda lebih dahulu; simpan frasa pemulihan 24 kata di luar perangkat yang membuatnya.
> - Jangan pernah menjalankannya berdampingan dengan sinkronisasi lain (Obsidian Sync, folder cloud, plugin lain) pada satu vault.
> - Perangkat lunak yang masih muda: baca entri [`CHANGELOG.md`](../../CHANGELOG.md) untuk versi Anda, perbarui setiap perangkat, dan ketahui apa yang dicakup setiap [sesi validasi](../validation-runs/).

## Apa yang diakses plugin ini

- **Server Anda sendiri, tidak ada yang lain.** Setiap permintaan menuju **Server URL** yang Anda ketik; tanpa telemetri, tanpa pihak ketiga.
- **Sebuah akun di server itu**, dibuat dari token penyiapan; akun Obsidian Anda tidak berperan sama sekali.
- **GitHub Releases, lewat Obsidian**, untuk pemasangan dan pembaruan; Obsidian mengabaikan aset rilis tambahannya.
- **Daftar berkas vault Anda**, untuk memutuskan apa yang disinkronkan; folder tersembunyi (`.obsidian`, `.git`) dan folder tautan simbolik dilewati.
- **Papan klip, hanya ditulis** oleh **Copy code** dan **Copy link** di **Pair a new device**, tidak pernah dibaca.

Apa yang bisa dan tidak bisa dilihat server: [`SECURITY.md`](../../SECURITY.md) dan [model ancaman](../threat-model.md).

## Mulai menyinkronkan

Lima langkah dari nol sampai dua perangkat yang tersinkron. `v1.0.6` adalah
rilis yang menjadi acuan penulisan halaman ini; pakai tag yang sedang Anda
pasang.

### 1. Jalankan server

Verifikasi tanda tangannya, lalu jalankan persis digest yang dicetaknya:

```sh
cosign verify ghcr.io/snaraj/obsync:v1.0.6 \
  --certificate-identity https://github.com/snaraj/obsync/.github/workflows/release-publisher.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Jalur yang sederhana adalah Compose dengan Caddy, dari hasil checkout
repositori ini: HTTPS di jaringan mana pun, tanpa domain, tanpa akun di mana
pun.

```sh
OBSYNC_IMAGE=ghcr.io/snaraj/obsync@sha256:<digest> \
  OBSYNC_HOST=sync.example.org \
  OBSYNC_BIND_ADDRESS=192.168.1.10 \
  docker compose -f deploy/compose/docker-compose.yml up -d
```

`OBSYNC_HOST` adalah nama yang akan diketik perangkat Anda; nama itu cukup
bisa diselesaikan di jaringan Anda sendiri. `OBSYNC_BIND_ADDRESS` adalah
alamat tempat port 80 dan 443 dipublikasikan: alamat bind membatasi antarmuka
tujuan, bukan sumbernya, jadi firewall Andalah yang menentukan siapa yang bisa
menjangkaunya. Compose menolak berjalan sebelum Anda memilih.

Sudah punya HTTPS di depan, dari proksi atau tunnel yang Anda percayai?
Jalankan server polos sebagai gantinya: [Menjalankan server](../server.md).

### 2. Baca token penyiapan

Saat pertama kali dijalankan, server mencetak token penyiapan dan
menuliskannya ke volume jurnalnya, mode 0600, tidak pernah masuk log. Token
itu membuat akun Anda satu kali dan tetap menjadi cara masuk pemulihan bagi
dasbor: jagalah seperti frasa pemulihan. Bacalah dari kontainernya:

```sh
docker cp obsync-obsync-1:/data/journal/v1/setup-token - | tar -xO
```

### 3. Percayai sertifikatnya, sekali per perangkat

Caddy menandatangani dengan otoritas yang dibuatnya sendiri saat pertama kali
dijalankan; setiap perangkat harus memercayainya satu kali. Ekspor sertifikat
akarnya lalu pasang di setiap platform seperti yang ditunjukkan
[Menjalankan server](../server.md#trust-the-certificate-authority-once-per-device);
di iOS, memercayainya adalah sakelar kedua setelah memasangnya.

### 4. Siapkan perangkat pertama

1. Pengaturan → Plugin komunitas → Telusuri → **Self Hosted Private Sync** →
   Pasang → Aktifkan.
2. Setel **Server URL** ke server Anda (`https://sync.example.org`, lengkap
   dengan port bila bukan 443), lalu pilih **Whole vault** atau **Selected
   folders only**; nanti pilihannya hanya bisa dipersempit.

   ![Tab pengaturan plugin: kolom Server URL yang memuat nama host contoh, kotak header edge, dan baris Connection dengan tombol Check dan Open dashboard miliknya](../assets/settings-server.png)

3. Tempel token penyiapan di bawah **Setup or recover**, pilih **Set up or recover**,
   lalu tulis frasa pemulihan 24 kata itu.

   ![Bagian This device pada tab pengaturan: baris Pairing dengan Pair this device dan Pair a new device, baris First-time setup dengan kolom Setup token dan tombol Set up, serta baris Vault key](../assets/settings-setup.png)

### 5. Sandingkan perangkat kedua

1. Pasang plugin di perangkat itu dengan **Server URL** yang sama; di
   perangkat pertama, jalankan **Pair a new device** untuk mendapat kode yang
   berlaku sepuluh menit.

   ![Dialog Pair a new device di perangkat pertama, kodenya disamarkan, dengan tombol Copy code dan Copy link serta baris Waiting for the new device](../assets/pair-new-device.png)

2. Di perangkat kedua, buka **Pair this device**, tempel kodenya, lalu pilih
   **Pair**.
3. Kembali di perangkat pertama, setujui perangkat itu berdasarkan namanya.
   Sunting sebuah catatan di salah satunya; catatan itu muncul di perangkat
   lain dalam hitungan detik.

   ![Perangkat pertama menanyakan apakah perangkat baru itu disetujui berdasarkan namanya, dengan tombol Approve dan Reject](../assets/pair-approve.png)

![Animasi: kode penyandingan ditampilkan di perangkat pertama, ditempel di perangkat kedua, disetujui di perangkat pertama, dan catatan pertama tiba di perangkat kedua](../assets/pairing.gif)

Mencobanya di satu komputer saja? `http://127.0.0.1:8080` menjangkau server
polos di komputer; Obsidian di iOS dan Android menolak HTTP biasa.

Tangkapan layar dari ponsel belum ada di repositori ini; tangkapan itu diambil
di perangkat milik pengelola sendiri dan ditambahkan ketika sebuah sesi
validasi mencatatnya.

Setiap langkah selengkapnya: [Panduan cepat](../quickstart.md).

## Lanjutan: Cloudflare

Penyiapan acuan tidak punya nama host publik: sebuah Cloudflare Tunnel dan
sebuah rute privat menjangkau jaringan server, dan klien Cloudflare One di
setiap perangkat membawa URL server ke sana. Nama host publik di belakang
Cloudflare Access, dengan token layanan di **Edge service-token headers** dan
`OBSYNC_EDGE=cloudflare`, juga bisa. Keduanya, langkah demi langkah:
[Cloudflare](cloudflare.md).

## Cara lain menjangkau server Anda

Apa pun yang Anda pilih, plugin memerlukan HTTPS dengan sertifikat yang
dipercaya setiap perangkat; server itu sendiri tetap memakai HTTP biasa di
belakang terminator tersebut.

- **Hanya LAN.** Jalur Compose di atas, hanya terjangkau di rumah; tidak ada sinkronisasi saat bepergian.
- **WireGuard.** VPN Anda sendiri yang kembali ke rumah: paling cepat, sepenuhnya milik Anda; ada konfigurasi peer di setiap perangkat.
- **Tailscale.** Mesh WireGuard terkelola: paling sedikit penyiapan; ada pihak ketiga yang mengoordinasikannya, dengan ketentuan paketnya.
- **Reverse proxy dengan TLS otomatis**, misalnya Caddy pada nama publik: bisa dijangkau dari internet, dan Andalah yang harus menambalnya.
- **Cloudflare Tunnel.** Lihat di atas. Tanpa port masuk; ada penyedia di jalur, dengan ketentuannya sendiri.

Apa yang dibutuhkan perangkat yang sedang bepergian (rute, nama, sertifikat,
firewall, permintaan izin jaringan lokal di iOS):
[Menjangkaunya dari luar LAN Anda](../server.md#reaching-it-from-outside-your-lan).

## Pemecahan masalah

| Gejala | Kemungkinan penyebab | Hal pertama yang bisa dicoba |
| --- | --- | --- |
| `obsync: offline` | Perangkat tidak bisa menjangkau URL server | Buka URL itu di peramban pada perangkat yang sama; periksa port, HTTPS, dan rutenya |
| Ponsel tidak mau terhubung padahal komputer menyinkronkan | Ponsel tidak memercayai sertifikat privat itu | Pasang sertifikat akarnya; di iOS, nyalakan juga di bawah "Certificate Trust Settings" |
| `401 stale_timestamp` | Ada jam yang meleset lebih dari 300 detik | Nyalakan waktu otomatis, di perangkat atau di server |
| `403 device_pending` | Belum ada yang menyetujui perangkat itu | Setujui berdasarkan namanya di perangkat tempat Anda menyandingkannya |
| Sebuah berkas tidak pernah tiba | Berkas itu di luar pilihan folder, atau di atas batas ukuran sebuah ponsel | Periksa **Sync folders on this device**; di ponsel jalankan **Show remote-only files** |

Setiap gejala lain dan setiap kode galat, serta cara melaporkannya:
[Pemecahan masalah](../troubleshooting.md).

## Dokumentasi

[Panduan cepat](../quickstart.md) · [Menjalankan server](../server.md) ·
[Cloudflare](cloudflare.md) · [Penggunaan sehari-hari](../daily-use.md) ·
[Pengaturan](../settings.md) · [Pemecahan masalah](../troubleshooting.md) ·
[Pemulihan](../recovery.md) · [Catatan perubahan](../../CHANGELOG.md)

Selebihnya: [docs/README.md](../README.md).

## Pertanyaan, bug, dan keamanan

- **Sebuah pertanyaan, atau Anda tidak yakin apakah itu bug:** [Discussions](https://github.com/snaraj/obsync/discussions).
- **Sebuah bug:** [buka issue](https://github.com/snaraj/obsync/issues/new/choose) dengan laporan seperti yang dijelaskan [Pemecahan masalah](../troubleshooting.md); tanpa token, tanpa frasa pemulihan, tanpa alamat yang tidak ingin Anda publikasikan.
- **Dugaan kerentanan:** secara privat, lewat [`SECURITY.md`](../../SECURITY.md), jangan pernah sebagai issue publik.

## Lisensi

MIT. Lihat [`LICENSE`](../../LICENSE).
