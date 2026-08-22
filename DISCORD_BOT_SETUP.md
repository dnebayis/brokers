# Discord holder doğrulama botu — kurulum rehberi

Bot sunucusuzdur: Discord'un Interactions webhook'u doğrudan canlı siteye bağlanır,
yani ayrıca barındırılacak bir bot süreci yoktur. Kod frontend ile birlikte deploy
edilir; aşağıdakiler tek seferlik sahip tarafı kurulumudur (~10 dakika). Bot token'ını
aşağıda adı geçen yerler dışında HİÇBİR yere yapıştırma.

## 1. Discord uygulamasını oluştur
1. https://discord.com/developers/applications → **New Application** → bir isim ver (ör. "Coattail Verify").
2. **Application ID** ve **Public Key** değerlerini not al (General Information sayfası).
3. **Bot** sekmesi → **Reset Token** → token'ı kopyala (yalnızca bir kez gösterilir).
4. Bot sekmesinde tüm privileged intent'ler KAPALI kalsın (hiçbiri gerekmiyor).

## 2. Botu davet et ve rolü oluştur
1. Sunucunda **Brokerage** adında bir rol oluştur (veya mevcodu kullan) ve rol ID'sini
   not al (Server Settings → Roles → sağ tık → Copy Role ID; görünmüyorsa Discord
   ayarlarından Developer Mode'u aç). **Sunucu (guild) ID**'sini de kopyala.
2. Davet linki — APP_ID'yi değiştir:
   `https://discord.com/oauth2/authorize?client_id=APP_ID&scope=bot%20applications.commands&permissions=268435456`
   (268435456 = Manage Roles — botun ihtiyaç duyduğu tek yetki.)
3. ÖNEMLİ: Server Settings → Roles'ta botun kendi rolünü Brokerage rolünün ÜSTÜNE
   sürükle — Discord bir bota yalnızca kendi rolünün altındaki rolleri verdirtir.

## 3. Vercel ortam değişkenleri (Project → Settings → Environment Variables)
| isim | değer |
|---|---|
| `DISCORD_BOT_TOKEN` | 1.3'teki bot token'ı |
| `DISCORD_PUBLIC_KEY` | 1.2'deki Public Key |
| `DISCORD_GUILD_ID` | sunucu ID'n |
| `DISCORD_ROLE_BROKERAGE` | Brokerage rol ID'si |
| `VERIFY_STATE_SECRET` | uzun rastgele bir dizi (ör. `openssl rand -hex 32`) |
| `RECHECK_SECRET` | başka bir uzun rastgele dizi |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Upstash Redis'ten (ücretsiz plan). ŞİDDETLE önerilir: doğrulama adres-tabanlı (imzasız) olduğu için iki güvenlik önlemi de KV'ye dayanır — "bir adres yalnızca bir hesaba bağlanır" kilidi ve satan cüzdanlardan rolü geri alan günlük tarama. KV olmadan herkes bir holder'ın herkese açık adresini kullanabilir. |

Kaydettikten sonra redeploy et (env'ler bir sonraki build'de geçerli olur).

## 4. Discord'u siteye yönlendir
Developer Portal → uygulaman → General Information → **Interactions Endpoint URL**:
`https://www.coattail.cash/api/discord/interactions`
Discord kaydederken bir test ping'i atar — yalnızca env'li deployment canlıysa kabul eder.

## 5. Slash komutunu kaydet + günlük taramayı aç (GitHub)
```bash
gh secret set DISCORD_APPLICATION_ID
gh secret set DISCORD_BOT_TOKEN
gh secret set RECHECK_SECRET
gh variable set DISCORD_RECHECK_ENABLED --body "1"
gh workflow run discord-register-commands
```
(her `gh secret set` değeri sorar — değeri oraya yapıştır, komut satırına yazma)

## Bitti — üyeler için akış
Sunucuda `/verify` → kişiye özel tek kullanımlık link → coattail.cash/verify →
**cüzdan adresini yapıştır** (bağlantı yok, imza yok) → zincirde bakiye kontrolü →
Brokerage rolü. Her adres ömür boyu YALNIZCA BİR Discord hesabını doğrulayabilir
(ilk gelen alır) ve günlük tarama, artık Broker tutmayan cüzdanlardan rolü geri alır.

Adres-tabanlı doğrulamanın bilinen tavizi: adresler kamuya açık bilgidir; teoride bir
holder olmayan kişi, gerçek holder'dan ÖNCE onun adresini sahiplenebilir. Kilit her
adresi tek hesapla sınırlar; Brokerage rolü kozmetik kalmalı (kanal erişimi, rozet) —
asla değer taşıyan bir yetkiye bağlanmamalı.
