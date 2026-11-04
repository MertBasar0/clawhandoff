# Türkçe başlangıç rehberi

`agent-bridge-mcp`, yerel asistanının bir görevi Robo’ya devretmesini ve Robo kanıt istediğinde **aynı sohbetten** devam etmesini sağlar. Örneğin Robo bir Windows testi isteyebilir. Testi yerel asistan yetkisi kapsamındaki ortamda çalıştırır, doğru commit’i sınadığını kontrol eder ve sonucu köprü üzerinden iletir. Köprü hangi turda kalındığını kaydeder. Görevi açık tutmak ve kanıtın kullanıcının istediği sonucu gösterip göstermediğini değerlendirmek yerel asistanın sorumluluğudur.

Bu rehber ilk devri açık bir Robo sohbetinde, kod değiştirmeden ve PR açmadan yapar. Ayrı bir Gateway oturumu açmak için [İngilizce README](../README.md), tasarım ve yayınlama kuralları için [Türkçe RFC](RFC-v0.2.tr.md) kullanılabilir.

## 1. Köprüyü hazırla

Yerel asistanın çalıştığı ortamda Node.js 22.13 veya üzeri, pnpm ve Git 2.38 veya üzeri gerekir. Depoyu henüz indirmediysen ilk iki komutu da çalıştır.

```sh
git clone https://github.com/MertBasar0/agent-bridge-mcp.git
cd agent-bridge-mcp
pnpm install --frozen-lockfile
pnpm run build
```

Derleme sonunda `dist/cli.js` oluşur. **Önce gerçek sohbete mesaj göndermeden denemek istersen** bu dizinde `node test/helpers/host-acceptance.mjs setup` çalıştır. Çıktıdaki `workspace` dizinini yerel asistanında aç, `mcpServer` ayarını ekle ve `goal` metnini asistana ver. İş bitince `verify` dizisindeki programı ve argümanları çalıştır. Başarı çıktısında `accepted: true`, `sessions: 1` ve `CONTINUE_AUTONOMOUSLY` ile başlayıp `COMPLETE` ile biten adımlar görünür. Bu deneme gerçek Git ve SQLite kullanır, uzak ajanı yerelde taklit eder.

## 2. Mevcut Robo sohbetini bağla

1. Team’e giriş yaptığın Chrome profilinde istediğin sohbeti **tek sekmede** aç. Mesaj kutusunu boş bırak ve adres çubuğundaki tam sohbet URL’sini kopyala.
2. Chrome’da `chrome://inspect/#remote-debugging` sayfasından uzaktan hata ayıklamayı etkinleştir. Chrome yeni bağlantıda izin sorabilir. Tarayıcı yolunda köprü, açık oturumunun erişimini kullanır ve gönderilen mesajlar Team sohbet geçmişine yazılır. [Chrome bağlantı rehberi](https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session)
3. Chrome’un çalıştığı sistemde kurulu Chrome DevTools MCP çalıştırıcısının yolunu bul. Köprü, sayfa kimliği ve yapılandırılmış çıktı desteği kullanır. Projede sınanan sürüm `1.11.0`. [Chrome DevTools MCP kurulumu](https://github.com/ChromeDevTools/chrome-devtools-mcp)

Aşağıdaki içeriği yerel bir `bridge.json` dosyasına kaydet. Linux veya WSL kullanıyorsan örneğin `mkdir -p ~/.config/agent-bridge` ile klasörü oluşturup dosyayı orada tutabilirsin. Örnek adresi gerçek sohbet adresiyle, `command` değerini kendi çalıştırıcı yolunla değiştir. `robo-web` yerel hedef adı, `roboclaw` ise sohbet adresindeki ajan kimliğidir.

```json
{
  "targets": {
    "robo-web": {
      "targetId": "robo-web",
      "transport": "browser",
      "agentId": "roboclaw",
      "sessionUrl": "https://team.example/chat/roboclaw/example-session",
      "browserMcp": {
        "command": "/absolute/path/to/chrome-devtools-mcp",
        "args": ["--no-usage-statistics", "--no-performance-crux"]
      }
    }
  }
}
```

- **Windows Chrome + WSL.** `browserMcp.command` için Windows `node.exe` dosyasının WSL yolunu, ilk argüman için kurulu Chrome DevTools MCP giriş dosyasının Windows yolunu kullan. Köprünün kendi `dist/cli.js` ve `bridge.json` yollarını ise köprüyü başlatan ortamın biçiminde yaz.
- **Özel kurulum yolu.** Control UI `/dashboard` altında kuruluysa ve sohbet adresi `/dashboard/chat/roboclaw/topic` biçimindeyse tarayıcı hedefine `"basePath": "/dashboard"` ekle. Adres iki biçimde yorumlanabiliyorsa ve Control UI kökte kuruluysa `"basePath": "/"` kullan.

Yerel asistanının MCP sunucu ayarlarında **stdio** bağlantısı oluştur. Asistanın beklediği ayar biçiminde sunucuya `agent-bridge` adını ver ve aşağıdaki `command` ile `args` değerlerini gir. Üç yolu kendi mutlak yollarınla değiştir. Asistan bu ayarla köprüyü başlatır. Köprü de `bridge.json` dosyasından hedef sohbeti bulur.

```json
{
  "command": "/absolute/path/to/node",
  "args": [
    "/absolute/path/to/agent-bridge-mcp/dist/cli.js",
    "--config",
    "/absolute/path/to/bridge.json"
  ]
}
```

Codex CLI kullanıyorsan aynı kaydı Linux veya WSL’de tek komutla yapabilirsin. Aşağıdaki örnek depo kökünde olduğunu ve hedef ayarını yukarıdaki klasöre kaydettiğini varsayar.

```sh
codex mcp add agent-bridge -- "$(node -p 'process.execPath')" "$PWD/dist/cli.js" --config "$HOME/.config/agent-bridge/bridge.json"
```

Kayıttan sonra asistanında `bridge_preflight` aracının göründüğünü kontrol et. İlk devirden önce yerel asistana [orkestrasyon yönergesini](../skills/autonomous-handoff/SKILL.md) okut. MCP prompt’larını destekleyen istemcilerde `autonomous-handoff` prompt’unu hedef adı ve görev ile de açabilirsin.

## 3. Bağlantıyı doğrula ve ilk devri yap

Aşağıdaki çağrıları yerel asistanın MCP araçları üzerinden yapar. Önce `bridge_preflight` aracına şu argümanları ver:

```json
{"targetId": "robo-web"}
```

`browserReady: true` seçilen sohbetin okunabildiğini gösterir. Tarayıcı hedefinde `gatewayHealthy: false` beklenen değerdir. Bundan sonraki `bridge_handoff_start` çağrısı **gerçek sohbete bir mesaj gönderir**. Bu örnek, köprünün yayımlanmış bir sürümünde eski başarı raporlarının nasıl ele alındığını sorar:

```json
{
  "targetId": "robo-web",
  "envelope": {
    "schemaVersion": "0.2",
    "requestId": "browser-receipt-review-001",
    "workspaceId": "bridge-docs-example",
    "title": "Eski başarı raporlarını incele",
    "outcome": "Bu commit'te, önceki turun başarı raporunun güncel görevi neden tamamlayamadığını kaynak üzerinden açıkla.",
    "mode": "investigate",
    "publisherOwner": "none",
    "gitContext": {
      "repoId": "MertBasar0/agent-bridge-mcp",
      "pinnedBaseCommitSha": "c210b9022aadbf9a6518ed8582095bab29402526"
    },
    "requestedCapabilities": {
      "allowCodeEdit": false,
      "allowBranchPush": false,
      "allowManagedPublishStage": false
    },
    "acceptanceCriteria": ["Güncel tur işareti ile sonuç bloğu arasındaki ilişkiyi kaynak üzerinden açıkla."]
  }
}
```

Kendi görevin için commit’in tam 40 karakterlik SHA’sını `git rev-parse HEAD` ile al. Yeni görev için yeni bir `requestId` seç. Aynı başlangıç isteğini kurtarırken kimliği ve içeriği koru. Yanıttaki **`handoffId`** tüm sonraki turlarda kullanılır.

## 4. İtiraz geldiğinde aynı işten devam et

| Köprünün döndürdüğü `orchestratorDirective.action` | Yerel asistanın yapacağı işlem |
| --- | --- |
| `POLL_ATTACH` | `bridge_handoff_attach` aracını aynı `handoffId` ile çağır. Bekleme süresinin dolması uzak işi iptal etmez. |
| `CONTINUE_AUTONOMOUSLY` | `reported.blockers` içindeki itirazı belirli commit ve kanıtla karşılaştır. Gerekiyorsa yetkili testi çalıştır. Sonucu `bridge_handoff_continue` ile aynı işe ilet. |
| `COMPLETE` | Kabul ölçütlerini ve dayandıkları kanıtı kontrol et, sonra sonucu bildir. `reported` Robo’nun beyanını, `observed` köprünün Git ve PR üzerinden doğrulayabildiği bilgileri taşır. |
| `ESCALATE_TO_HUMAN` | Teslim belirsizliği, eksik yetki veya tükenen tur bütçesi gibi somut nedeni oku. Gönderim belirsizse önce mevcut sohbetle kaydı karşılaştır. |

Örneğin Robo yukarıdaki kuralın kaynakta nerede uygulandığını sorarsa yerel asistan şu kontrolü yapabilir:

```sh
git grep -n 'terminalBrowserResultJson' c210b9022aadbf9a6518ed8582095bab29402526 -- src
```

İtirazı bu kontrol yanıtlıyorsa `bridge_handoff_continue` çağrısında aşağıdaki gibi commit’e sabitlenmiş bir kaynak ver. `HANDOFF_ID` yerine ilk çağrıdan gelen değeri koy. Çalışma zamanı kanıtı istenmişse testin gerçek sonucunu ve o koşunun kaydını ekle.

```json
{
  "handoffId": "HANDOFF_ID",
  "intent": "counter_evidence_or_followup",
  "message": "Bu commit'te tarayıcı yanıtının son sonuç bloğunu okuyan işlevi kaynakta doğruladım.",
  "evidenceRefs": [{
    "claim": "terminalBrowserResultJson tarayıcı sonucunu yanıtın sonundaki handoff-result bloğundan okur.",
    "sourceRef": "https://github.com/MertBasar0/agent-bridge-mcp/blob/c210b9022aadbf9a6518ed8582095bab29402526/src/browser-turn.ts"
  }]
}
```

## Bağlantı yarıda kesilirse

Chrome izin penceresinin süresi dolduysa doğru sohbet sekmesini açık tut. Köprü hata mesajında veya önceki yanıtta bir `handoffId` verdiyse **aynı kayıtla** `bridge_handoff_attach` çağır ve yeni Chrome istemini onayla:

```json
{"handoffId": "HANDOFF_ID", "waitBudgetMs": 30000}
```

Henüz gönderilmemiş kayıt bu yolla ilk kez gönderilebilir. Kabulü belirsiz bir gönderimde köprü sohbet geçmişinde o turun işaretini arar. `BUSY_ACTIVE_TURN` görülürse açık bir taslak veya devam eden bir Robo yanıtı olup olmadığına bak. Kullanıcının taslağını koru ve sohbet hazır olduğunda mevcut işe bağlan. Yerel kayıtların bulunabilmesi için yeniden bağlanırken aynı `dataDir` dizinini kullan.

Robo’nun raporu aldığını kendi yanıtından, CI’ın durumunu ise ilgili GitHub koşusundan doğrula. Bağlı GitHub hesabının izni ile Robo’nun araçlarının yetkisi ayrı olabilir. Örnekte yayınlama sahibi `none` olduğu için bir PR açma adımı yoktur. PR gerektiren işlerde `local` veya `remote_gated` seçiminin ne zaman ve hangi yetkiyle yapılacağını [yerel ajan kılavuzu](../skills/autonomous-handoff/SKILL.md) açıklar.
