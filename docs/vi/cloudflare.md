> Bản dịch này bám theo [bản gốc tiếng Anh](../cloudflare.md). Văn bản tiếng Anh là bản chuẩn; các lệnh, tùy chọn, URL và chỗ giữ chỗ được giữ nguyên.

# Cloudflare

Hai cách đặt Cloudflare giữa các thiết bị của bạn và máy chủ của bạn, và cách
nào được bản triển khai tham chiếu sử dụng. Không cách nào là bắt buộc: máy
chủ không biết tên bất kỳ nhà cung cấp nào, và
[Chạy máy chủ](../server.md) không cần tài khoản ở đâu cả. Trang này dành
cho bạn khi muốn truy cập máy chủ lúc xa nhà mà không mở cổng trên bộ định
tuyến, hoặc khi muốn một tên máy chủ công khai có chính sách truy cập đứng
trước.

Menu của Cloudflare và điều khoản gói dịch vụ thay đổi theo thời gian. Mỗi
bước bên dưới nêu đường dẫn menu như tài liệu Cloudflare đưa ra vào ngày
2026-09-22; hãy kiểm tra trang hiện tại trước khi dựa vào một giới hạn hay
một mức giá.

## Chọn cách nào

| Cách | Thiết bị nhìn thấy gì | Internet nhìn thấy gì | Lần đồng bộ lớn đầu tiên |
| --- | --- | --- | --- |
| **Tuyến riêng** (bản triển khai tham chiếu) | địa chỉ riêng và tên của chính bạn, qua ứng dụng Cloudflare One | không gì cả: không tên máy chủ, không cổng mở | lưu lượng mạng riêng, không đi qua tên máy chủ công khai |
| **Tên máy chủ công khai với Access** | một tên công khai, một chính sách Access, một token dịch vụ trong plugin | tên máy chủ, đứng sau Access | đi qua Cloudflare, theo điều khoản của nhà cung cấp về tệp lớn |

Tuyến riêng là tham chiếu vì máy chủ vẫn vô hình và vì chính tài liệu của
Cloudflare hướng các lần truyền lớn đi theo đường đó: tuyến tên máy chủ công
khai chuyển lưu lượng qua Cloudflare, và ở các gói Free, Pro và Business,
điều khoản riêng của dịch vụ yêu cầu dịch vụ trả phí cho video và các tệp lớn
khác, còn tuyến mạng riêng chuyển chúng như lưu lượng của chính bạn. Hãy thực
hiện lần đồng bộ lớn đầu tiên trên mạng LAN ở cả hai cách.

Bất cứ thứ gì kết thúc TLS đều đọc được thông tin đăng nhập của bạn nhưng
không bao giờ đọc được ghi chú: mọi khối và mọi bản kê đều được mã hóa trên
thiết bị, và không khóa nào có thể giải mã chúng đi qua đường truyền
([mô hình mối đe dọa](../threat-model.md)). Trên tuyến riêng, điểm kết thúc
TLS là của bạn, nằm trong mạng của bạn. Với tên máy chủ công khai, biên của
Cloudflare cũng là một điểm kết thúc TLS.

## Cách A: tuyến riêng và ứng dụng Cloudflare One

Máy chủ giữ một địa chỉ riêng trong mạng của bạn. Một bộ kết nối tunnel chạy
bên cạnh, một tuyến cho Cloudflare biết địa chỉ nào nằm sau tunnel đó, và
ứng dụng Cloudflare One (trước đây là WARP) trên mỗi thiết bị đưa lưu lượng
tới các địa chỉ đó qua tunnel. URL máy chủ mà thiết bị của bạn nhập vào là
một tên riêng phân giải về địa chỉ riêng đó.

Bạn cần: một tài khoản Cloudflare có tổ chức Zero Trust ("tên nhóm"), một
máy trong mạng của máy chủ có thể chạy bộ kết nối tunnel, và ứng dụng
Cloudflare One trên mọi thiết bị sẽ đồng bộ khi xa nhà.

1. **Tạo một tunnel.** Trong bảng điều khiển Cloudflare, vào **Networking**
   > **Tunnels** và tạo một tunnel `cloudflared`. Chạy bộ kết nối được cấp
   trên một máy trong mạng của máy chủ: trong cụm bên cạnh máy chủ, hoặc trên
   cùng máy.
2. **Định tuyến địa chỉ riêng của máy chủ qua tunnel.** Vào **Networking** >
   **Routes**, chọn **Create route** > **Tunnel CIDR**, chọn tunnel và nhập
   địa chỉ riêng hoặc dải mạng con của máy chủ. Một địa chỉ là đủ; dải mạng
   con có thể mở rộng sau.
3. **Đăng ký từng thiết bị.** Cài ứng dụng Cloudflare One, nhập tên nhóm,
   hoàn tất bước đăng nhập mà tổ chức của bạn yêu cầu, rồi bật kết nối. Trên
   iOS và Android, ứng dụng xin cài cấu hình VPN; hãy chấp nhận. Đặt quyền
   đăng ký thiết bị sao cho chỉ danh tính của bạn mới đăng ký được.
4. **Đưa dải riêng qua ứng dụng.** Trong cấu hình Split Tunnels của ứng
   dụng, đảm bảo địa chỉ ở bước 2 được định tuyến qua ứng dụng. Ở chế độ
   **Exclude**, bỏ khối RFC 1918 chứa nó và thêm lại những dải bạn vẫn muốn
   loại trừ; ở chế độ **Include**, thêm địa chỉ hoặc dải mạng con.
5. **Đảm bảo tên phân giải được trên thiết bị.** Plugin gửi mọi yêu cầu tới
   URL máy chủ bạn đã nhập, nên tên đó phải phân giải được trên thiết bị
   đang ở xa: một tuyến theo tên máy chủ, Local Domain Fallback về bộ phân
   giải của bạn, hoặc một bản ghi DNS riêng. Một tên phân giải ra địa chỉ mà
   ứng dụng không định tuyến sẽ thất bại y như máy chủ đang tắt.
6. **Tự kết thúc TLS.** Tuyến đưa lưu lượng của bạn tới điểm kết thúc TLS của
   chính bạn: một ingress hoặc reverse proxy đứng trước máy chủ với chứng
   chỉ mà mọi thiết bị tin cậy, như trong [Chạy máy chủ](../server.md). Máy
   chủ chạy với `OBSYNC_EDGE=none` và chỉ tin địa chỉ được chuyển tiếp từ
   `OBSYNC_TRUSTED_PROXY_CIDRS`, tức dải của chính điểm kết thúc TLS.
7. **Tùy chọn: lọc bằng Gateway.** Một chính sách mạng Gateway có thể chỉ
   cho phép các thiết bị đã đăng ký của bạn tới địa chỉ và cổng của máy chủ,
   và chặn mọi thứ khác trên tuyến đó.
8. **Kiểm tra từ một thiết bị ngoài mạng của bạn.** Mở URL máy chủ trong
   trình duyệt trên thiết bị đó và chờ trang đăng nhập của bảng điều khiển.
   Trong plugin, chọn **Check** dưới **Connection**: một lượt đi-về chứng
   minh cùng lúc địa chỉ, chứng chỉ và thông tin đăng nhập.

Đánh đổi:

- Mọi thiết bị đồng bộ đều chạy ứng dụng Cloudflare One, và ứng dụng phải
  đang kết nối thì đồng bộ khi xa nhà mới hoạt động.
- Cloudflare chuyển lưu lượng giữa thiết bị và bộ kết nối tunnel. Hãy để
  tính năng giải mã TLS của Gateway ở trạng thái tắt; khi đó lưu lượng là
  không đọc được với Cloudflare ngoài địa chỉ, kích thước và thời điểm, điều
  mà [mô hình mối đe dọa](../threat-model.md) vốn đã chấp nhận với mọi đường
  mạng.
- Bộ kết nối là một tiến trình trong mạng của bạn, giữ một kết nối đi ra
  Cloudflare luôn mở. Khi nó ngừng, các thiết bị ở xa hiện `obsync: offline`
  trong khi mạng LAN vẫn hoạt động.

## Cách B: tên máy chủ công khai đứng sau Access

Máy chủ nhận một tên máy chủ trên một miền bạn có ở Cloudflare. Tunnel công
bố tên đó tới địa chỉ riêng của máy chủ, và Cloudflare Access đứng trước:
một chính sách danh tính cho bảng điều khiển, và một token dịch vụ cho các
lời gọi API của plugin. Đây là cách mà
[tích hợp nền tảng](../platform-onboarding.md) mô tả cho cụm tham chiếu, và
là cách mà bản triển khai tham chiếu chưa chọn.

1. **Công bố tên máy chủ.** Trong cấu hình tunnel, thêm một tuyến ứng dụng
   công bố từ tên máy chủ của bạn (`sync.example.com` thay cho tên thật) tới
   địa chỉ HTTP riêng của máy chủ, cổng 8080. Cloudflare tạo bản ghi DNS.
2. **Đặt Access phía trước.** Vào **Zero Trust** > **Access controls** >
   **Applications**, tạo một ứng dụng **Self-hosted** trên tên máy chủ đó,
   và thêm một chính sách danh tính chỉ cho phép bạn, chẳng hạn mã PIN dùng
   một lần gửi tới địa chỉ của bạn, dành cho bảng điều khiển.
3. **Tạo token dịch vụ cho plugin.** Vào **Zero Trust** > **Access controls**
   > **Service credentials** > **Service Tokens**, tạo một token và sao chép
   Client ID cùng Client Secret; secret chỉ hiện một lần. Thêm vào ứng dụng
   một chính sách **Service Auth** bao gồm token này, cho các đường dẫn
   plugin dùng (`/v1/*`).
4. **Dán token vào plugin.** Dưới **Edge service-token headers**, mỗi dòng
   một mục, đúng như Cloudflare đặt tên:

   ```text
   CF-Access-Client-Id: <the client id>
   CF-Access-Client-Secret: <the client secret>
   ```

   Chúng đi kèm mọi yêu cầu tới URL máy chủ, và không đi đâu khác.
5. **Cho máy chủ biết nó đứng sau biên.** Chạy máy chủ với
   `OBSYNC_EDGE=cloudflare`. Ở chế độ đó, mọi yêu cầu phải mang các tiêu đề
   của biên về địa chỉ kết nối và mã yêu cầu, và yêu cầu đi vòng qua biên sẽ
   bị từ chối với `421 edge_required`
   ([khắc phục sự cố](../troubleshooting.md#edge_required)).
6. **Kiểm tra.** Mở tên máy chủ trong trình duyệt và chờ màn hình đăng nhập
   Access, rồi tới bảng điều khiển. Trong plugin, chọn **Check** dưới
   **Connection**.

Đánh đổi:

- Tên máy chủ là công khai. Access từ chối người lạ, và máy chủ vẫn tự xác
  thực mọi yêu cầu của thiết bị, nhưng cái tên tồn tại và có thể bị phát
  hiện.
- Token dịch vụ là một thông tin đăng nhập. Ai nắm được nó thì tới được cửa
  trước của API; xác thực thiết bị của chính máy chủ vẫn đứng phía sau. Hãy
  xoay vòng nó trong Cloudflare nếu có lúc bị lộ.
- Các lần truyền lớn đi qua Cloudflare theo điều khoản nêu trên. Hãy thực
  hiện lần đồng bộ lớn đầu tiên trên mạng LAN.
- Các tiêu đề của biên về địa chỉ kết nối và quốc gia chính là thứ trang
  Thiết bị của bảng điều khiển hiển thị làm địa chỉ và quốc gia ở chế độ này.

## Những gì đã được chứng minh

Tuyến riêng là tuyến của bản triển khai tham chiếu.
[Đợt chạy 2026-09-14](../validation-runs/2026-09-14.md) ghi lại rằng hôm đó
tuyến này chưa được thử, và lý do;
[đợt chạy 2026-09-20](../validation-runs/2026-09-20.md) ghi lại một đợt chạy
với thiết bị trên tuyến tham chiếu, các kiểm tra kết nối và TLS đều đạt.
Cách dùng tên máy chủ công khai chưa được thử trong bất kỳ đợt chạy nào được
ghi lại.

## Tiếp theo

- [Chạy máy chủ](../server.md): điểm kết thúc TLS, các ổ lưu trữ, token thiết
  lập.
- [Kubernetes](https://github.com/snaraj/obsync/blob/main/chart/README.md): chart mà bản triển khai tham chiếu sử
  dụng.
- [Tích hợp nền tảng](../platform-onboarding.md): cụm tham chiếu sẽ bổ sung
  gì cho một tên máy chủ công khai.
- [Khắc phục sự cố](../troubleshooting.md): `edge_required`, `offline` và
  chứng chỉ.
