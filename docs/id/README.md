> Terjemahan ini mengikuti [teks asli berbahasa Inggris](../../README.md). Teks bahasa Inggris adalah acuan resminya; perintah, opsi, URL, dan placeholder tidak diubah.

<img src="../../brand/obsync-icon-256.png" alt="ikon obsync: dua cincin yang saling terkait" width="96" height="96">

# Self Hosted Private Sync

Sinkronisasi langsung yang Anda hosting sendiri dan terenkripsi ujung ke
ujung untuk [Obsidian](https://obsidian.md). Catatan Anda disinkronkan lewat
server yang Anda jalankan sendiri. Catatan, lampiran, dan nama berkas
dienkripsi di perangkat Anda, dan server tidak pernah menerima kuncinya.
Plugin ini berjalan di setiap platform tempat Obsidian berjalan, desktop
maupun seluler. Tanpa langganan dan tanpa akun di tempat lain.

**Ada yang tidak berfungsi? → [Pemecahan masalah](https://snaraj.github.io/obsync/troubleshooting/)**

## Temukan yang Anda perlukan

Setiap halaman juga ada di [situs dokumentasi](https://snaraj.github.io/obsync/).
Halaman yang ditautkan berbahasa Inggris.

### Memakai obsync

| Saya ingin… | Buka |
| --- | --- |
| Memilih cara perangkat saya menjangkau server saya | [Pilih penyiapan Anda](../setup.md) |
| Menyiapkan semuanya di jaringan rumah, dengan setiap layar ponsel | [Jaringan yang sama, langkah demi langkah](../same-network.md) |
| Memasang plugin | [Memasang plugin](../community-plugin.md) |
| Menyiapkan perangkat pertama saya | [Panduan cepat](../quickstart.md) |
| Menyandingkan ponsel atau komputer lain | [Sandingkan ponsel Anda](../quickstart.md#pair-your-phone) |
| Mengetahui arti ikon status dan perintah-perintahnya | [Penggunaan sehari-hari](../daily-use.md) dan [Membaca bilah status](../troubleshooting.md#reading-the-status-bar) |
| Mengembalikan versi lama sebuah catatan | [Memulihkan versi yang disimpan](../daily-use.md#restore-a-retained-version) |
| Mengetahui fungsi sebuah pengaturan | [Pengaturan](../settings.md) |
| Menangani salinan konflik | [Konflik](../conflicts.md) |
| Memperbaiki masalah | [Pemecahan masalah](../troubleshooting.md) |
| Masuk kembali setelah kehilangan perangkat | [Pemulihan](../recovery.md) |
| Memindahkan vault saya ke server lain | [Memindahkan vault ini ke server lain](../recovery.md#moving-this-vault-to-a-different-server) |

### Menjalankan server

| Saya ingin… | Buka |
| --- | --- |
| Menjalankan server saya dengan Docker atau Compose | [Menjalankan server](../server.md) |
| Menaruhnya di belakang proksi saya sendiri (Caddy, nginx, Traefik, HAProxy) | [Sudah punya terminator TLS](../server.md#already-have-a-tls-terminator-docker) |
| Menjalankannya tanpa kontainer, di bawah systemd | [Biner statis](../server.md#without-a-container-the-static-binary) |
| Menjalankan server saya di Kubernetes | [Kubernetes](../kubernetes.md) dan [referensi chart](../../chart/README.md) |
| Menjangkau server saya dari luar rumah, lewat VPN atau proksi saya sendiri | [Menjangkaunya dari luar LAN Anda](../server.md#reaching-it-from-outside-your-lan) |
| Memakai Cloudflare (opsional) | [Cloudflare](cloudflare.md) |
| Memercayai sertifikat server saya di setiap perangkat | [Percayai otoritas sertifikat](../server.md#trust-the-certificate-authority-once-per-device) |
| Mengetahui berapa memori dan ruang disk yang dibutuhkannya | [Berapa memori yang dibutuhkan](../server.md#how-much-memory-it-needs) dan [Penyimpanan](../storage.md) |
| Mencadangkan server saya | [Mencadangkan kedua volume](../server.md#back-up-the-two-volumes) |
| Memperbarui server saya | [Memperbarui lewat digest](../server.md#upgrade-by-digest) |
| Melihat perangkat saya dan mencabut salah satunya | [Dasbor](../dashboard.md) |
| Menghapus isi server saya dan mulai lagi | [Mengosongkan server](../purge.md) |
| Melihat apa yang berubah di setiap versi | [`CHANGELOG.md`](../../CHANGELOG.md) |

### Kepercayaan dan privasi

| Saya ingin… | Buka |
| --- | --- |
| Mengetahui apa yang diakses plugin ini di perangkat dan jaringan saya | [Apa yang diakses plugin ini](#apa-yang-diakses-plugin-ini) |
| Memahami apa yang dienkripsi dan apa yang bisa dilihat server | [Model ancaman](../threat-model.md) dan [model ancaman dasbor](../security/dashboard.md) |
| Melaporkan masalah keamanan | [`SECURITY.md`](../../SECURITY.md) |

### Di balik proyek

Untuk kontributor dan peninjau: [`CONTRIBUTING.md`](../../CONTRIBUTING.md),
[arsitektur](../architecture.md), [protokol](../protocol.md),
[benchmark](../benchmarks.md),
[sesi validasi di perangkat](../validation-runs/) dan
[semua halaman](../README.md).

## Pasang

![Pengaturan plugin terbuka dengan Get started: baris Setup guide dan tombol Open the guide miliknya, di atas kolom Server URL](../assets/settings-get-started.png)

Pasang plugin lewat **Pengaturan → Plugin komunitas → Telusuri**. Cari
**Self Hosted Private Sync** (id plugin `obsync-private-sync`). Plugin ini
memerlukan Obsidian 1.13.0 atau yang lebih baru. Pengaturannya terbuka dengan
panduan penyiapan, cukup sekali ketuk.

> [!IMPORTANT]
> - Plugin ini menyinkronkan ke server yang **Anda** jalankan: tidak ada layanan yang dihosting pihak lain, tidak ada akun di tempat lain.
> - Cadangkan vault Anda lebih dahulu; simpan frasa pemulihan 24 kata di luar perangkat yang membuatnya.
> - Jangan pernah menjalankannya berdampingan dengan sinkronisasi lain (Obsidian Sync, folder cloud, plugin lain) pada satu vault.
> - Perangkat lunak yang masih muda: baca entri [`CHANGELOG.md`](../../CHANGELOG.md) untuk versi Anda, perbarui setiap perangkat, dan ketahui apa yang dicakup setiap [sesi validasi](../validation-runs/).

## Mulai menyinkronkan

Jalur lengkap yang paling singkat adalah Compose dengan Caddy di jaringan Anda
sendiri, dari hasil checkout repositori ini. Jalur ini memberi Anda HTTPS di
jaringan mana pun, tanpa domain dan tanpa akun di mana pun.
[Jaringan yang sama, langkah demi langkah](../same-network.md) memandu Anda
melewatinya dengan setiap layar. Ganti `vX.Y.Z` di bawah dengan rilis yang
sedang Anda pasang, yaitu tag terbaru di
[halaman Releases](https://github.com/snaraj/obsync/releases/latest).

**1. Verifikasi image-nya.** Lalu jalankan persis digest yang dicetaknya:

```sh
cosign verify ghcr.io/snaraj/obsync:vX.Y.Z \
  --certificate-identity https://github.com/snaraj/obsync/.github/workflows/release-publisher.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

**2. Jalankan server:**

```sh
OBSYNC_IMAGE=ghcr.io/snaraj/obsync@sha256:<digest> \
  OBSYNC_HOST=sync.example.org \
  OBSYNC_BIND_ADDRESS=192.168.1.10 \
  docker compose -f deploy/compose/docker-compose.yml up -d
```

`OBSYNC_HOST` adalah nama yang akan diketik perangkat Anda. Nama itu cukup
bisa diselesaikan di jaringan Anda sendiri. `OBSYNC_BIND_ADDRESS` adalah
alamat tempat port 80 dan 443 dipublikasikan: alamat bind membatasi antarmuka
tujuan, bukan sumbernya, jadi firewall Andalah yang menentukan siapa yang bisa
menjangkaunya. Compose menolak berjalan sebelum Anda memilih.

**3. Baca token penyiapan.** Saat pertama kali dijalankan, server membuat
token penyiapan dan menuliskannya ke volume jurnalnya, mode 0600, tidak
pernah masuk log. Token itu membuat akun Anda satu kali dan tetap menjadi
cara masuk pemulihan bagi dasbor. Jagalah seperti frasa pemulihan:

```sh
docker cp obsync-obsync-1:/data/journal/v1/setup-token - | tar -xO
```

**4. Siapkan setiap perangkat.** Percayai sertifikat server satu kali
([caranya](../server.md#trust-the-certificate-authority-once-per-device)).
Pasang plugin, lalu ikuti [Panduan cepat](../quickstart.md): siapkan
perangkat pertama, lalu sandingkan perangkat lainnya.

Sudah punya HTTPS di depan, dari proksi atau tunnel yang Anda percayai?
Jalankan [server polos](../server.md#already-have-a-tls-terminator-docker)
sebagai gantinya.

## Apa yang diakses plugin ini

- **Server Anda sendiri, tidak ada yang lain.** Setiap permintaan menuju **Server URL** yang Anda ketik; tanpa telemetri, tanpa pihak ketiga.
- **Sebuah akun di server itu**, dibuat dari token penyiapan; akun Obsidian Anda tidak berperan sama sekali.
- **GitHub Releases, lewat Obsidian**, untuk pemasangan dan pembaruan; Obsidian mengabaikan aset rilis tambahannya.
- **Daftar berkas vault Anda**, untuk memutuskan apa yang disinkronkan; folder tersembunyi (`.obsidian`, `.git`) dan folder tautan simbolik dilewati.
- **Papan klip, hanya untuk ditulisi**, oleh **Copy code** dan **Copy link** di **Pair a new device**; tidak pernah dibaca.
- **Peramban Anda, saat Anda meminta panduan penyiapan.** Panduan proyek dibuka di sana; plugin itu sendiri tidak mengirim apa pun.

Apa yang bisa dan tidak bisa dilihat server: [`SECURITY.md`](../../SECURITY.md) dan [model ancaman](../threat-model.md).

## Versi

Rilis LATEST adalah tag terbaru di
[halaman Releases](https://github.com/snaraj/obsync/releases/latest). Itulah
yang dipasang Obsidian dan yang menjadi tujuan pembaruannya. `main` adalah
EDGE: pekerjaan yang sudah digabungkan tetapi belum dirilis, untuk orang yang
membangun dari kode sumber. Tidak ada kanal beta dan tidak ada tag
prarilis. Bagian "Unreleased" di catatan perubahan mencatat isi EDGE.

## Pertanyaan, bug, dan keamanan

- **Sebuah pertanyaan, atau Anda tidak yakin apakah itu bug:** [Discussions](https://github.com/snaraj/obsync/discussions).
- **Sebuah bug:** [buka issue](https://github.com/snaraj/obsync/issues/new/choose) dengan laporan seperti yang dijelaskan [Pemecahan masalah](../troubleshooting.md#how-to-collect-a-report). Jangan sertakan token, frasa, atau alamat apa pun yang tidak ingin Anda publikasikan.
- **Dugaan kerentanan:** secara privat, lewat [`SECURITY.md`](../../SECURITY.md), jangan pernah sebagai issue publik.

## Lisensi

MIT. Lihat [`LICENSE`](../../LICENSE).
