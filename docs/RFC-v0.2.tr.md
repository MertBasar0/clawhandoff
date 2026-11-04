# agent-bridge-mcp mimarisi (RFC v0.2)

Bir OpenClaw ajanı Windows üzerinde derleme kanıtı istediğinde yerel asistan testi çalıştırır ve sonucu aynı uzak oturuma iletir. Köprü, isteğin hangi tura ait olduğunu kaydeder, Git ve PR durumunu doğrular ve yerel asistana bir sonraki adımı bildirir.

Kurulum ve ilk görev için [Türkçe başlangıç rehberini](quickstart.tr.md) kullanın. Bu RFC tasarım kararlarını, uygulanan v0.2 sözleşmesini ve sonraki sürüme bırakılmış seçenekleri açıklar. MCP girdilerinde [şema](https://github.com/MertBasar0/agent-bridge-mcp/blob/c210b9022aadbf9a6518ed8582095bab29402526/src/schema.ts), çıktı alanlarında [TypeScript türleri](https://github.com/MertBasar0/agent-bridge-mcp/blob/c210b9022aadbf9a6518ed8582095bab29402526/src/types.ts) esas alınır.

---

## 1. Görev kimde kalır?

Yerel asistan geliştiricinin makinesinde derleme araçlarına ve test ortamına erişebilir. Uzak OpenClaw ajanı kendi çalışma alanına, kaynak koduna veya yönetilen yayınlama araçlarına erişebilir. Örneğin uzak Linux ajanı bir Windows derlemesinin sonucunu kendi ortamında üretemediğinde kanıt ister.

Yerel asistan önce hangi commit'in sınandığını kontrol eder. Uygun bir test kaydı varsa o kaydı aynı uzak oturuma iletir. Test eksikse kullanıcıdan aldığı yetki kapsamında testi çalıştırır. Kaynakta gerçek bir hata bulursa düzeltmeyi ayrıca doğrular. Böylece kullanıcı her ara sonucu iki ortam arasında taşımak zorunda kalmaz.

Bağlantı yerelden başlatılır. İstek, yanıt ve sonraki adım yerel köprüde kaydedilir. Uzak ajan yerel komut çalıştırma erişimi kazanmaz. Yerel asistan, uzak kodu çalıştırmadan önce kaynağını ve görev yetkisini denetler. İzin isteyen bir tarayıcı, doğrulanamayan bir PR yayını veya çözülemeyen bir kapsam kararı insan müdahalesi gerektirebilir.

---

## 2. Tasarım sırasında değerlendirilen seçenekler

Bu bölüm RFC hazırlanırken incelenen OpenClaw ve Codex sürümlerini anlatır. Tablodaki kaynak yolları ilgili dış deponun o tarihteki yerleşimine aittir. Köprünün bugün sunduğu araçlar 6. bölümde listelenir.

| Mevcut Mekanizma | Kaynak / Davranış Kanıtı | Bu Tasarımla İlişkisi ve Farkı |
| :--- | :--- | :--- |
| **OpenClaw `beam` & `session-share`** | `docs/plugins/beam.md`, `docs/plugins/session-share.md` | Salt-okunur veya tek yönlü transkript paylaşımıdır; görev yürütme ve devam ettirme yapmaz. |
| **OpenClaw `extensions/mcp-relay`** | `extensions/mcp-relay/src/operations.ts:254-478` | `reply.get` üzerinden 50 sn'lik pencerelerle uzun koşuları gözlemleyebilir; ancak paylaşımlı sunucuda varsayılan olarak kapalıdır (`disabled-by-default`) ve yalnızca ham sohbet taşır. Sözleşme, Git nesne doğrulaması, yayınlama kapısı ve otonom çözüm döngüsü içermez. |
| **OpenClaw `@openclaw/codex` & `@openclaw/acpx`** | `extensions/codex/README.md:23`, `extensions/acpx/skills/acp-router/SKILL.md:11-33` | Eşleştirilmiş düğümlerde oturumlar listelenip okunabilir fakat `continue` ve `archive` yalnızca Gateway-yerel makinede çalışır. Uzak Linux Gateway yerel Windows ajanını süremez. |
| **İstemci `edgeAuth` (`trusted-proxy`)** | `docs/gateway/remote.md:162-195` | `cloudflared access token` ile WebSocket yükseltmesinde vekil kimlik doğrulamasını çözer. **Önkoşul:** Sunucu değişikliği gerekmemesi, hedef Gateway'de ilgili RPC'lerin (`sessions.create`, `chat.send`, `agent.wait`, `chat.history`) ve kullanıcı rol izinlerinin zaten açık olmasına bağlıdır. Mevcut `bridge_preflight` sağlık, kimlik erişimi ve ajan listesini kontrol eder; bütün yazma RPC izinlerinin kullanılabilirliğini kanıtlamaz. |
| **Codex `mcp-server` vs `app-server`** | `codex-rs/mcp-server/src/message_processor.rs:475`, `codex-rs/core/src/thread_manager.rs:1366`, `codex-rs/app-server/README.md:20-84` | `codex mcp-server` içindeki `codex-reply` yalnızca bellek-içi (`self.threads`) haritaya bakar; süreç yeniden başlarsa `threadId` kaybolur ve arayüz kullanımdan kaldırılmaktadır. Bu nedenle Faz-2 Codex adaptörü doğrudan **`codex app-server --stdio` (`thread/start`, `thread/resume`, `turn/start`)** üzerine kurulması önerilmiştir. Bu adaptör v0.2 kapsamında değildir. |

---

## 3. Üç Ayrı Güvenlik ve Doğruluk Sözleşmesi

v0.2 mimarisi; **talimat vermeyi**, **ihlali önlemeyi**, **ihlali gözlemlemeyi** ve **kesintiden kurtarmayı** birbirine karıştırmaz:

### 3.1 Yetki ve Yayınlama Sözleşmesi: "Tek Yayınlama Sahibi" (`Single Publisher`)
Modelin istek zarfına yayınlama talebi yazması kendi başına yetki üretmez. Yerel orkestratör mevcut kullanıcı yetkisini, hedef ortamın izinlerini ve görev kapsamını birlikte gözetir. Köprü mod/alan çelişkilerini reddeder; hedef ajanın bütün araç çağrılarını denetleyen bir yetkilendirme servisi değildir. Teknik olarak zorlanamayan kurallar **ajana iletilen çalışma talimatıdır**; kriptografik garanti gibi sunulmaz.

PR açılması istenmeyen bir görevde `publisherOwner: "none"` seçilir. PR isteniyorsa tek bir sahip belirlenir:
1. **`publisherOwner: "local"` (Önerilen Yol):** Uzak ajana inceleme, test ve aday dal üretimi görevi verilir; PR açmaması söylenir. Köprü aday commit'i doğrular, mevcut kullanıcı yetkisi kapsamında yerel sahip yayınlar. Uzak ajanın yayınlama yapamayacağı teknik olarak garanti edilecekse onun araç/kimlik yetkileri ayrıca sınırlandırılmalıdır; bu alan tek başına yetki kaldırmaz.
2. **`publisherOwner: "remote_gated"` (Yönetimli Uzak Bot Kimliği İçin İşbirliğine Dayalı İki Aşama):**
   - **Aşama 1 — aday hazırlığı.** Uzak ajan hazırlığını tamamlar ve `candidateCommitSha` ile erişilebilir `candidateRef` bilgilerini bildirir. Başlangıçta `allowManagedPublishStage` değeri `false` olmalıdır.
   - **Git doğrulaması.** Köprü Git nesnelerinden `observedHeadSha` ve `observedTreeSha` değerlerini okur. Taban olarak `pinnedBaseCommitSha` ile soy ilişkisini, kilitli yolları ve verilmişse beklenen ağacı denetler.
   - **Aşama 2 — yayınlama onayı.** Yerel asistan `AUTHORIZE_REMOTE_PUBLISH` aldıktan sonra kullanıcı yetkisi kapsamında `bridge_handoff_continue` aracını `intent: "authorize_publish"` ve bir `message` ile çağırır. Köprü aynı commit ve açık PR durumunu yeniden kontrol edip onayı aynı uzak oturuma gönderir. Doğrulama başarısızsa köprü bu onay mesajını göndermez; düzeltme veya eskalasyon yönlendirmesi döner. Uzak ajanın ilk aşamada kendi yayınlama aracını çağırmasını önleme garantisi verilmez. *(Not: Yerel `gh` yoluna geçiş asla sessiz bir yedek olarak çalışmaz; uzak servisin inceleme/yetki kurallarını atlamamak için `publisherOwner` değişikliği açık kullanıcı onayına tabidir.)*

### 3.2 Kalıcı Yaşam Döngüsü ve Kesinti Kurtarma Sözleşmesi (`Durability & Reconnect`)
20 dakikalık bir uzak görevin kaderi tek bir açık MCP çağrısına bağlanamaz. Temel yaşam döngüsü kalıcıdır:

```text
bridge_handoff_start ──► [SQLite: handoffId + idempotencyKey ön-kaydı]
                             │
                             ▼
                   (koşu sürüyor: lifecycleStatus="running")
                             │
                             ▼
bridge_handoff_attach ◄──► [Aynı runId üzerinde yeniden bağlanma / uzlaştırma]
                             │
                             ▼
                   lifecycleStatus="settled" (turun yanıtı kaydedildi)
                             │
         ┌───────────────────┴───────────────────┐
         ▼ (çözülebilir engel / kanıt talebi)    ▼ (tamamlandı veya gerçek insan kapısı)
bridge_handoff_continue                   Kullanıcıya Nihai Rapor / Karar Sunumu
```

Zorunlu durum makinesi kuralları:
1. **Ön-Kayıt (*Write-Ahead Intent*):** `handoffId`, `idempotencyKey` ve köprüye ait uzak oturum anahtarı ağ çağrısından **önce** SQLite içine yazılır. Gönderim hakkı atomik olarak alınır; çökme sonrası aynı niyet körlemesine tekrar gönderilmez.
2. **Belirsiz Kesinti (*Uncertain State*):** Kaydedilmiş `runId` varsa `attach` aynı koşuyu gözlemler. Gönderimin kabul edilip edilmediği bilinmiyorsa köprü aynı isteği yeniden göndermez. Kayıtlı oturum geçmişinde gönderilen mesajı ve ilgili koşu kimliğini eşleştirerek toparlamayı dener. Eşleşme yoksa `uncertain` ve somut `ESCALATE_TO_HUMAN` açıklaması döner; yeni oturum veya sonsuz `attach` döngüsü başlatılmaz. Gateway'in tekrar önleme önbelleği yeniden başlatmada veya süre sonunda kaybolabileceği için SQLite'ta aynı `idempotencyKey` bulunması tek başına tekrar güvenliği değildir.
3. **Önbellek ve Arşivleme Gerçekliği:** OpenClaw kaynağında doğrulandığı üzere (`src/gateway/server-methods/session-create-initial-turn.ts:99-108`), önbellekten dönen yanıt da `runStarted: false` üretebilir; ayrıca `sessions.patch(archived: true)` `worktree` temizliğini anında değil GC'ye bırakır (`src/gateway/server-methods/sessions-patch-archive.ts:424`). Bu nedenle köprü `runStarted: false` gördüğünde oturumu körlemesine arşivlemez; kaydedilmiş koşu kimliğini ve ilgili mesaj geçmişini kullanır. Gönderim kabulü belirsiz kaldığında yeniden deneme için yetkili durum kaynağından uzlaştırma gerekir.
4. **Bekleme ve iptal.** `waitBudgetMs` dolduğunda süren bir koşu `lifecycleStatus: "running"` ve `POLL_ATTACH` ile dönebilir. Kabulü doğrulanamayan bir gönderim `uncertain` olabilir. Beklemenin sona ermesi uzaktaki işi iptal etmez. Gateway koşusu `bridge_handoff_abort` ile durdurulabilir. Tarayıcıda yanıtı durdurmak için sohbet arayüzü kullanılır. `localOnly: true` ile iptal, tarayıcı devrinin yalnızca yerel takibini kapatır.
5. **TekUçuş Kilidi (*Single-Flight Serialization*):** Aynı `handoffId` üzerinde aktif veya `uncertain` bir tur varken ikinci bir `bridge_handoff_continue` çağrısı reddedilir (`BUSY_ACTIVE_TURN`).
6. **Tur Kimliği Eşleştirmesi:** Geçmişten yanıt okunurken "son asistan mesajı" varsayımı yapılmaz; ilgili `runId` veya gönderilen tam mesajla bağlantılı koşu aranır. Pencerelenmiş mesaj listesinin uzunluğu kalıcı bir sıra numarası sayılmaz.

### 3.3 Git Bütünlüğü ve Güvenilmeyen İçerik (*Untrusted Git Object*) Sözleşmesi
- **Referansları sabitleme.** Yerel asistan `origin/main` gibi dal adlarını önce kesin commit kimliklerine çözer. Köprü istekteki 40 haneli SHA değerlerini doğrular ve SQLite defterine kaydeder.
- **`Tree-SHA` ve `lockedPaths` Ne Kanıtlar, Ne Kanıtlamaz?**
  - `expectedTreeSha === observedTreeSha`, yalnızca kayıtlı Git ağaç nesnesinin bayt-bayt aynı olduğunu kanıtlar; uzak test sırasında çalışma dizininin temiz olduğunu, aynı bağımlılıkların kurulduğunu veya ara commit'lerde kilitli bir dosyanın değiştirilip geri alınmadığını tek başına kanıtlamaz.
  - Kilit başlangıcı `pinnedSourceCommitSha`, kaynak commit yoksa `pinnedBaseCommitSha` olur. Denetim bu başlangıç ile aday arasındaki net farkı ve **her ara commit'i** kapsar; böylece devir öncesindeki yetkili yerel değişiklikler ihlal sayılmaz, devir sonrasındaki değiştirip-geri-alma girişimleri yakalanır. PR tabanı soy ilişkisi ayrıca kontrol edilir.
- **Çalışma Dizinsiz (*Checkout-Free*) Güvenli İlk Doğrulama:**
  - Uzak/paylaşımlı bir ajanın ittiği dal **güvenilmeyen girdi** kabul edilir.
  - Köprü doğrulamayı kullanıcının aktif çalışma dizininde değil, köprünün yönettiği izole çıplak/ayrı depoda ve **hiçbir dosyayı checkout etmeden** doğrudan Git nesneleri üzerinde yürütür:
    `git fetch --no-recurse-submodules` ve `git diff-tree --no-ext-diff --no-textconv` çağrılarında kancalar kapatılır; izin verilen aktarım protokolleri açıkça seçilir. Dosya adları satır sonu yerine NUL ayırıcıyla okunur.
  - Checkout etmek ve test çalıştırmak ayrı bir güven sınırıdır; yerel alt ajan yazma/test yapacaksa her zaman ayrı bir `git worktree` açılır, kullanıcının yerel kirli çalışma dizini (*uncommitted changes*) asla sessizce `stash` edilmez veya ezilmez.

PR adresi biliniyorsa köprü açık PR'ın başındaki commit'i doğrular. Adres verilmediyse aynı depoda, aynı kaynak dal ve doğrulanmış commit ile tek bir açık PR eşleşmelidir. Hedef dal adı sözleşmede bulunmadığı için ayrıca kontrol edilmelidir.

---

## 4. Yerel asistanın itiraz ve kanıt döngüsü

İlk görevden önce yerel asistana [otonom devir talimatını](../skills/autonomous-handoff/SKILL.md) okutun. İstemci MCP prompt’larını destekliyorsa `autonomous-handoff` prompt’unu hedef ve görevle seçebilirsiniz. Her iki yolda da itirazı değerlendiren, testi çalıştıran ve sonraki aracı çağıran yerel asistandır. Yerel asistan kapandığında köprü kaydı saklar. İş, kaydedilmiş `handoffId` ile sürdürülebilir.

| Robo’nun yanıtı veya köprünün gözlemi | Yerel asistanın yapacağı işlem |
| --- | --- |
| Robo, zaten çalıştırılmış bir test için kanıt istiyor. | Test kaydının ilgili commit’e ait olduğunu doğrular. Aynı işe `bridge_handoff_continue` ile neyin doğrulandığını (`claim`) ve nereden kontrol edilebileceğini (`sourceRef`) gönderir. |
| Test eksik veya kodda gerçek bir hata var. | Kullanıcının verdiği yetki kapsamında izole ortamda testi çalıştırır ya da hatayı düzeltip sınar. Yeni commit yetkili bir dala gönderildiyse `updatedSourceCommitSha` ve `updatedSourceRemoteRef` ile aynı oturumu ilerletir. |
| Kilitli bir yol değişmiş veya adayın Git ağacı beklenenden farklı. | Yayını durdurur, farklılığı bildirir. Düzeltmeye yetkisi varsa sabit kaynak commit’inden sözleşmeye uyan yeni bir aday hazırlar. Kilitli dosyayı sonradan geri alan bir commit, aradaki ihlali silmez. |
| Oturum açma, ek yetki veya kullanıcının kapsam kararı gerekiyor. | Hangi eylemin engellendiğini ve hangi bilginin ya da iznin ilerlemeyi sağlayacağını bildirir. Kabul edilip edilmediği belirsiz bir gönderimi aynı oturumdan uzlaştırır. |

Köprü sunulan `sourceRef` değerlerini saklar. Aynı referansı farklı cümleyle göndermek yeni kanıt sayılmaz. Kanıtın içeriğini yerel asistan doğrular. Aynı engel yeni commit veya farklı bir kanıt referansı olmadan iki tur üst üste sürerse ya da tur bütçesi tükenirse köprü insan müdahalesi ister. `maxAutonomousTurns` varsayılan olarak 5’tir ve ilk turu da içerir. `COMPLETE` geldiğinde yerel asistan kullanıcının kabul ölçütlerini kontrol ederek sonucu bildirir.

---

## 5. İstek ve sonuç zarfları

### 5.1 İstek zarfı (`bridge_handoff_start.envelope`)

```typescript
export interface HandoffEnvelopeV2 {
  schemaVersion: "0.2";
  requestId: string;          // Yeni iş için benzersiz, tekrar denemede aynı kalan kimlik (1–128 karakter)
  workspaceId: string;        // Depo / çalışma alanı kimliği
  title: string;
  outcome: string;

  mode: "investigate" | "implement" | "verify_only" | "publish_unchanged";
  publisherOwner: "none" | "local" | "remote_gated";

  gitContext: {
    repoId: string;                 // ör. "openclaw/openclaw"
    localRepoPath?: string;         // Köprünün okuyabildiği yerel kaynak deposu
    remoteUrlOrPath?: string;       // Aday referansı doğrulamak için fetch kaynağı
    pinnedBaseCommitSha: string;    // Önceden çözülmüş 40 haneli Git commit SHA
    pinnedSourceCommitSha?: string; // Gönderilen erişilebilir commit SHA
    sourceRemoteRef?: string;       // Uzak tarafın fetch edebileceği dal/ref
    expectedTreeSha?: string;       // verify_only / publish_unchanged için doğrudan verilir veya kaynak commit’ten çözülür
    lockedPaths?: string[];         // Kaynak commit'ten sonra ara commit'ler dahil kilitli yollar
  };

  requestedCapabilities: {
    allowCodeEdit: boolean;
    allowBranchPush: boolean;
    allowManagedPublishStage: boolean; // İlk istekte false. Aşama 2 ayrı bir continue çağrısıdır.
  };

  /** Köprünün teknik olarak zorlayamadığı, hedef ajana iletilen çalışma kuralları */
  advisoryInstructions?: Array<{
    instruction: string;
    reason: string;
  }>;

  /** Yalnızca kanıt referansı taşıyan ön bulgular */
  priorEvidence?: Array<{
    claim: string;
    sourceRef: string; // Örneğin sabit CI iş bağlantısı veya commit ve dosya yolu
  }>;

  nonBindingHints?: string[];
  acceptanceCriteria: string[];
}
```
*Doğrulama Kuralı:* `mode === "publish_unchanged"` iken `requestedCapabilities.allowCodeEdit === true` verilirse köprü bunu sessizce değiştirmez; açık `INVALID_CONTRACT_CONFLICT` hatası döner.

### 5.2 Sonuç Zarfı (`HandoffResultEnvelope` v0.2)
Başarılı bir devir çağrısının `content` dizisindeki metin JSON olarak çözümlenir. `reported` uzak ajanın beyanını, `observed` köprünün bağımsız incelemesini içerir. `settled`, o turun yanıtının alındığı anlamına gelir. Görevin kabul ölçütleri ayrıca denetlenir.

```typescript
export interface HandoffResultEnvelopeV2 {
  schemaVersion: "0.2";
  handoffId: string;
  targetId: string;
  remoteSessionKey?: string;
  remoteSessionUrl?: string;
  turnNumber: number;
  runId: string; // Koşu kimliği henüz bilinmiyorsa "unassigned"

  /** İşin yaşam döngüsü durumu */
  lifecycleStatus: "running" | "settled" | "uncertain" | "aborted" | "failed";

  /** 1) REPORTED: Hedef ajanın kendi beyanı (kanıtlanmamış iddia olarak ele alınır) */
  reported?: {
    disposition: "completed" | "needs_evidence" | "blocked" | "ready_for_publish_gate";
    candidateCommitSha?: string;
    candidateRef?: string;
    prUrl?: string;
    summaryDelta: string;
    blockers: string[];
    claimedChecks: Array<{ command: string; exitCode?: number; environment?: string }>;
  };

  /** 2) OBSERVED: Köprünün Git nesneleri, RPC durumu ve GitHub üzerinden bizzat doğruladığı gerçekler */
  observed: {
    reachableRefVerified: boolean;
    observedHeadSha?: string;
    observedTreeSha?: string;
    baseIsAncestor?: boolean;
    treeMatchesExpected?: boolean;
    lockedPathsClean?: boolean;
    violatedPaths?: string[];
    inspectedCommitCount?: number;
    verificationNotes?: string[];
    reconciledPrState: "none" | "open_verified" | "uncertain_in_flight";
    reconciledPrUrl?: string;
  };

  /** Yerel orkestratörün otonom döngüyü bırakmaması için hesaplanan açık yönlendirme */
  orchestratorDirective: {
    action:
      | "POLL_ATTACH"               // Koşu hâlâ sürüyor
      | "CONTINUE_AUTONOMOUSLY"     // Kapsam içi engel/soru; kullanıcıya sormadan kanıtla/çöz ve devam et
      | "AUTHORIZE_REMOTE_PUBLISH"  // İki aşamalı kapı doğrulandı; Aşama-2 yayın onayını gönder
      | "PUBLISH_LOCALLY"           // Doğrulama tam; yerel sahip yayınlayabilir
      | "COMPLETE"                 // Görev sonucu tamamlandı; yerel ajan kabul kanıtını sunar
      | "ESCALATE_TO_HUMAN";        // Yetki dışı karar, çözülemeyen belirsizlik veya tıkanma
    reason: string;
    remainingTurnBudget: number;
  };
}
```

---

## 6. Uygulanan araçlar ve kabul ölçütleri

### 6.1 Faz-1 Kapsamı (Tek Hedef Ailesi, Açık Kurtarma Sınırları)
İlk sürüm tek hedef ailesiyle sınırlıdır. **İşin ve yayınlama durumunun görünür kalması**, belirsizlikte ikinci bir etki oluşturmaktan önce gelir:
- **Hedef Taşıma Adaptörleri (Faz 1):**
  1. **`gateway` (`openclaw-gateway`):** Uzak paylaşımlı `robo` veya yerel OpenClaw Gateway RPC yüzeyi (`sessions.create`, `chat.send`, `agent.wait`, `chat.history`, `chat.abort`).
  2. **`browser` (`chrome-devtools-mcp`):** Cihaz eşleştirmesi (*device pairing*) veya CLI token'ı gerektirmeden, operatörün açık ve oturum açılmış tekil Control UI sohbet sekmesini (`/chat/<agentId>/<session...>` veya `/dashboard/<agentId>/<session...>`) erişilebilirlik ağacı ve salt-okunur DOM projeksiyonu üzerinden sürer. URL birden fazla sohbet rotası olarak okunabiliyorsa tarayıcı hedefinin `basePath` alanı Control UI kurulum yolunu belirtir (örneğin `/dashboard`, kök kurulum için `/`). Köprü güncel turun `Bridge-Reply: <idempotencyKey>` işaretinden sonra, yanıtın sonunda yer alan `handoff-result` bloğunu işler. Açılış ve kapanış satırları girintisiz yazılır. Her istek `Bridge-Turn: <idempotencyKey>` ile başlar ve aynı `sessionUrl` üzerinde eşzamanlı ikinci handoff SQLite tarafından reddedilir.
  *(Yerel `codex app-server --stdio` ve `claude -p --resume` adaptörleri Faz 2'ye ayrılmıştır.)*
- **Yayınlama Kurtarma Sınırı (Faz 1):** Yalnızca **erişilebilir bir Git referansına push edilmiş** işleri yerelde devralır (uzak diskteki push edilmemiş `worktree` dosyalarını kurtarma vaadi Faz 1'de yoktur). Uzak yayınlama `uncertain_in_flight` durumundaysa yeni yayınlama yetkilendirmesi verilmez; boş PR araması tek başına belirsizliği kaldırmaz. Açık PR için tam aday commit eşleşmesi aranır; gövdedeki görev işareti bunun alternatifi değildir. PR metninin üretimi ve gizli bilgi kontrolü yayınlama sahibinin sorumluluğundadır; bu sürüm genel bir metin temizleyici sunmaz.

**Faz-1 MCP Araçları:**
1. **`bridge_preflight`.** Gateway hedefinde bağlantı, kimlik erişimi ve ajan listesi kontrol edilir. Tarayıcı hedefinde `browserReady` doğru sohbet sekmesinin ve yazma alanının bulunduğunu bildirir. Her iki yolda da isteğe bağlı PR araması uyarı amaçlıdır.
2. **`bridge_handoff_start`:** Kalıcı `handoffId` oluşturur, ön-kaydı SQLite'a yazar, sabit commit SHA'larıyla oturumu açar ve kısa bekleme bütçesi (`waitBudgetMs`) içinde bitmezse `lifecycleStatus: "running"` döner.
3. **`bridge_handoff_attach`:** Kesinti, yeniden başlatma veya bekleme bütçesi dolumu sonrasında kaydedilmiş aynı `handoffId` / `runId` koşusunu gözlemler. Kabulü bilinmeyen gönderimi tekrar etmez; geçmişten eşleştirme mümkün değilse belirsizliği ve gerekli uzlaştırmayı bildirir.
4. **`bridge_handoff_continue`.** Aynı `handoffId`, bir `message` ve bir `intent` ister. `counter_evidence_or_followup` kanıt veya yeni doğrulanmış Git bilgilerini iletir. `authorize_publish` önceden doğrulanan aday için ayrı bir yayınlama onayı gönderir.
5. **`bridge_verify_git`:** Checkout yapmadan izole depoda `pinnedBaseCommitSha`, `observedHeadSha`, `observedTreeSha` ve kaynak commit'ten sonraki ara commit'lerde `lockedPaths` kurallarını doğrular.
6. **`bridge_handoff_abort`:** Beklemeyi bırakmaktan bağımsız olarak, Gateway hedeflerinde uzaktaki koşuyu durdurmak veya henüz gönderilmemiş bir turu iptal etmek için çağrılır. Gönderilmiş bir `browser` turu köprü tarafından uzaktan güvenli biçimde durdurulamaz; operatör sohbeti inceledikten sonra `localOnly=true` ile yalnızca yerel takibi serbest bırakabilir.

### 6.2 Faz-1 Birincil Kabul Testi ve Başarı Ölçütleri
Otomatik testler geçici Git depoları ve sahte Gateway/GitHub yanıtları kullanır. Bunlar durum, taşıma ve karar mantığını sınar; gerçek Claude/Codex muhakemesinin veya canlı Gateway yetkilerinin kanıtı değildir.

- **Gerçek Yerel Ajan Kabul Testi:** İzole depoda yayınlama gerektirmeyen bir görev seç. Skill'i yerel asistana yükle. Robo test görevi, sabit commit için yerelde çalıştırılabilen bir kontrolün kanıtını eksik saysın. Yerel ajan gerçek kontrolü çalıştırmalı, sonucu commit'e bağlı yeni `evidenceRefs.sourceRef` ile aynı `handoffId` üzerinden göndermeli; kullanıcı mesaj taşımadan robo kanıtı kabul edip görevi tamamlamalı. Aynı commit için ikinci, farklı bir kanıt isteği de yeni ilerleme sayılmalı. Gerçek komut çıktısı ve aynı oturumdaki devir/yanıt kaydı birlikte saklanmalı.
- **Kesinti Kabul Testi (*Crash-Reconnect Test*):** Uzak `runId` kaydedildikten sonra köprüyü kapatıp yeniden aç; `bridge_handoff_attach(handoffId)` ile aynı koşunun sonucunu al. Gönderim yanıtının kaybolduğu ayrı senaryoda, kabul durumu uzlaştırılamıyorsa görünür `uncertain` sonucu ve sıfır yeni gönderim bekle. Yeni denemeden önce mevcut Gateway durumu incelenmeli.
- **Başarı Metrikleri:**
  1. Görev başına **insan müdahalesi sayısı** (hedef: başlangıç + nihai onay dışında `0`),
  2. Kesinti/zaman aşımı sonrası **kaybolan veya çiftlenen iş/PR sayısı** (hedef: `0`),
  3. **Doğrulanan commit (`observedHeadSha`) ile yayınlanan commit'in birebir eşleşme oranı** (hedef: `%100`).
