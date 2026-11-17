# خودمیزبانی اودیسه روی VPS — بدون کلودفلر (راهنمای فارسی)

این راهنما پنل اودیسه را **کاملاً خارج از کلودفلر** اجرا می‌کند:

- **پنل** روی همان VPS با داکر اجرا می‌شود (Next.js + SQLite — بدون D1، بدون KV، بدون workers.dev)
- **ترافیک** با **VLESS + Reality** روی IP خودِ VPS سرو می‌شود — بدون دامنه، بدون گواهی TLS، بدون CDN
- دیگر هیچ وابستگی‌ای به `workers.dev` وجود ندارد، پس بن/فیلتر شدن workers.dev توسط ISPهای ایران دیگر تأثیری ندارد

چرا این کار؟ چون workers.dev به‌صورت دوره‌ای توسط اپراتورهای ایران بسته می‌شود (با check-host هم دیدیم: بعضی ISPها باز می‌کنند، بعضی کاملاً بسته — ir6 «Unknown host»). با Reality، کاربر مستقیم به IP وی‌پی‌اس وصل می‌شود و DPI فقط یک TLS عادی به یک دامنه واقعی (مثل www.samsung.com) می‌بیند.

---

## ۱. خرید VPS

هر VPS با این مشخصات کافی است:

| مورد | توصیه |
|---|---|
| رم | حداقل 1GB (پیشنهاد 2GB) |
| سی‌پی‌یو | 1 هسته کافی است |
| سیستم‌عامل | Ubuntu 22.04 / 24.04 یا Debian 12 |
| لوکیشن | نزدیک به ایران: ترکیه، امارات، ارمنستان، فنلاند، آلمان |
| پورت 443 | باید باز باشد (اشتراک‌گذاری پورت 443 برای Reality ضروری نیست ولی بهترین انتخاب است) |

اپراتورهایی که کاربران ایرانی معمولاً استفاده می‌کنند و با رمزارز پرداخت می‌پذیرند: **Aeza** (aeza.net)، **VDSina** (vdsina.com)، **4VPS**. بعد از تحریم/بن شدن حساب‌های ابری (مثل کلودفلر)، VPS اختصاصی پایدارترین گزینه است.

> نکته: IP تمیز مهم است — بعد از خرید یک بار از ایران پینگ بگیرید؛ اگر ISP شما IP را بسته بود، از پشتیبانی VPS درخواست تعویض IP کنید.

## ۲. اجرا با یک دستور

روی VPS:

```bash
# ۱) کد پنل
apt update && apt install -y git
git clone https://github.com/Odyssey-panel/Odyssey-Panel-Cloudflare.git
cd Odyssey-Panel-Cloudflare

# ۲) نصب کامل (داکر + پنل + ایکس‌ری)
sudo bash deploy/vps/install.sh
```

اسکریپت نصب به‌ترتیب این کارها را می‌کند:

1. داکر را (اگر نیست) نصب می‌کند
2. پنل را می‌سازد و بالا می‌آورد — دیتابیس SQLite روی والوم `panel-data` ذخیره می‌شود
3. با پسورد ادمین (پیش‌فرض `admin123`) لاگین می‌کند
4. IP عمومی همان سرور را به‌عنوان بک‌اند Reality در تنظیمات پنل ثبت می‌کند (`vpsHost`)
5. کانفیگ سرور xray را از پنل می‌گیرد و کانتینر xray را روی پورت 443 بالا می‌آورد

پایان نصب:

```
Panel   : http://SERVER_IP:3000
Reality : vless روی SERVER_IP:443  (SNI: www.samsung.com)
```

## ۳. تنظیمات اولیه پنل

1. `http://SERVER_IP:3000` را باز کنید و لاگین کنید
2. **Settings → Panel** → پسورد ادمین را عوض کنید (مهم!)
3. **Settings → VPS / Reality server** → IP سرور پر شده است؛ SNI را می‌توانید تغییر دهید (پیشنهاد: `www.samsung.com` یا `www.microsoft.com` — سایت‌هایی با TLS1.3 که در ایران فیلتر نیستند)
4. برای HTTPS داشتن روی خود پنل (اختیاری): Caddy یا Nginx با دامنه جلوی پورت 3000 بگذارید — یا فقط از IP استفاده کنید (ترافیک پنل کم است و ریسک کم)

## ۴. ساخت کاربر

دو راه:

- **سریع‌ترین (Fast mode):** در دیالوگ «New config» فقط اسم بنویسید و تیک Fast mode را بزنید — چون `vpsHost` تنظیم شده، خودکار یک کانفیگ **VLESS · Reality** روی VPS می‌سازد
- **دستی:** در تب «Server & IP» حالت **«VPS · Reality»** را انتخاب کنید، IP سرور و SNI را وارد کنید

لینک اشتراک هر کاربر در صفحه `/s/<token>` با QR آماده است — v2rayNG / Hiddify / Streisand همه Reality را پشتیبانی می‌کنند.

## ۵. بعد از هر تغییر در کانفیگ‌ها

هر وقت کاربر جدید ساختید یا کاربری را حذف/ویرایش کردید، کانفیگ سرور xray را دوباره بگیرید:

```bash
cd Odyssey-Panel-Cloudflare
# لاگین ادمین و ذخیره کوکی
curl -s -c /tmp/ck -H 'content-type: application/json' \
  -d '{"password":"YOUR_ADMIN_PASSWORD"}' http://127.0.0.1:3000/api/auth/login
# خروجی گرفتن کانفیگ جدید
curl -s -b /tmp/ck http://127.0.0.1:3000/api/admin/vps/xray-config > deploy/vps/xray/config.json
# ری‌استارت ایکس‌ری
docker compose -f deploy/vps/docker-compose.yml restart xray
```

(می‌توانید این سه خط را در cron بگذارید تا خودکار شود.)

## ۶. عیب‌یابی

| مشکل | راه‌حل |
|---|---|
| پنل بالا نمی‌آید | `docker compose -f deploy/vps/docker-compose.yml logs panel` |
| xray استارت نمی‌شود | `docker compose -f deploy/vps/docker-compose.yml logs xray` — معمولاً پورت 443 اشغال است (`ss -ltnp | grep 443`) |
| کانفیگ وصل نمی‌شود ولی پینگ دارد | SNI را عوض کنید (بعضی ISPها بعضی دامنه‌ها را می‌بندند)؛ در v2rayNG هم `fragment` را می‌توان روی همین کانفیگ فعال کرد |
| سرعت کم | تست IP تمیز بودن: `mtr` یا `ping` از ایران؛ اگر بد بود از پشتیبانی VPS تعویض IP بخواهید |
| فراموشی پسورد ادمین | `docker compose down` و والوم جدید: `docker volume rm deploy-vps_panel-data` (دیتا پاک می‌شود!) |

## ۷. معماری

```
phone (v2rayNG/Hiddify)
   │  VLESS+Reality (TCP 443, uTLS chrome fingerprint)
   ▼
VPS: xray container (config.json از پنل)
   ├─ inbound: vless-reality 443 (SNI قرضی: www.samsung.com)
   └─ outbound: freedom → اینترنت
VPS: panel container (Next.js standalone + SQLite)
   └─ /api/admin/vps/xray-config → تولید config.json از جدول Proxy
```

- کلیدهای Reality (X25519) یک‌بار در پنل ساخته و در جدول `Setting` (کلید `realityKeys`) ذخیره می‌شوند؛ کلید خصوصی فقط داخل پنل می‌ماند، کلید عمومی داخل لینک‌های `vless://...?security=reality&pbk=...` می‌رود
- ترافیک پنل و ترافیک VPN از هم جدا هستند: پنل فقط کانفیگ/اشتراک می‌دهد، دیتا از xray رد می‌شود → سرعت واقعی خط VPS (بدون محدودیت CPU درخواست‌های Workers)

## ۸. مهاجرت از استقرار فعلی کلودفلر

کاربران فعلی چیزی از دست نمی‌دهند: لینک اشتراک‌شان بعد از مهاجرت همان URL پنل روی VPS است و کانفیگ جدید Reality را خودکار می‌گیرند. ترتیب پیشنهادی:

1. VPS را با این راهنما بالا بیاورید
2. در پنل جدید، همان اسم کاربرهای قبلی را بسازید (یا از Backup card خروجی/ورودی بگیرید)
3. لینک اشتراک جدید را برای کاربرها بفرستید (یک بار آپدیت اشتراک در کلاینت کافی است)
4. بعد از چند روز که همه مهاجرت کردند، workerهای کلودفلر را متوقف کنید
