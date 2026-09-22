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
> Plugin này đồng bộ tới một máy chủ do **bạn** vận hành. Không có dịch vụ lưu
> trữ sẵn và không có tài khoản với bất kỳ ai ngoài chính bạn: nếu không có
> `obsyncd` của riêng bạn, truy cập được qua HTTPS, plugin chẳng có gì để đồng
> bộ tới.

> [!IMPORTANT]
> Hãy sao lưu kho của bạn trước lần đồng bộ đầu tiên, và giữ cụm từ khôi phục
> 24 từ ở nơi khác với thiết bị đã tạo ra nó. Máy chủ chỉ lưu bản mã và không
> thể khôi phục một kho giúp bạn.

> [!IMPORTANT]
> Đừng chạy plugin này bên cạnh một giải pháp đồng bộ khác trên cùng một kho —
> Obsidian Sync, một thư mục đám mây có đồng bộ tệp, hay một plugin đồng bộ
> khác. Hai bên cùng ghi vào một kho sẽ tạo ra những xung đột mà không bên nào
> hòa giải được.

## Trước khi bạn tin cậy nó

Đây là phần mềm còn non trẻ, và nó đồng bộ bản sao duy nhất các ghi chú của
bạn.

- **[`CHANGELOG.md`](../../CHANGELOG.md) là danh sách được duy trì về những gì
  đã biết.** Hãy đọc mục dành cho phiên bản bạn đang dùng, và các mục nằm trên
  nó. Trang phát hành giữ nguyên những ghi chú lúc chúng được công bố; các phát
  hiện về sau được bổ sung ở đây.
- **Hãy cập nhật mọi thiết bị đang đồng bộ một kho.** Một thiết bị còn ở phiên
  bản cũ vẫn có thể hành xử theo lối cũ và ảnh hưởng tới những thiết bị khác.
- **Những gì đã thực sự được thử trên phần cứng** được ghi lại theo từng đợt
  chạy trong [`docs/validation-runs/`](../validation-runs/), kể cả những gì mỗi
  đợt chạy không bao phủ. Một nền tảng mà không đợt chạy nào nhắc tên thì chưa
  được chứng minh.
- **Một loạt thông báo "merged concurrent edits"** trên hai thiết bị cùng sửa
  một ghi chú: hãy thoát Obsidian trên một máy để máy kia xử lý cho hết,
  cập nhật cả hai, rồi tiếp tục.

## Plugin này truy cập những gì

Ngắn gọn và đầy đủ, để bạn có thể quyết định trước khi cài.

- **Một đích mạng duy nhất: máy chủ của chính bạn.** Mọi yêu cầu đều đi tới
  **Server URL** mà bạn nhập trong phần cài đặt của plugin, và không đi đâu
  khác. Không có đo đạc từ xa, không có phân tích số liệu, không có trình báo
  cáo sự cố, không có quảng cáo, và không có dịch vụ của bên thứ ba ở bất kỳ
  đâu trên đường đồng bộ. Plugin cũng không bao giờ tải hay chạy mã từ máy chủ
  đó.
- **Một tài khoản trên máy chủ đó, do chính bạn tạo.** Thiết bị đầu tiên dùng
  token thiết lập mà máy chủ của bạn đã ghi ra ở lần khởi động đầu; mọi thiết
  bị khác đều được ghép nối từ một thiết bị đã đồng bộ. Tài khoản Obsidian của
  bạn không đóng vai trò gì.
- **Obsidian và GitHub, chỉ để cài đặt và cập nhật.** Chính Obsidian tải
  `main.js`, `manifest.json` và `styles.css` từ GitHub Releases của kho mã này.
  Mỗi bản phát hành còn mang theo một tệp ZIP của plugin và một bản kê phát
  hành dành cho những người triển khai máy chủ; Obsidian bỏ qua cả hai.
- **Biên của bạn, chỉ khi bạn đã cấu hình một cái.** Các tiêu đề bạn dán dưới
  **Edge service-token headers** đi kèm mọi yêu cầu tới Server URL ở trên, vì
  proxy cần chúng nằm trên đường tới máy chủ của bạn.
- **Danh sách tệp trong kho của bạn.** Plugin liệt kê mọi tệp trong kho để
  quyết định cái gì nằm trong phạm vi, đọc các tệp bên trong phần thư mục bạn
  đã chọn, và ghi lại những gì các thiết bị khác đã thay đổi. Thư mục ẩn
  (`.obsidian`, `.git`) và thư mục là liên kết tượng trưng thì được bỏ qua.
- **Clipboard, chỉ được ghi vào và không bao giờ bị đọc ra.** Chỉ có nút
  **Copy code** và **Copy link** trong **Pair a new device** ghi vào đó. Không
  có gì trong plugin đọc clipboard.
- **Trình duyệt của bạn, khi bạn yêu cầu bảng điều khiển.** **Open dashboard**
  mở một liên kết đăng nhập trong trình duyệt của bạn, và chỉ khi liên kết đó
  nằm trên chính nguồn gốc máy chủ của bạn.
- **Kho bí mật của Obsidian.** Khóa kho, bí mật thiết bị và mọi giá trị tiêu đề
  biên đều nằm ở đó, không bao giờ nằm trong dữ liệu plugin dạng thường.

Máy chủ có thể thấy gì và không thể thấy gì nằm trong
[`SECURITY.md`](../../SECURITY.md) và
[`docs/threat-model.md`](../threat-model.md).

## Đồng bộ trong năm bước

Con đường mà bản phát hành này đã được kiểm chứng trên đó, từ một kho rỗng tới
hai thiết bị đồng bộ với nhau. Cả năm bước đều giả định máy chủ của chính bạn
đã chạy, đó là phần ngay bên dưới; mỗi bước được viết ra đầy đủ trong phần khởi
động nhanh.

1. **Cài từ phần mở rộng của bên thứ ba.** Trong Cài đặt → Phần mở rộng của
   bên thứ ba → Duyệt, hãy tìm **Self Hosted Private Sync** rồi chọn Cài đặt,
   sau đó Kích hoạt — đúng cách mà mọi plugin Obsidian khác đến với bạn, trên
   mọi nền tảng.

   ![Trình duyệt phần mở rộng của bên thứ ba trong Obsidian hiển thị Self Hosted Private Sync với nút Cài đặt của nó](../captures/01-install-from-directory.png)

2. **Trỏ nó tới máy chủ của bạn và thiết lập.** Mở thẻ cài đặt của plugin, đặt
   **Server URL** thành máy chủ của chính bạn, chọn những thư mục mà thiết bị
   này đồng bộ, rồi dán token thiết lập của bạn dưới **First-time setup**.

   ![Thẻ cài đặt của plugin đã cuộn tới phần chọn thư mục, tới Pairing và tới ô token của First-time setup](../captures/02-first-time-setup.png)

3. **Hãy giữ cụm từ khôi phục.** Bước thiết lập tạo khóa kho ngay trên thiết bị
   này và hiển thị một cụm 24 từ đúng một lần: hãy chép nó ra và cất ở nơi khác
   với thiết bị này, bởi máy chủ chỉ giữ bản mã và không thể khôi phục một kho
   giúp bạn.

   ![Hộp thoại cụm từ khôi phục hiện ra sau bước thiết lập lần đầu, các từ đã được che](../captures/03-recovery-phrase.png)

4. **Ghép nối thiết bị thứ hai bằng một mã dùng một lần.** Chạy **Pair a new
   device** trên thiết bị thứ nhất, nhập mã nó hiển thị vào thiết bị thứ hai
   trong vòng mười phút, rồi phê duyệt thiết bị theo tên — khóa kho di chuyển ở
   dạng mã hóa dưới một bí mật ghép nối mà máy chủ không bao giờ thấy.

   ![Hộp thoại Pair a new device trên thiết bị thứ nhất, mã dùng một lần của nó đã được che](../captures/04-pair-a-new-device.png)

5. **Sửa trên thiết bị nào cũng được và xem nó tới nơi.** Gõ vào một ghi chú
   trên một thiết bị và nó xuất hiện trên thiết bị kia trong vài giây, theo cả
   hai chiều, với thanh trạng thái cho thấy việc đồng bộ đang làm gì.

   ![Ghi chú dùng một lần mang thay đổi của cả hai thiết bị, thanh trạng thái đồng bộ hiện rõ](../captures/05-sync-both-ways.png)

Danh sách thiết bị của bảng điều khiển và nút thu hồi của nó được mô tả ở
[Xem các thiết bị của bạn](../daily-use.md#see-your-devices) và chưa được thử
trong đợt chạy thiết bị cho 1.0.0, ghi lại tại
[docs/validation-runs/2026-09-14.md](../validation-runs/2026-09-14.md).

## Bắt đầu đồng bộ

Con đường đúng và ngắn nhất: một máy thuộc về bạn chạy máy chủ, mọi thiết bị
tới được nó qua HTTPS, và mỗi thiết bị được ghép nối một lần. Việc đăng nhập
Obsidian không cấp quyền gì ở đây; tài khoản duy nhất là tài khoản trên máy chủ
của bạn.

### 1. Khởi động máy chủ

Có hai cách khởi động. Cả hai đều chạy đúng những byte mà nhà phát hành đã ký:
xác minh chữ ký, đọc digest từ kết quả đã xác minh, rồi chạy chính digest đó.
`v1.0.6` là bản phát hành mà trang này được viết dựa theo; hãy dùng tag của bản
phát hành mà bạn đang cài.

```sh
cosign verify ghcr.io/snaraj/obsync:v1.0.6 \
  --certificate-identity https://github.com/snaraj/obsync/.github/workflows/release-publisher.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

**Chưa có HTTPS?** `deploy/compose` khởi động máy chủ phía sau điểm kết thúc
TLS của riêng nó (Caddy), trên mạng nào cũng được, không cần tên miền và không
cần tài khoản với bất kỳ ai. Từ một bản lấy về của kho mã này:

```sh
OBSYNC_IMAGE=ghcr.io/snaraj/obsync@sha256:<digest> \
  OBSYNC_HOST=sync.example.org \
  OBSYNC_BIND_ADDRESS=192.168.1.10 \
  docker compose -f deploy/compose/docker-compose.yml up -d
```

`OBSYNC_HOST` là cái tên mà thiết bị của bạn sẽ gõ vào. Nó chỉ cần phân giải
được trong mạng của chính bạn. `OBSYNC_BIND_ADDRESS` là địa chỉ của máy này mà
cổng 80 và 443 được công bố trên đó: một địa chỉ bind giới hạn giao diện đích,
chứ không giới hạn nguồn, nên tường lửa của bạn mới là thứ quyết định ai tới
được. Compose từ chối khởi động cho tới khi bạn đã chọn. Cả hai đều được giải
thích trong [Chạy máy chủ](../server.md).

**Đã có sẵn HTTPS đứng trước** máy đó, từ một reverse proxy hay một tunnel bạn
tin cậy? Hãy chạy máy chủ trần. Nó nói HTTP thuần trên cổng 8080, và điểm kết
thúc của bạn chuyển tiếp tới nó:

```sh
docker volume create obsync-blobs
docker volume create obsync-journal
docker run -d --name obsync -p 127.0.0.1:8080:8080 \
  -v obsync-blobs:/data/blobs -v obsync-journal:/data/journal \
  -e OBSYNC_BLOBS_CAPACITY=250GiB -e OBSYNC_JOURNAL_CAPACITY=4GiB \
  -e OBSYNC_PUBLIC_URL=https://sync.example.org \
  ghcr.io/snaraj/obsync@sha256:<the digest cosign just verified>
```

### 2. Đọc token thiết lập

Ở lần khởi động đầu, máy chủ đúc ra một token thiết lập và ghi nó vào ổ nhật ký
của mình, chế độ 0600, không bao giờ bị ghi ra log. Token tạo tài khoản của bạn
một lần, rồi sau đó nó vẫn là cách đăng nhập khôi phục của bảng điều khiển
trong suốt vòng đời máy chủ: hãy giữ nó cẩn thận đúng như giữ cụm từ khôi phục.
Hãy đọc nó ngay từ container, không cần image phụ trợ. Trên đường Compose:

```sh
docker cp obsync-obsync-1:/data/journal/v1/setup-token - | tar -xO
```

Trên đường máy chủ trần:

```sh
docker cp obsync:/data/journal/v1/setup-token - | tar -xO
```

### 3. Tin cậy chứng chỉ, một lần cho mỗi thiết bị (đường Compose)

Caddy đã cấp chứng chỉ từ một tổ chức chứng thực mà chính nó tạo ra ở lần khởi
động đầu, nên mỗi thiết bị phải được chỉ dẫn để tin cậy tổ chức đó một lần.
Hãy xuất chứng chỉ gốc:

```sh
docker cp obsync-caddy-1:/data/caddy/pki/authorities/local/root.crt - | tar -xO > obsync-root.crt
```

Hãy cài `obsync-root.crt` lên từng thiết bị. Các bước cho macOS, Windows,
Linux, iOS và Android nằm ở
[Tin cậy tổ chức chứng thực, một lần cho mỗi thiết bị](../server.md#trust-the-certificate-authority-once-per-device).
Trên iOS, việc tin cậy chứng chỉ là một công tắc thứ hai sau khi cài nó.

### 4. Thiết lập thiết bị đầu tiên

1. Cài đặt → Phần mở rộng của bên thứ ba → Duyệt → **Self Hosted Private
   Sync** → Cài đặt → Kích hoạt.
2. Trong phần cài đặt của plugin, đặt **Server URL** thành máy chủ của bạn, kèm
   cổng khi nó không phải 443: `https://sync.example.org`.

   ![Thẻ cài đặt của plugin: ô Server URL chứa một tên máy mẫu, ô nhập các tiêu đề biên, và hàng Connection với các nút Check và Open dashboard của nó](../assets/settings-server.png)

3. Hãy chọn **Whole vault** hoặc **Selected folders only** ngay bây giờ. Một
   khi thiết bị đã đồng bộ, lựa chọn của nó chỉ có thể thu hẹp lại.
4. Dán token thiết lập dưới **First-time setup** rồi chọn **Set up**. Hãy chép
   lại cụm từ khôi phục 24 từ và giữ nó ở ngoài thiết bị này.

   ![Mục This device của thẻ cài đặt: hàng Pairing với Pair this device và Pair a new device, hàng First-time setup với ô Setup token và nút Set up, cùng hàng Vault key](../assets/settings-setup.png)

### 5. Ghép nối thiết bị thứ hai

1. Hãy cài và kích hoạt plugin ở đó, đặt cùng một **Server URL**, và chọn các
   thư mục của nó.
2. Trên thiết bị thứ nhất, chạy **Pair a new device**. Nó hiển thị một mã có
   hiệu lực trong mười phút.

   ![Hộp thoại Pair a new device trên thiết bị thứ nhất, mã của nó đã được che, với các nút Copy code và Copy link và dòng Waiting for the new device](../assets/pair-new-device.png)

3. Trên thiết bị thứ hai, mở **Pair this device**, dán mã vào, rồi chọn
   **Pair**.

   ![Hộp thoại Pair this device trên thiết bị thứ hai, với ô Pairing code còn trống và nút Pair](../assets/pair-this-device.png)

4. Quay lại thiết bị thứ nhất, hãy phê duyệt thiết bị mới theo tên. Sửa một ghi
   chú trên thiết bị nào cũng được; nó xuất hiện trên thiết bị kia trong vài
   giây.

   ![Thiết bị thứ nhất hỏi có phê duyệt thiết bị mới theo tên hay không, với các nút Approve và Reject](../assets/pair-approve.png)

   ![Thiết bị thứ hai hiển thị ghi chú được viết trên thiết bị thứ nhất, thanh trạng thái hiện obsync idle](../assets/first-sync.png)

Toàn bộ quá trình trao đổi ghép nối, trong một vòng lặp ngắn:

![Ảnh động: mã ghép nối hiện trên thiết bị thứ nhất, được dán vào thiết bị thứ hai, được phê duyệt trên thiết bị thứ nhất, và ghi chú đầu tiên tới nơi trên thiết bị thứ hai](../assets/pairing.gif)

Ảnh chụp màn hình từ điện thoại chưa có trong kho mã này; chúng được chụp trên
chính các thiết bị của người bảo trì và được bổ sung khi một đợt chạy kiểm
chứng ghi lại chúng.

Từng bước đầy đủ, kèm việc mỗi màn hình hỏi gì và vì sao:
[Khởi động nhanh](../quickstart.md).

**Thử trên một máy tính thôi?** Trên máy tính, plugin cũng chấp nhận một địa
chỉ `http://` thuần, nên `http://127.0.0.1:8080` tới được máy chủ trần ở trên
mà không cần điểm kết thúc. Điện thoại thì không: Obsidian trên iOS và Android
từ chối HTTP thuần.

## Nâng cao: Cloudflare

Bản triển khai tham chiếu **không có tên máy chủ công khai**. Một Cloudflare
Tunnel nối mạng riêng của máy chủ với Cloudflare, một tuyến riêng cho
Cloudflare biết những địa chỉ nào nằm sau tunnel đó, và ứng dụng Cloudflare One
trên mỗi thiết bị đưa Server URL tới đó. Không gì tới được từ internet, và
những lần đồng bộ lớn đầu tiên không bị chuyển qua một tên máy chủ công khai.
Hình thái còn lại, một tên máy chủ công khai đứng sau Cloudflare Access với một
token dịch vụ trong **Edge service-token headers** và `OBSYNC_EDGE=cloudflare`
trên máy chủ, cũng được hỗ trợ. Cả hai, từng bước một:
[Cloudflare](cloudflare.md).

## Những cách khác để tới máy chủ của bạn

Mỗi cách một dòng, không phải hướng dẫn chi tiết. Dù bạn chọn cách nào, plugin
cũng cần HTTPS với một chứng chỉ mà mọi thiết bị đều tin cậy, còn bản thân máy
chủ vẫn ở HTTP thuần phía sau điểm kết thúc đó.

- **Chỉ LAN.** Đường Compose ở trên, chỉ tới được khi ở nhà. Đơn giản nhất;
  không đồng bộ khi xa nhà.
- **WireGuard.** VPN của chính bạn quay về mạng của bạn. Nhanh nhất và hoàn
  toàn thuộc về bạn; bạn mang một cấu hình peer trên mọi thiết bị và giữ cho
  một điểm cuối luôn tới được.
- **Tailscale.** Một lưới WireGuard được quản lý, có hệ thống tên riêng. Ít
  phải thiết lập nhất trên các thiết bị; một bên thứ ba điều phối lưới đó, và
  giới hạn gói dịch vụ của họ là thứ bạn phải tự đọc.
- **Một reverse proxy có TLS tự động**, chẳng hạn Caddy trên một tên công khai.
  Một chứng chỉ được công chúng tin cậy và một địa chỉ cố định; khi đó máy chủ
  tới được từ internet, còn proxy cùng các bản cập nhật của nó là thứ bạn phải
  tự giữ cho đúng.
- **Cloudflare Tunnel.** Xem ở trên. Không có cổng vào; một nhà cung cấp nằm
  trên đường đi với điều khoản riêng của họ.

Một thiết bị đang đi xa cần những gì, dù bạn chọn cách nào (tuyến, tên, chứng
chỉ, lời nhắc mạng cục bộ của iOS, tường lửa):
[Tới nó từ bên ngoài LAN của bạn](../server.md#reaching-it-from-outside-your-lan).

## Khắc phục sự cố

| Triệu chứng | Nguyên nhân có thể | Việc nên thử trước tiên |
| --- | --- | --- |
| `obsync: offline` | Thiết bị không tới được Server URL | Mở URL đó trong trình duyệt trên chính thiết bị ấy; kiểm tra cổng, HTTPS và tuyến |
| Một điện thoại không chịu kết nối trong khi máy tính vẫn đồng bộ | Chứng chỉ riêng không được tin cậy trên điện thoại | Cài chứng chỉ gốc; trên iOS còn phải bật nó trong "Certificate Trust Settings" |
| `401 stale_timestamp` | Một chiếc đồng hồ lệch quá 300 giây | Bật giờ tự động, trên thiết bị hoặc trên máy chủ |
| `403 device_pending` | Chưa ai phê duyệt thiết bị đó | Hãy phê duyệt nó theo tên trên chính thiết bị mà bạn đã ghép nối từ đó |
| Một tệp không bao giờ tới nơi | Nó nằm ngoài phần thư mục đã chọn, hoặc vượt trần kích thước của điện thoại | Kiểm tra **Sync folders on this device**; trên điện thoại hãy chạy **Show remote-only files** |

Mọi triệu chứng khác, mọi mã lỗi, và cách thu thập một báo cáo đáng gửi:
[Khắc phục sự cố](../troubleshooting.md).

## Tài liệu

| Trang | Nó trả lời điều gì |
| --- | --- |
| [Khởi động nhanh](../quickstart.md) | Thiết bị đầu tiên và thiết bị thứ hai, từng bước đầy đủ |
| [Chạy máy chủ](../server.md) | Docker, Compose với Caddy, chứng chỉ, sao lưu, tới nó từ bên ngoài LAN của bạn |
| [Cloudflare](cloudflare.md) | Tunnel với một tuyến riêng và ứng dụng Cloudflare One, hoặc một tên máy chủ công khai đứng sau Access |
| [Kubernetes](../../chart/README.md) | Cài máy chủ bằng chart Helm đã ký |
| [Dùng hằng ngày](../daily-use.md) | Các lệnh, thanh trạng thái, cái gì được đồng bộ và cái gì không, khôi phục một phiên bản, bảng điều khiển |
| [Cài đặt](../settings.md) | Mọi tùy chọn, giá trị mặc định của nó, và khi nào nên đổi |
| [Khắc phục sự cố](../troubleshooting.md) | Triệu chứng, nguyên nhân, cách sửa, và cách thu thập một báo cáo |
| [Xung đột](../conflicts.md) | Bản sao xung đột là gì và phải làm gì với nó |
| [Khôi phục](../recovery.md) | Một thiết bị bị mất, một máy chủ bị mất, một máy chủ đã dời chỗ, một token đã xoay vòng |
| [Cài và cập nhật](../community-plugin.md) | Thư mục phần mở rộng của Obsidian, các bản cập nhật, việc trông giữ thông tin đăng nhập, khâu duyệt hồ sơ đăng ký |
| [Mô hình mối đe dọa](../threat-model.md) | Cái gì được phòng vệ, và cái gì không |
| [Mô hình mối đe dọa của bảng điều khiển](../security/dashboard.md) | Phiên, đăng nhập, thu hồi, rủi ro còn lại |
| [Kiến trúc](../architecture.md) | Toàn bộ hệ thống được dựng nên ra sao, và mọi biến môi trường |
| [Giao thức](../protocol.md) | Hợp đồng trên đường truyền giữa plugin và máy chủ |
| [Lưu trữ](../storage.md) | Các ổ, độ bền, thời gian lưu giữ, quét dọn, và mọi lần từ chối |
| [Kiểm chứng](../validation.md) | Kế hoạch kiểm chứng trên thiết bị và "sẵn sàng" nghĩa là gì |
| [Bản phát hành](../release.md) | Một bản phát hành được cắt, ký và kiểm toán ra sao |
| [Bản dịch](../translations.md) | Các hướng dẫn có trong những ngôn ngữ nào, và chúng được giữ cho cập nhật ra sao |
| [`CHANGELOG.md`](../../CHANGELOG.md) | Mỗi phiên bản đã thay đổi những gì |
| [`SECURITY.md`](../../SECURITY.md) | Lập trường, các phiên bản được hỗ trợ, và cách báo cáo một lỗ hổng |
| [`CONTRIBUTING.md`](../../CONTRIBUTING.md) | Cách làm việc trên kho mã này |

## Câu hỏi, lỗi và bảo mật

- **Một câu hỏi, hoặc một điều bạn không chắc có phải lỗi hay không:**
  [Discussions](https://github.com/snaraj/obsync/discussions).
- **Một lỗi:** [hãy mở một issue](https://github.com/snaraj/obsync/issues/new/choose)
  với mẫu báo cáo lỗi và bản báo cáo được mô tả trong
  [Khắc phục sự cố](../troubleshooting.md). Đừng kèm token nào, đừng kèm cụm từ
  khôi phục, và đừng kèm địa chỉ nào mà bạn không muốn công bố.
- **Một lỗ hổng bị nghi ngờ:** hãy báo riêng, qua
  [`SECURITY.md`](../../SECURITY.md) — không bao giờ qua một issue công khai.

## Giấy phép

MIT. Xem [`LICENSE`](../../LICENSE).
