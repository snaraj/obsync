> Terjemahan ini mengikuti [teks asli berbahasa Inggris](../cloudflare.md). Teks bahasa Inggris adalah acuan resminya; perintah, opsi, URL, dan placeholder tidak diubah.

# Cloudflare

Dua cara menempatkan Cloudflare di antara perangkat Anda dan server Anda,
serta cara mana yang dipakai oleh penyiapan acuan. Keduanya tidak wajib:
server tidak mengenal penyedia mana pun berdasarkan nama, dan
[Menjalankan server](../server.md) tidak memerlukan akun di mana pun.
Halaman ini untuk Anda jika ingin menjangkau server dari luar rumah tanpa
membuka port di router, atau jika ingin nama host yang dipublikasikan dengan
kebijakan akses di depannya.

Menu Cloudflare dan ketentuan paketnya berubah. Setiap langkah di bawah
menyebutkan jalur menu sebagaimana diberikan dokumentasi Cloudflare pada
2026-09-22; periksa halaman terbaru sebelum mengandalkan suatu batasan atau
harga.

## Pilih yang mana

| Pilihan | Yang dilihat perangkat | Yang dilihat internet | Sinkronisasi pertama yang besar |
| --- | --- | --- | --- |
| **Rute privat** (penyiapan acuan) | alamat privat dan nama Anda sendiri, lewat klien Cloudflare One | tidak ada: tanpa nama host, tanpa port terbuka | lalu lintas jaringan privat, tidak diproksi lewat nama host publik |
| **Nama host publik dengan Access** | nama publik, kebijakan Access, token layanan di plugin | nama host, di belakang Access | diproksi lewat Cloudflare, dengan ketentuan penyedia untuk berkas besar |

Rute privat menjadi acuan karena server tetap tak terlihat dan karena
dokumentasi Cloudflare sendiri mengarahkan transfer besar ke sana: rute nama
host publik memproksi lalu lintas lewat Cloudflare, dan pada paket Free, Pro,
dan Business ketentuan khusus layanan mewajibkan layanan berbayar untuk video
dan berkas besar lainnya, sedangkan rute jaringan privat membawanya sebagai
lalu lintas Anda sendiri. Lakukan sinkronisasi pertama yang besar di LAN pada
kedua pilihan.

Apa pun yang mengakhiri TLS membaca kredensial Anda, bukan catatan Anda:
setiap potongan dan setiap manifes dienkripsi di perangkat, dan tidak ada
kunci yang bisa mendekripsinya melintasi jaringan
([model ancaman](../threat-model.md)). Pada rute privat, terminatornya milik
Anda, di dalam jaringan Anda. Pada nama host publik, edge juga merupakan
terminator.

## Pilihan A: rute privat dan klien Cloudflare One

Server tetap memakai alamat privat di jaringan Anda sendiri. Sebuah konektor
tunnel berjalan di sampingnya, sebuah rute memberi tahu Cloudflare alamat mana
yang berada di balik tunnel itu, dan klien Cloudflare One (dulu WARP) di
setiap perangkat membawa lalu lintas ke alamat tersebut melalui tunnel. URL
server yang diketik perangkat Anda adalah nama privat yang diselesaikan ke
alamat privat itu.

Yang Anda perlukan: akun Cloudflare dengan organisasi Zero Trust ("nama
tim"), sebuah mesin di jaringan server yang bisa menjalankan konektor tunnel,
dan klien Cloudflare One di setiap perangkat yang akan menyinkronkan dari luar
rumah.

1. **Buat tunnel.** Di dasbor Cloudflare, buka **Networking** > **Tunnels**
   dan buat tunnel `cloudflared`. Jalankan konektor yang diberikan pada mesin
   di dalam jaringan server: di klaster di samping server, atau di host yang
   sama.
2. **Rutekan alamat privat server lewat tunnel.** Buka **Networking** >
   **Routes**, pilih **Create route** > **Tunnel CIDR**, pilih tunnelnya,
   lalu masukkan alamat privat atau subnet server. Satu alamat sudah cukup;
   subnet bisa diperluas nanti.
3. **Daftarkan setiap perangkat.** Pasang klien Cloudflare One, masukkan nama
   tim Anda, selesaikan proses masuk yang diminta organisasi Anda, lalu
   nyalakan koneksinya. Di iOS dan Android klien meminta memasang profil VPN;
   setujui. Atur izin pendaftaran perangkat agar hanya identitas Anda sendiri
   yang bisa mendaftarkan perangkat.
4. **Kirim rentang privat lewat klien.** Di konfigurasi Split Tunnels klien,
   pastikan alamat dari langkah 2 dirutekan lewat klien. Pada mode
   **Exclude**, hapus blok RFC 1918 yang memuatnya dan tambahkan kembali
   rentang yang masih ingin Anda kecualikan; pada mode **Include**, tambahkan
   alamat atau subnetnya.
5. **Pastikan nama diselesaikan di perangkat.** Plugin mengirim setiap
   permintaan ke URL server yang Anda ketik, jadi nama itu harus bisa
   diselesaikan di perangkat yang sedang bepergian: rute nama host, Local
   Domain Fallback ke resolver Anda sendiri, atau entri DNS privat. Nama yang
   diselesaikan ke alamat yang tidak dirutekan klien akan gagal persis
   seperti server yang mati.
6. **Akhiri TLS sendiri.** Rute membawa lalu lintas Anda ke terminator Anda
   sendiri: ingress atau reverse proxy di depan server dengan sertifikat
   yang dipercaya setiap perangkat, seperti pada
   [Menjalankan server](../server.md). Server berjalan dengan
   `OBSYNC_EDGE=none` dan hanya memercayai alamat terusan dari
   `OBSYNC_TRUSTED_PROXY_CIDRS`, yaitu rentang terminator itu sendiri.
7. **Jika mau, saring dengan Gateway.** Kebijakan jaringan Gateway bisa
   mengizinkan hanya perangkat terdaftar Anda mencapai alamat dan port
   server, dan memblokir yang lain di rute itu.
8. **Verifikasi dari perangkat di luar jaringan Anda.** Buka URL server di
   peramban perangkat itu dan harapkan halaman masuk dasbor. Di plugin, pilih
   **Check** di bawah **Connection**: satu perjalanan bolak-balik membuktikan
   alamat, sertifikat, dan kredensial sekaligus.

Pertimbangan:

- Setiap perangkat yang menyinkronkan menjalankan klien Cloudflare One, dan
  klien harus tersambung sebelum sinkronisasi dari luar rumah berfungsi.
- Cloudflare membawa lalu lintas antara perangkat dan konektor tunnel.
  Biarkan dekripsi TLS Gateway mati; lalu lintas pun tidak terbaca olehnya
  selain alamat, ukuran, dan waktu, yang memang sudah diakui
  [model ancaman](../threat-model.md) untuk jalur jaringan mana pun.
- Konektor adalah proses di jaringan Anda yang menjaga koneksi keluar ke
  Cloudflare tetap terbuka. Saat konektor mati, perangkat yang bepergian
  menampilkan `obsync: offline`, sementara LAN tetap berjalan.

## Pilihan B: nama host publik di belakang Access

Server mendapat nama host pada domain yang Anda miliki di Cloudflare. Tunnel
mempublikasikan nama host itu ke alamat privat server, dan Cloudflare Access
berada di depannya: kebijakan identitas untuk dasbor, dan token layanan untuk
panggilan API plugin. Inilah pilihan yang dijelaskan
[penyambungan platform](../platform-onboarding.md) untuk klaster acuan, dan
yang tidak diambil oleh penyiapan acuan.

1. **Publikasikan nama host.** Di konfigurasi tunnel, tambahkan rute aplikasi
   terpublikasi dari nama host Anda (`sync.example.com` mewakili milik Anda)
   ke alamat HTTP privat server, port 8080. Cloudflare membuat catatan
   DNS-nya.
2. **Pasang Access di depan.** Buka **Zero Trust** > **Access controls** >
   **Applications**, buat aplikasi **Self-hosted** pada nama host itu, dan
   tambahkan kebijakan identitas yang hanya mengizinkan Anda, misalnya PIN
   sekali pakai ke alamat Anda sendiri, untuk dasbor.
3. **Buat token layanan untuk plugin.** Buka **Zero Trust** > **Access
   controls** > **Service credentials** > **Service Tokens**, buat satu, lalu
   salin Client ID dan Client Secret; secret hanya ditampilkan sekali.
   Tambahkan kebijakan **Service Auth** ke aplikasi yang memuat token ini,
   untuk jalur yang dipakai plugin (`/v1/*`).
4. **Tempel token ke plugin.** Di bawah **Edge service-token headers**, satu
   per baris, persis seperti penamaan Cloudflare:

   ```text
   CF-Access-Client-Id: <the client id>
   CF-Access-Client-Secret: <the client secret>
   ```

   Keduanya ikut pada setiap permintaan ke URL server, dan tidak ke tempat
   lain.
5. **Beri tahu server bahwa ia berada di belakang edge.** Jalankan dengan
   `OBSYNC_EDGE=cloudflare`. Pada mode itu setiap permintaan harus membawa
   header edge berisi alamat penghubung dan ID permintaan, dan permintaan
   yang datang melewati edge ditolak dengan `421 edge_required`
   ([pemecahan masalah](../troubleshooting.md#edge_required)).
6. **Verifikasi.** Buka nama host di peramban dan harapkan halaman masuk
   Access, lalu dasbor. Di plugin, pilih **Check** di bawah **Connection**.

Pertimbangan:

- Nama host bersifat publik. Access menolak orang asing, dan server tetap
  mengautentikasi sendiri setiap permintaan perangkat, tetapi namanya ada dan
  bisa ditemukan.
- Token layanan adalah kredensial. Siapa pun yang memegangnya bisa mencapai
  pintu depan API; autentikasi perangkat milik server tetap berdiri di
  belakangnya. Rotasikan di Cloudflare jika suatu saat bocor.
- Transfer besar diproksi lewat Cloudflare dengan ketentuan di atas. Lakukan
  sinkronisasi pertama yang besar di LAN.
- Header edge berisi alamat penghubung dan negara adalah yang ditampilkan
  halaman Perangkat di dasbor sebagai alamat dan negara pada mode ini.

## Yang sudah dibuktikan

Rute privat adalah rute penyiapan acuan.
[Sesi 2026-09-14](../validation-runs/2026-09-14.md) mencatat bahwa hari itu
rute tersebut tidak diuji, dan alasannya;
[sesi 2026-09-20](../validation-runs/2026-09-20.md) mencatat sesi perangkat
pada rute acuan dengan pemeriksaan konektivitas dan TLS yang lolos. Pilihan
nama host publik belum pernah diuji dalam sesi mana pun yang tercatat.

## Selanjutnya

- [Menjalankan server](../server.md): terminator, volume, token penyiapan.
- [Kubernetes](https://github.com/snaraj/obsync/blob/main/chart/README.md): chart yang dipakai penyiapan acuan.
- [Penyambungan platform](../platform-onboarding.md): apa yang akan
  ditambahkan klaster acuan untuk nama host yang dipublikasikan.
- [Pemecahan masalah](../troubleshooting.md): `edge_required`, `offline`,
  dan sertifikat.
