# Quiz Triết học

Webapp quiz realtime bằng tiếng Việt cho bài **Quy luật phủ định của phủ định** trong Triết học Mác–Lênin.

## Tính năng

- 20 câu trắc nghiệm, mỗi câu 4 đáp án.
- Một người tạo phòng; người chơi tham gia bằng mã phòng.
- Timer, tối đa 1.000 điểm mỗi câu, ưu tiên người đúng và nhanh.
- Bảng xếp hạng theo phòng, cập nhật realtime qua WebSocket.
- Host tự chuyển câu hoặc chuyển thủ công, kết thúc ván chơi.
- Offline/reconnect an toàn và âm thanh/SFX có thể bật tắt.
- Giao diện responsive cho máy tính và điện thoại.

## Chạy local

Chạy tất cả service bằng một lệnh PowerShell (TTS local, Worker, Pages và Cloudflare Tunnel):

```powershell
.\start-quiz.ps1
```

Script tự sinh token nội bộ, tự nối Admin với service TTS và tự dừng các service con khi nhấn `Ctrl+C`; không cần nhập token.

Nếu muốn chạy từng service riêng để debug, dùng các terminal bên dưới:

```bash
npm install
npm test

# Terminal 1: TTS local (chọn VietVoice-TTS, OmniVoice hoặc ElevenLabs trong /admin)
py presentation/local-tts/server.py

# Terminal 2: Durable Object với SQLite local
npx wrangler dev --config presentation/workers/wrangler.toml --local --port 8787

# Terminal 3: Pages Functions + quiz Worker local
npx wrangler pages dev . --do QUIZ_ROOM=QuizRoom@quiz-room-worker --port 8788
```

Mở `http://127.0.0.1:8788/presentation/quiz/` hoặc dùng hostname public `https://quiz.natime.vn/` khi Cloudflare Tunnel đang chạy. Trang quản trị TTS nằm ở `https://quiz.natime.vn/admin` và tự kết nối khi chạy bằng launcher.

## Đăng nhập quản trị

Trang `/admin` yêu cầu đăng nhập. Ở lần chạy đầu tiên, tài khoản mặc định là:

- Tên đăng nhập: `admin`
- Mật khẩu: `admin`

Sau lần đăng nhập đầu tiên, hệ thống bắt buộc đặt mật khẩu mới. Mật khẩu không được để trống. Thông tin đăng nhập được lưu local trong `.admin-credentials.json`, file này nằm trong `.gitignore` và không được đẩy lên GitHub. Launcher sẽ in user/password hiện tại ở terminal khi khởi động.

## Dữ liệu và API

Trạng thái phòng, câu trả lời và kết quả cuối được Durable Object lưu trong SQLite storage local (`storage = "sqlite"`). Không cần D1 hoặc deploy lên Cloudflare Pages.

Các API chính:

- `POST /api/quiz/rooms`
- `GET /api/quiz/rooms`
- `WebSocket /api/quiz/rooms/:roomCode/socket`
- `POST /api/score`
- `GET /api/leaderboard`
- `GET /api/history`

Pages chỉ proxy tới binding Durable Object `QUIZ_ROOM` của Worker `quiz-room-worker`. Cloudflare Tunnel trỏ domain `quiz.natime.vn` về Pages local trên port `8788`. Lịch sử tối đa 50 ván gần nhất được lưu trong SQLite storage của allocator Durable Object. Không còn editor slide, API lưu presentation hoặc runtime trình chiếu trong project này; slide được thực hiện trên Prezi bên ngoài.

## Kiểm thử

```bash
npm test
npm run test:scoring
npm run test:questions
npm run test:backend
npm run test:audio
```

Audio cố định, nhạc nền và SFX được khai báo trong [`presentation/quiz/audio/LICENSE.md`](presentation/quiz/audio/LICENSE.md).

### Voice động bằng TTS local

Voice động được tạo một lần ở Durable Object rồi lưu theo phòng để tất cả người chơi dùng chung audio:

- Khi mở đáp án: `Chúc mừng {tên} đã trả lời đúng và nhanh nhất!`
- Phần kết thúc ván dùng audio tĩnh, còn credit ElevenLabs không bị gọi cho bảng xếp hạng.

Service hỗ trợ hai engine clone giọng, chọn tại `https://quiz.natime.vn/admin`:

- `VietVoice-TTS`: model local bằng ONNX Runtime GPU.
- `OmniVoice Vietnamese`: model `splendor1811/omnivoice-vietnamese`, clone zero-shot từ cùng file mẫu.

### ElevenLabs Web API tích hợp trong Quiz

`presentation/local-tts/server.py` nạp trực tiếp phần session pool, quét Chrome/Edge, xoay vòng credit và sinh MP3 từ bộ ElevenLabs Web API Proxy. Không cần chạy thêm service ở cổng `5050`; launcher chỉ khởi động một service TTS ở cổng `8786`. Trong `/admin`, chọn engine `ElevenLabs Web API tool` để cấu hình voice, ngôn ngữ, model, speed, stability và similarity boost; tại đây có thể xem số tài khoản, tổng credit, quét session mới và xóa từng tài khoản. Voice động được bật mặc định nhưng chỉ tạo khi có người thắng nhanh nhất; log local ghi rõ nguồn `dynamic_quiz` hoặc `admin_preview`. Token/session chỉ được lưu trên máy chủ local, không gửi xuống trình duyệt người chơi.

Chỉ engine đang chọn mới được nạp vào GPU; đổi engine trong Admin rồi bấm **Lưu cấu hình**. File mẫu và reference text cũng chỉnh tại đó. Model được lưu trong cache local của Python, không đưa vào Git. Nếu service local không chạy hoặc lỗi, trình duyệt tự fallback sang giọng đọc hệ thống.
