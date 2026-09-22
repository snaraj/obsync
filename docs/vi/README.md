> Bản dịch này bám theo [bản gốc tiếng Anh](../../README.md). Văn bản tiếng Anh là bản chuẩn; các lệnh, tùy chọn, URL và chỗ giữ chỗ được giữ nguyên.

# Self Hosted Private Sync

Đồng bộ trực tiếp, tự lưu trữ, mã hóa đầu cuối cho
[Obsidian](https://obsidian.md): một máy chủ Rust không phụ thuộc gì, có sẵn
bảng điều khiển, do chính bạn vận hành, cùng với plugin này. Tệp mọi kích cỡ,
mọi nền tảng Obsidian, không thuê bao, không bên thứ ba.

Hãy cài nó từ Cài đặt → Phần mở rộng của bên thứ ba → Duyệt, với tên
**Self Hosted Private Sync** (id plugin `obsync-private-sync`), trên Obsidian
1.13.0 trở lên.

> [!IMPORTANT]
> - Nó đồng bộ tới một máy chủ do **bạn** vận hành: không có dịch vụ lưu trữ
>   sẵn, không có tài khoản ở nơi nào khác.
> - Hãy sao lưu kho của bạn trước; giữ cụm từ khôi phục 24 từ ở ngoài thiết bị
>   đã tạo ra nó.
> - Đừng bao giờ chạy nó bên cạnh một giải pháp đồng bộ khác (Obsidian Sync,
>   một thư mục đám mây, một plugin khác) trên cùng một kho.
> - Phần mềm còn non trẻ: hãy đọc mục [`CHANGELOG.md`](../../CHANGELOG.md)
>   dành cho phiên bản của bạn, cập nhật mọi thiết bị, và biết rõ mỗi
>   [đợt chạy kiểm chứng](../validation-runs/) đã bao phủ những gì.

## Plugin này truy cập những gì

- **Máy chủ của bạn, không gì khác.** Mọi yêu cầu đều đi tới **Server URL** mà
  bạn nhập; không đo đạc từ xa, không bên thứ ba.
- **Một tài khoản trên máy chủ đó**, được tạo từ token thiết lập; tài khoản
  Obsidian của bạn không đóng vai trò gì.
- **GitHub Releases, thông qua Obsidian**, để cài và cập nhật; Obsidian bỏ qua
  các tệp phát hành phụ thêm.
- **Danh sách tệp trong kho của bạn**, để quyết định đồng bộ những gì; thư mục
  ẩn (`.obsidian`, `.git`) và thư mục là liên kết tượng trưng được bỏ qua.
- **Clipboard, chỉ được ghi vào** bởi **Copy code** và **Copy link** trong
  **Pair a new device**, không bao giờ bị đọc.

Máy chủ có thể thấy gì và không thể thấy gì: [`SECURITY.md`](../../SECURITY.md)
và [mô hình mối đe dọa](../threat-model.md).

## Bắt đầu đồng bộ

Năm bước từ chỗ chưa có gì tới hai thiết bị đồng bộ với nhau. `v1.0.6` là bản
phát hành mà trang này được viết dựa theo; hãy dùng tag của bản bạn đang cài.

### 1. Khởi động máy chủ

Hãy xác minh chữ ký, rồi chạy đúng cái digest mà nó đã in ra:

```sh
cosign verify ghcr.io/snaraj/obsync:v1.0.6 \
  --certificate-identity https://github.com/snaraj/obsync/.github/workflows/release-publisher.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Con đường đơn giản là Compose cùng Caddy, từ một bản lấy về của kho mã này:
HTTPS trên mạng nào cũng được, không cần tên miền, không cần tài khoản ở đâu
cả.

```sh
OBSYNC_IMAGE=ghcr.io/snaraj/obsync@sha256:<digest> \
  OBSYNC_HOST=sync.example.org \
  OBSYNC_BIND_ADDRESS=192.168.1.10 \
  docker compose -f deploy/compose/docker-compose.yml up -d
```

`OBSYNC_HOST` là cái tên mà thiết bị của bạn sẽ gõ vào; nó chỉ cần phân giải
được trong mạng của chính bạn. `OBSYNC_BIND_ADDRESS` là địa chỉ mà cổng 80 và
443 được công bố trên đó: một địa chỉ bind giới hạn giao diện đích, chứ không
giới hạn nguồn, nên tường lửa của bạn mới là thứ quyết định ai tới được.
Compose từ chối khởi động cho tới khi bạn đã chọn.

Đã có sẵn HTTPS đứng trước, từ một proxy hay một tunnel bạn tin cậy? Hãy chạy
máy chủ trần thay vào đó: [Chạy máy chủ](../server.md).

### 2. Đọc token thiết lập

Ở lần khởi động đầu, máy chủ đúc ra một token thiết lập và ghi nó vào ổ nhật ký
của mình, chế độ 0600, không bao giờ bị ghi ra log. Nó tạo tài khoản của bạn
một lần và vẫn là cách đăng nhập khôi phục của bảng điều khiển: hãy giữ nó cẩn
thận đúng như giữ cụm từ khôi phục. Hãy đọc nó từ container:

```sh
docker cp obsync-obsync-1:/data/journal/v1/setup-token - | tar -xO
```

### 3. Tin cậy chứng chỉ, một lần cho mỗi thiết bị

Caddy ký bằng một tổ chức chứng thực mà chính nó tạo ra ở lần khởi động đầu;
mỗi thiết bị phải tin cậy tổ chức đó một lần. Hãy xuất chứng chỉ gốc và cài nó
trên từng nền tảng như
[Chạy máy chủ](../server.md#trust-the-certificate-authority-once-per-device)
chỉ dẫn; trên iOS, việc tin cậy nó là một công tắc thứ hai sau khi cài.

### 4. Thiết lập thiết bị đầu tiên

1. Cài đặt → Phần mở rộng của bên thứ ba → Duyệt → **Self Hosted Private
   Sync** → Cài đặt → Kích hoạt.
2. Đặt **Server URL** thành máy chủ của bạn (`https://sync.example.org`, kèm
   cổng trừ khi là 443), rồi chọn **Whole vault** hoặc
   **Selected folders only**; về sau nó chỉ có thể thu hẹp lại.

   ![Thẻ cài đặt của plugin: ô Server URL chứa một tên máy mẫu, ô nhập các tiêu đề biên, và hàng Connection với các nút Check và Open dashboard của nó](../assets/settings-server.png)

3. Dán token thiết lập dưới **First-time setup**, chọn **Set up**, rồi chép
   lại cụm từ khôi phục 24 từ.

   ![Mục This device của thẻ cài đặt: hàng Pairing với Pair this device và Pair a new device, hàng First-time setup với ô Setup token và nút Set up, cùng hàng Vault key](../assets/settings-setup.png)

### 5. Ghép nối thiết bị thứ hai

1. Hãy cài plugin ở đó với cùng một **Server URL**; trên thiết bị thứ nhất,
   chạy **Pair a new device** để lấy một mã có hiệu lực trong mười phút.

   ![Hộp thoại Pair a new device trên thiết bị thứ nhất, mã của nó đã được che, với các nút Copy code và Copy link và dòng Waiting for the new device](../assets/pair-new-device.png)

2. Trên thiết bị thứ hai, mở **Pair this device**, dán mã vào, rồi chọn
   **Pair**.
3. Quay lại thiết bị thứ nhất, hãy phê duyệt nó theo tên. Sửa một ghi chú trên
   thiết bị nào cũng được; nó xuất hiện trên thiết bị kia trong vài giây.

   ![Thiết bị thứ nhất hỏi có phê duyệt thiết bị mới theo tên hay không, với các nút Approve và Reject](../assets/pair-approve.png)

![Ảnh động: mã ghép nối hiện trên thiết bị thứ nhất, được dán vào thiết bị thứ hai, được phê duyệt trên thiết bị thứ nhất, và ghi chú đầu tiên tới nơi trên thiết bị thứ hai](../assets/pairing.gif)

Thử trên một máy tính thôi? `http://127.0.0.1:8080` tới được máy chủ trần trên
máy tính để bàn; Obsidian trên iOS và Android từ chối HTTP thuần.

Ảnh chụp màn hình từ điện thoại chưa có trong kho mã này; chúng được chụp trên
chính các thiết bị của người bảo trì và được bổ sung khi một đợt chạy kiểm
chứng ghi lại chúng.

Từng bước đầy đủ: [Khởi động nhanh](../quickstart.md).

## Nâng cao: Cloudflare

Bản triển khai tham chiếu không có tên máy chủ công khai: một Cloudflare Tunnel
và một tuyến riêng tới được mạng của máy chủ, và ứng dụng Cloudflare One trên
mỗi thiết bị đưa Server URL tới đó. Một tên máy chủ công khai đứng sau
Cloudflare Access, với một token dịch vụ trong **Edge service-token headers**
và `OBSYNC_EDGE=cloudflare`, cũng hoạt động. Cả hai, từng bước một:
[Cloudflare](cloudflare.md).

## Những cách khác để tới máy chủ của bạn

Dù bạn chọn cách nào, plugin cũng cần HTTPS với một chứng chỉ mà mọi thiết bị
đều tin cậy; còn máy chủ vẫn ở HTTP thuần phía sau điểm kết thúc đó.

- **Chỉ LAN.** Đường Compose ở trên, chỉ tới được khi ở nhà; không đồng bộ khi
  xa nhà.
- **WireGuard.** VPN của chính bạn quay về nhà: nhanh nhất, hoàn toàn thuộc về
  bạn; một cấu hình peer trên mọi thiết bị.
- **Tailscale.** Một lưới WireGuard được quản lý: ít phải thiết lập nhất; một
  bên thứ ba điều phối nó, theo điều khoản gói dịch vụ của họ.
- **Một reverse proxy có TLS tự động**, chẳng hạn Caddy trên một tên công
  khai: tới được từ internet, và bạn phải tự vá nó.
- **Cloudflare Tunnel.** Xem ở trên. Không có cổng vào; một nhà cung cấp nằm
  trên đường đi, theo điều khoản của họ.

Một thiết bị đang đi xa cần những gì (tuyến, tên, chứng chỉ, tường lửa, lời
nhắc mạng cục bộ của iOS):
[Tới nó từ bên ngoài LAN của bạn](../server.md#reaching-it-from-outside-your-lan).

## Khắc phục sự cố

| Triệu chứng | Nguyên nhân có thể | Việc nên thử trước tiên |
| --- | --- | --- |
| `obsync: offline` | Thiết bị không tới được Server URL | Mở URL đó trong trình duyệt trên chính thiết bị ấy; kiểm tra cổng, HTTPS và tuyến |
| Một điện thoại không chịu kết nối trong khi máy tính vẫn đồng bộ | Chứng chỉ riêng không được tin cậy trên điện thoại | Cài chứng chỉ gốc; trên iOS còn phải bật nó trong "Certificate Trust Settings" |
| `401 stale_timestamp` | Một chiếc đồng hồ lệch quá 300 giây | Bật giờ tự động, trên thiết bị hoặc trên máy chủ |
| `403 device_pending` | Chưa ai phê duyệt thiết bị đó | Hãy phê duyệt nó theo tên trên chính thiết bị mà bạn đã ghép nối từ đó |
| Một tệp không bao giờ tới nơi | Nó nằm ngoài phần thư mục đã chọn, hoặc vượt trần kích thước của điện thoại | Kiểm tra **Sync folders on this device**; trên điện thoại hãy chạy **Show remote-only files** |

Mọi triệu chứng khác, mọi mã lỗi, và cách báo cáo một lỗi:
[Khắc phục sự cố](../troubleshooting.md).

## Tài liệu

[Khởi động nhanh](../quickstart.md) · [Chạy máy chủ](../server.md) ·
[Cloudflare](cloudflare.md) · [Dùng hằng ngày](../daily-use.md) ·
[Cài đặt](../settings.md) · [Khắc phục sự cố](../troubleshooting.md) ·
[Khôi phục](../recovery.md) · [Nhật ký thay đổi](../../CHANGELOG.md)

Mọi thứ còn lại: [docs/README.md](../README.md).

## Câu hỏi, lỗi và bảo mật

- **Một câu hỏi, hoặc bạn không chắc đó có phải lỗi hay không:**
  [Discussions](https://github.com/snaraj/obsync/discussions).
- **Một lỗi:** [hãy mở một issue](https://github.com/snaraj/obsync/issues/new/choose)
  kèm bản báo cáo mà [Khắc phục sự cố](../troubleshooting.md) mô tả; đừng kèm
  token, đừng kèm cụm từ khôi phục, đừng kèm địa chỉ nào mà bạn không muốn
  công bố.
- **Một lỗ hổng bị nghi ngờ:** hãy báo riêng, qua
  [`SECURITY.md`](../../SECURITY.md), không bao giờ qua một issue công khai.

## Giấy phép

MIT. Xem [`LICENSE`](../../LICENSE).
