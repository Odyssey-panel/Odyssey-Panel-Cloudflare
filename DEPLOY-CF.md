# دیپلوی اودیسه پنل روی Cloudflare Workers + D1 · Deploy to Cloudflare

راهنمای کامل فارسی برای اجرای پنل کاملاً روی Cloudflare — بدون سرور، بدون کانتینر.

> زبان اصلی این راهنما فارسی است؛ دستورها بین‌المللی‌اند.

---

## ۱. پیش‌نیازها

- Node.js 20+ و npm
- یک اکانت Cloudflare (پلن Free کافی است)
- نصب wrangler:

```bash
npm install
npx wrangler login          # مرورگر باز می‌شود؛ لاگین کن
```

## ۲. ساخت دیتابیس D1

```bash
npx wrangler d1 create odyssey-db
```

خروجی یک `database_id` می‌دهد. آن را در **`wrangler.jsonc`** جای `00000000-0000-0000-0000-000000000000` بگذار.

## ۳. ساخت جداول در D1

مایگریشن‌های SQL از روی اسکیمای Prisma ساخته شده‌اند و در پوشه `migrations/` هستند:

```bash
# روی نسخه لوکال (برای تست):
npm run db:d1:local

# روی D1 واقعی (پروداکشن):
npm run db:d1:remote
```

> اگر اسکیمای `prisma/schema.prisma` را تغییر دادی، SQL جدید بساز:
> ```bash
> npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > migrations/0002_your_change.sql
> npm run db:d1:remote
> ```

## ۴. دیپلوی

```bash
npx wrangler deploy        # یا: npm run deploy
```

آدرس `https://odyssey-panel.<your-subdomain>.workers.dev` را باز کن و با رمز `admin123` وارد شو (اولین لاگین روی دیتابیس خالی، خودکار همان پیش‌فرض را می‌سازد). بعد از **تنظیمات** رمز را عوض کن و `Public URL` را روی آدرس workers.dev بگذار تا لینک‌های اشتراک درست ساخته شوند.

### دامنه اختصاصی (اختیاری)

در داشبورد Cloudflare: Workers & Pages → `odyssey-panel` → Settings → Domains & Routes → **Add → Custom domain**. بعد `Public URL` را در تنظیمات پنل به همان دامنه تغییر بده.

---

## ۵. ورکر تونل vless (استقرار یک‌کلیکی)

ورکرهای کلادفلر نمی‌توانند پورت خام TCP داشته باشند؛ به همین دلیل ترافیک vless از یک **ورکر تونل** (vless-over-WebSocket) عبور می‌کند. دو راه داری:

### راه ۱ — از داخل پنل (پیشنهادی)

1. **نودها و ورکرها** → تب **ورکرها** → کارت «استقرار یک‌کلیکی» → دکمه **استقرار ورکر تونل**.
2. یک توکن API بساز: `dash.cloudflare.com` → My Profile → API Tokens → Create Token → قالب **Edit Cloudflare Workers** (یا Custom با مجوز `Workers Scripts:Edit`).
3. توکن را در دیالوگ پنل بچسبان و **استقرار** بزن. پنل خودش:
   - اکانت را تشخیص می‌دهد، subdomain کارگری را فعال می‌کند،
   - ورکر `odyssey-tunnel` را آپلود می‌کند،
   - آدرس `https://odyssey-tunnel.<subdomain>.workers.dev` را در لیست ورکرها ثبت می‌کند.

> توکن فقط در حافظه همان یک درخواست استفاده می‌شود و **در دیتابیس ذخیره نمی‌شود**.

### راه ۲ — دستی (کپی/پیست)

کد ورکر در پنل موجود است: تب ورکرها → «Worker kit» → کپی کد → در داشبورد کلادفلر یک ورکر بساز و Deploy کن → آدرس را با «Add worker» ثبت کن.

سپس هنگام ساخت حساب کاربری، منبع را «ورکر کلادفلر» بگذار و همین ورکر را انتخاب کن.

---

## ۶. پروکسی تلگرام (MTProto)

منوی **پروکسی تلگرام MTProto**:

1. IP عمومی VPS و پورت TCP را وارد کن، **ساخت رمز** را بزن.
2. حالت رمز را انتخاب کن:
   - **پدینگ تصادفی (dd)** — ساده و همیشه کار می‌کند.
   - **FakeTLS (ee)** — ترافیک شبیه TLS به یک دامنه پوشانده می‌شود؛ دامنه را وارد کن (مثلاً `cloudflare.com`).
3. لینک `t.me/proxy` را کپی کن یا QR را اسکن کن.
4. اسکریپت نصب را روی VPS اوبونتو/دبیان با دسترسی root اجرا کن؛ سرویس `odyssey-mtproxy` ساخته می‌شود.

> خودِ ورکر نمی‌تواند سرور MTProto باشد (TCP خام)؛ سرور روی VPS تو اجرا می‌شود و پنل فقط لینک/رمز/نصاب می‌سازد.

---

## ۷. چک سلامت دوره‌ای (جایگزین jobs)

ورکرها همیشه روشن نیستند؛ چک خودکار هر ۵ دقیقه با پینگ این مسیر انجام می‌شود:

```
GET https://<panel-domain>/api/cron?secret=<panelSecret>
```

- `<panelSecret>` در **تنظیمات** پنل دیده می‌شود (همان راز امضای سشن).
- هر سرویس مانیتورینگی (cron-job.org، Better Stack، …) کافی است هر ۵ دقیقه این URL را بزن (کد ۲۰۰).
- وقتی ادمین داشبورد را باز می‌کند، چک‌های تاریخ‌گذشته در پس‌زمینه هم اجرا می‌شوند.

---

## ۸. دیپلوی خودکار با GitHub Actions

در ریپو → Settings → Secrets and variables → Actions، دو سکرت بساز:

| سکرت | مقدار |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | توکن با مجوز **Workers Scripts:Edit** + **D1:Edit** |
| `CLOUDFLARE_ACCOUNT_ID` | Account ID داشبورد کلادفلر (صفحه اصلی اکانت) |

هر push به `main` → build با `opennextjs-cloudflare` → deploy خودکار.

## ۹. نکات فنی

- **دیتابیس**: Prisma با آداپتر رسمی `@prisma/adapter-d1` روی بایندینگ `DB`. در لوکال بدون wrangler، همان SQLite فایلی (`DATABASE_URL`) استفاده می‌شود.
- **nodejs_compat**: در `wrangler.jsonc` فعال است؛ crypto (scrypt/HMAC) روی همین پرچم کار می‌کند.
- **حجم ورکر**: باندل اصلی پنل با OpenNext ساخته می‌شود (`.open-next/worker.js`).
- **بک‌اند داخلی xray و `/vlessws`** در این نسخه حذف شده — به‌جای آن ورکر تونل را استقرار بده (بخش ۵).
- **observability** در wrangler فعال است؛ لاگ‌ها را از `wrangler tail` یا داشبورد ببین.

## ۱۰. عیب‌یابی سریع

| مشکل | راه‌حل |
| --- | --- |
| `database_id is required` موقع deploy | مقدار واقعی را در `wrangler.jsonc` بگذار (بخش ۲) |
| خطای `D1_ERROR: no such table` | `npm run db:d1:remote` را اجرا نکردی (بخش ۳) |
| لینک اشتراک دامنه اشتباه دارد | `Public URL` را در تنظیمات پنل درست کن (بخش ۴) |
| ورود نمی‌شود | رمز پیش‌فرض `admin123`؛ روی دیتابیس پر با رمز جدید، از «فراموشی رمز» راهی نیست — در D1 ردیف `adminPassword` را پاک کن تا دوباره `admin123` شود |
| deploy خطای 10041/10053 | مجوزهای توکن API را چک کن (Workers Scripts:Edit + D1:Edit) |
