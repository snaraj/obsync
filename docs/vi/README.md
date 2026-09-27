> Bản dịch này bám theo [bản gốc tiếng Anh](../../README.md). Văn bản tiếng Anh là bản chuẩn; các lệnh, tùy chọn, URL và chỗ giữ chỗ được giữ nguyên.

<img src="../../brand/obsync-icon-256.png" alt="biểu tượng obsync: hai vòng lồng vào nhau" width="96" height="96">

# Self Hosted Private Sync

Đồng bộ trực tiếp, tự lưu trữ, mã hóa đầu cuối cho
[Obsidian](https://obsidian.md). Ghi chú của bạn đồng bộ qua một máy chủ do
chính bạn vận hành. Ghi chú, tệp đính kèm và tên tệp được mã hóa trên thiết
bị của bạn, và máy chủ không bao giờ nhận được khóa. Plugin chạy trên mọi nền
tảng mà Obsidian chạy, cả máy tính lẫn điện thoại. Không thuê bao, không tài
khoản ở nơi nào khác.

**Có gì đó không chạy? → [Khắc phục sự cố](https://snaraj.github.io/obsync/troubleshooting/) (bằng tiếng Anh)**

## Tìm thứ bạn cần

Mọi trang cũng có trên [trang tài liệu](https://snaraj.github.io/obsync/) (bằng tiếng Anh).

### Dùng obsync

| Tôi muốn… | Xem tại |
| --- | --- |
| Chọn cách các thiết bị của tôi kết nối tới máy chủ | [Chọn cách thiết lập](../setup.md) |
| Thiết lập mọi thứ trong mạng nhà, với từng màn hình điện thoại | [Cùng một mạng, từng bước](../same-network.md) |
| Cài plugin | [Cài plugin](../community-plugin.md) |
| Thiết lập thiết bị đầu tiên | [Bắt đầu nhanh](../quickstart.md) |
| Ghép nối điện thoại hoặc một máy tính khác | [Ghép nối điện thoại](../quickstart.md#pair-your-phone) |
| Hiểu biểu tượng trạng thái và các lệnh nghĩa là gì | [Sử dụng hằng ngày](../daily-use.md) và [Đọc thanh trạng thái](../troubleshooting.md#reading-the-status-bar) |
| Lấy lại một phiên bản cũ của ghi chú | [Khôi phục một phiên bản được giữ lại](../daily-use.md#restore-a-retained-version) |
| Biết một cài đặt làm gì | [Cài đặt](../settings.md) |
| Xử lý một bản sao xung đột | [Xung đột](../conflicts.md) |
| Khắc phục một sự cố | [Khắc phục sự cố](../troubleshooting.md) |
| Vào lại sau khi mất một thiết bị | [Khôi phục](../recovery.md) |
| Chuyển khối lưu trữ sang máy chủ khác | [Chuyển khối lưu trữ này sang máy chủ khác](../recovery.md#moving-this-vault-to-a-different-server) |

### Chạy máy chủ

| Tôi muốn… | Xem tại |
| --- | --- |
| Chạy máy chủ bằng Docker hoặc Compose | [Chạy máy chủ](../server.md) |
| Đặt nó sau proxy của riêng tôi (Caddy, nginx, Traefik, HAProxy) | [Đã có điểm kết thúc TLS](../server.md#already-have-a-tls-terminator-docker) |
| Chạy nó không cần container, dưới systemd | [Tệp nhị phân tĩnh](../server.md#without-a-container-the-static-binary) |
| Chạy máy chủ trên Kubernetes | [Kubernetes](../kubernetes.md) và [tài liệu tham khảo chart](../../chart/README.md) |
| Truy cập máy chủ khi xa nhà, qua VPN hoặc proxy của riêng tôi | [Truy cập từ ngoài mạng LAN](../server.md#reaching-it-from-outside-your-lan) |
| Dùng Cloudflare (tùy chọn) | [Cloudflare](cloudflare.md) |
| Tin cậy chứng chỉ của máy chủ trên từng thiết bị | [Tin cậy tổ chức cấp chứng chỉ](../server.md#trust-the-certificate-authority-once-per-device) |
| Biết cần bao nhiêu bộ nhớ và dung lượng đĩa | [Cần bao nhiêu bộ nhớ](../server.md#how-much-memory-it-needs) và [Lưu trữ](../storage.md) |
| Sao lưu máy chủ | [Sao lưu hai volume](../server.md#back-up-the-two-volumes) |
| Nâng cấp máy chủ | [Nâng cấp theo digest](../server.md#upgrade-by-digest) |
| Xem các thiết bị của tôi và thu hồi một thiết bị | [Bảng điều khiển](../dashboard.md) |
| Xóa sạch máy chủ và bắt đầu lại | [Xóa sạch một máy chủ](../purge.md) |
| Xem mỗi phiên bản đã thay đổi gì | [`CHANGELOG.md`](../../CHANGELOG.md) |

### Tin cậy và quyền riêng tư

| Tôi muốn… | Xem tại |
| --- | --- |
| Biết plugin này đụng tới những gì trên thiết bị và mạng của tôi | [Plugin này truy cập những gì](#plugin-này-truy-cập-những-gì) |
| Hiểu thứ gì được mã hóa và máy chủ có thể thấy gì | [Mô hình mối đe dọa](../threat-model.md) và [mô hình mối đe dọa của bảng điều khiển](../security/dashboard.md) |
| Báo cáo một vấn đề bảo mật | [`SECURITY.md`](../../SECURITY.md) |

### Bên trong dự án

Dành cho người đóng góp và người review: [`CONTRIBUTING.md`](../../CONTRIBUTING.md),
[kiến trúc](../architecture.md), [giao thức](../protocol.md),
[đo hiệu năng](../benchmarks.md), [các đợt kiểm chứng trên thiết bị](../validation-runs/)
và [tất cả các trang](../README.md).

## Cài đặt plugin

![Phần cài đặt của plugin mở ra với Get started: dòng Setup guide và nút Open the guide của nó, phía trên ô Server URL](../assets/settings-get-started.png)

Cài plugin từ **Cài đặt → Phần mở rộng của bên thứ ba → Duyệt**. Tìm
**Self Hosted Private Sync** (id plugin `obsync-private-sync`). Plugin cần
Obsidian 1.13.0 trở lên. Phần cài đặt của plugin mở ra với hướng dẫn thiết
lập, chỉ cách một lần nhấn.

> [!IMPORTANT]
> - Nó đồng bộ tới một máy chủ do **bạn** vận hành: không có dịch vụ lưu trữ sẵn, không có tài khoản ở nơi nào khác.
> - Hãy sao lưu khối lưu trữ của bạn trước; giữ cụm từ khôi phục 24 từ ở ngoài thiết bị đã tạo ra nó.
> - Đừng bao giờ chạy nó bên cạnh một giải pháp đồng bộ khác (Obsidian Sync, một thư mục đám mây, một plugin khác) trên cùng một khối lưu trữ.
> - Phần mềm còn non trẻ: hãy đọc mục [`CHANGELOG.md`](../../CHANGELOG.md) dành cho phiên bản của bạn, cập nhật mọi thiết bị, và biết rõ mỗi [đợt kiểm chứng](../validation-runs/) đã bao phủ những gì.

## Bắt đầu đồng bộ

Con đường ngắn nhất mà vẫn đầy đủ là Compose với Caddy trong mạng của chính
bạn, từ một bản checkout của kho mã này. Nó cho bạn HTTPS trên mọi mạng, không
cần tên miền và không cần tài khoản ở đâu cả.
[Cùng một mạng, từng bước](../same-network.md) đi qua con đường này với từng
màn hình. Thay `vX.Y.Z` bên dưới bằng bản phát hành bạn đang cài, tức là thẻ
mới nhất trên [trang Releases](https://github.com/snaraj/obsync/releases/latest).

**1. Xác minh image.** Sau đó chạy đúng digest mà bước xác minh đã in ra:

```sh
cosign verify ghcr.io/snaraj/obsync:vX.Y.Z \
  --certificate-identity https://github.com/snaraj/obsync/.github/workflows/release-publisher.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

**2. Khởi động máy chủ:**

```sh
OBSYNC_IMAGE=ghcr.io/snaraj/obsync@sha256:<digest> \
  OBSYNC_HOST=sync.example.org \
  OBSYNC_BIND_ADDRESS=192.168.1.10 \
  docker compose -f deploy/compose/docker-compose.yml up -d
```

`OBSYNC_HOST` là tên mà các thiết bị của bạn sẽ nhập. Tên này chỉ cần phân
giải được trong mạng của chính bạn. `OBSYNC_BIND_ADDRESS` là địa chỉ mà cổng
80 và 443 được mở trên đó: một địa chỉ bind giới hạn giao diện đích, không
giới hạn nguồn, nên tường lửa của bạn mới là thứ quyết định ai tới được nó.
Compose từ chối khởi động cho tới khi bạn chọn.

**3. Đọc token thiết lập.** Ở lần khởi động đầu tiên, máy chủ tạo một token
thiết lập và ghi nó vào volume journal của mình, với chế độ 0600, không bao
giờ ghi vào log. Token này tạo tài khoản của bạn một lần và vẫn là cách đăng
nhập khôi phục của bảng điều khiển. Hãy giữ nó cẩn thận như cụm từ khôi phục:

```sh
docker exec obsync-obsync-1 obsyncd setup-token
```

```sh
docker cp obsync-obsync-1:/data/journal/v1/setup-token - | tar -xO
```

**4. Thiết lập từng thiết bị.** Tin cậy chứng chỉ của máy chủ một lần
([cách làm](../server.md#trust-the-certificate-authority-once-per-device)).
Cài plugin, rồi làm theo [Bắt đầu nhanh](../quickstart.md): thiết lập thiết bị
đầu tiên, rồi ghép nối các thiết bị còn lại.

Đã có HTTPS phía trước, từ một proxy hoặc tunnel mà bạn tin cậy? Hãy chạy
[máy chủ trần](../server.md#already-have-a-tls-terminator-docker) thay vào đó.

## Plugin này truy cập những gì

- **Máy chủ của bạn, không gì khác.** Mọi yêu cầu đều đi tới **Server URL** mà bạn nhập; không đo đạc từ xa, không bên thứ ba.
- **Một tài khoản trên máy chủ đó**, được tạo từ token thiết lập; tài khoản Obsidian của bạn không đóng vai trò gì.
- **GitHub Releases, thông qua Obsidian**, để cài và cập nhật; Obsidian bỏ qua các tệp phát hành phụ thêm.
- **Danh sách tệp trong khối lưu trữ của bạn**, để quyết định đồng bộ những gì; thư mục ẩn (`.obsidian`, `.git`) và thư mục là liên kết tượng trưng được bỏ qua.
- **Clipboard, chỉ được ghi vào** bởi **Copy code** và **Copy link** trong **Pair a new device**, không bao giờ bị đọc.
- **Trình duyệt của bạn, khi bạn mở hướng dẫn thiết lập.** Hướng dẫn của dự án mở ra ở đó; bản thân plugin không gửi gì cả.

Máy chủ có thể thấy gì và không thể thấy gì: [`SECURITY.md`](../../SECURITY.md) và [mô hình mối đe dọa](../threat-model.md).

## Các phiên bản

Bản LATEST là thẻ mới nhất trên
[trang Releases](https://github.com/snaraj/obsync/releases/latest). Đó là bản
Obsidian cài đặt và cập nhật lên. `main` là EDGE: những thay đổi đã được hợp
nhất nhưng chưa phát hành, dành cho người tự build từ mã nguồn. Không có kênh
beta và không có thẻ tiền phát hành. Mục Unreleased trong changelog là bản ghi
của EDGE.

## Câu hỏi, lỗi và bảo mật

- **Một câu hỏi, hoặc chưa chắc đó có phải lỗi không:** [Discussions](https://github.com/snaraj/obsync/discussions).
- **Một lỗi:** [mở một issue](https://github.com/snaraj/obsync/issues/new/choose) kèm báo cáo mà [Khắc phục sự cố](../troubleshooting.md#how-to-collect-a-report) mô tả. Đừng đưa vào token, cụm từ hay địa chỉ nào mà bạn không muốn công khai.
- **Nghi ngờ có lỗ hổng:** báo riêng, qua [`SECURITY.md`](../../SECURITY.md), không bao giờ qua issue công khai.

## Giấy phép

MIT. Xem [`LICENSE`](../../LICENSE).
