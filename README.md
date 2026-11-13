# اودیسه پنل · نسخه کلادفلر · Odyssey Panel — Cloudflare Edition

<p align="center">
  <b>فارسی</b> · <a href="#english">English</a>
</p>

پنل مدیریت **رایگان** و سلف‌هاست برای پروکسی و اشتراک — **کاملاً روی Cloudflare Workers + D1** اجرا می‌شود (Next.js 16 + Prisma + D1، بدون سرور، بدون کانتینر، بدون Railway).

**نسخه v16** با ریدیزاین جدید: تم تاریک «سرمه‌ای شبانه / فیروزه‌ای اقیانوسی»، تم روشن، شیشه‌ای (glass)، کارت‌های لایه‌بندی‌شده، نوار موبایل و حالت کاهش حرکت (reduced-motion).

- 🇮🇷 **فارسی پیش‌فرض** (راست‌به‌چپ) با فونت وزیرمتن + سوییچ انگلیسی
- 🖥️📱 **دو چیدمان**: دسکتاپ با منوی کناری، موبایل با منوی پایین
- 👥 **کاربران**: محدودیت ترافیک، تاریخ انقضا، فعال/غیرفعال، یادداشت
- 🔗 **اشتراک**: لینک + QR، فرمت‌های `base64 / raw / clash / sing-box`
- 🧩 **حساب‌های پروکسی**: VLESS / VMess / Trojan / Shadowsocks با UUID/رمز خودکار
- 🩺 **نودها و ورکرها**: بررسی سلامت TCP / TLS / HTTP + ردیابی انقضای گواهی
- 🚀 **استقرار یک‌کلیکی ورکر تونل**: پنل خودش ورکر vless-over-WebSocket را با توکن API به حساب کلادفلر تو آپلود و ثبت می‌کند — توکن ذخیره نمی‌شود
- 🛰️ **اسکنر**: پورت، TLS/SNI و اطلاعات HTTP
- 📨 **پروکسی تلگرام (MTProto)**: ساخت رمز (پدینگ تصادفی `dd` یا **FakeTLS `ee`**)، لینک `t.me/proxy`، QR و نصاب آماده VPS
- 🔐 ورود با رمز (سشن امضاشده HMAC، ۳۰ روزه) — رمز پیش‌فرض `admin123`

> ⚠️ ربات تلگرام و بخش فروش از این نسخه حذف شده است — پنل کاملاً شخصی است.
> ⚠️ وردکرهای کلادفلر نمی‌توانند پورت خام TCP را میزبانی کنند؛ ترافیک vless از **ورکر تونل** عبور می‌کند و سرور MTProxy روی VPS خودت اجرا می‌شود.

## اجرای لوکال

```bash
cp .env.example .env        # DATABASE_URL لوکال
npm install                 # یا bun install
npx prisma db push          # ساخت جداول در SQLite لوکال
npm run dev                 # http://localhost:3000
```

برای شبیه‌سازی دقیق Bindings کلادفلر در لوکال: `npm run dev:cf` (D1 لوکال از طریق wrangler).

رمز پیش‌فرض: `admin123` — با اولین تلاش ورود روی یک دیتابیس خالی، خودکار ساخته می‌شود (self-heal). بعد از اولین ورود از **تنظیمات** عوضش کنید.

## دیپلوی روی Cloudflare Workers + D1

راهنمای کامل و قدم‌به‌قدم: **[DEPLOY-CF.md](DEPLOY-CF.md)**

خلاصه:

```bash
npm install
npx wrangler d1 create odyssey-db         # database_id را در wrangler.jsonc بگذار
npm run db:d1:local                       # تست لوکال (اختیاری)
npm run db:d1:remote                      # ساخت جداول در D1 اصلی
npx wrangler deploy                       # یا: npm run deploy
```

یا کاملاً خودکار: ریپو را به GitHub بدهید و در اکشن `Deploy to Cloudflare Workers` (فایل `.github/workflows/deploy.yml`) با سکرت‌های `CLOUDFLARE_API_TOKEN` و `CLOUDFLARE_ACCOUNT_ID`، هر push به `main` مستقیماً دیپلوی می‌شود.

## تفاوت‌های کلیدی نسبت به نسخه Railway

| موضوع | Railway (نسخه قبلی) | Cloudflare (این نسخه) |
| --- | --- | --- |
| دیتابیس | SQLite روی volume با Prisma | **D1** با آداپتر رسمی Prisma |
| اجرای برنامه | کانتینر Node + `output: standalone` | ورکر با `@opennextjs/cloudflare` |
| بک‌اند داخلی xray (`/vlessws`) | داخل کانتینر اجرا می‌شد | حذف — ورکر تونل جایگزین است |
| jobs پس‌زمینه | حلقه setInterval داخل پروسه | `GET /api/cron?secret=…` (پینگ هر ۵ دقیقه) + چک خودکار هنگام باز شدن داشبورد |
| sharp | برای اپتیمایزر تصویر | حذف (`images.unoptimized`) |

## ساختار پروژه

```
src/app/            صفحه پنل + API (auth, admin, sub, cron)
src/components/panel/  UI پنل (دو چیدمان موبایل/دسکتاپ) + تم v16
src/lib/            i18n (فارسی/انگلیسی), auth, health, links, worker-kit
prisma/             اسکیمای SQLite/D1 + seed لوکال
migrations/         مایگریشن‌های SQL برای D1 (wrangler d1 migrations)
wrangler.jsonc      کانفیگ ورکر + بایندینگ D1
.github/workflows/  دیپلوی خودکار روی push
```

---

<a name="english"></a>

## English

A **free**, self-hosted proxy & subscription control panel — **runs entirely on Cloudflare Workers + D1** (Next.js 16 + Prisma + D1; no server, no container, no Railway).

**v16 redesign**: midnight-navy/cyan dark theme, ocean-light theme, glass surfaces, layered cards, mobile bottom bar, reduced-motion support.

- 🇮🇷 **Persian by default** (RTL, Vazirmatn font) with an instant English switch
- 🖥️📱 **Two layouts**: desktop sidebar on computers, bottom navigation on phones
- 👥 **Users**: traffic limits, expiry dates, enable/disable, notes
- 🔗 **Subscriptions**: link + QR with `base64 / raw / clash / sing-box` formats
- 🧩 **Proxy accounts**: VLESS / VMess / Trojan / Shadowsocks with auto UUID/password
- 🩺 **Nodes & workers**: TCP/TLS/HTTP health checks + certificate expiry tracking
- 🚀 **One-click tunnel worker deploy**: the panel uploads the vless-over-WebSocket worker to your Cloudflare account via API token (used once, never stored) and registers the URL
- 🛰️ **Scanner**: ports, TLS/SNI, basic HTTP info
- 📨 **Telegram MTProto wizard**: secret generation (random-padding `dd` or **FakeTLS `ee`**), `t.me/proxy` link, QR and a ready VPS installer
- 🔐 Password login (HMAC-signed session, 30 days) — default `admin123`

> ⚠️ The Telegram bot / sales flow was removed by design — this is a personal panel.
> ⚠️ Workers cannot host raw TCP: vless traffic flows through the **tunnel worker**, and MTProxy servers run on your own VPS.

### Local

```bash
cp .env.example .env
npm install
npx prisma db push
npm run dev          # http://localhost:3000
npm run dev:cf       # same, with real wrangler bindings (local D1)
```

### Deploy to Cloudflare

Full step-by-step guide: **[DEPLOY-CF.md](DEPLOY-CF.md)**

```bash
npm install
npx wrangler d1 create odyssey-db        # put database_id into wrangler.jsonc
npm run db:d1:remote                     # create tables in the remote D1
npx wrangler deploy                      # or: npm run deploy
```

Or fully automatic: push to `main` with repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` — the GitHub Action deploys for you.

Default password: `admin123` (self-healed on first login against an empty database) — change it in **Settings** after first login.

## License

MIT — see [LICENSE](LICENSE).
