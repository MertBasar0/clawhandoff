# Yerel-Merkezli Otonom Ajan Devir, Uzlaştırma ve Doğrulama Köprüsü (`agent-bridge-mcp`)
**Bağımsız Proje Sunumu, Saha Analizi ve MVP Mimari Tasarım Dokümanı (RFC v0.2 — Kaynak Doğrulamalı Revizyon)**

> **Bu Dokümanı Okuyan Yapay Zekâ Asistanları İçin Bağlam Notu:**
> Bu doküman; geliştiricinin yerel iş istasyonundaki asistanlarla (**Claude Code**, **Codex**, **yerel OpenClaw**) uzak/paylaşımlı OpenClaw Gateway ajanlarının (**`robo`**) insanı arada manuel kopyala-yapıştır ve ZIP kuryesi (*meat proxy*) olarak kullanmadan **otonom bir kanıt ve çözüm döngüsü** yürütmesini sağlayan `agent-bridge-mcp` projesinin **v0.2 mimari şartnamesidir**.
>
> **v0.2 Revizyon Özeti:** İlk akran incelemesi (*peer review*) ve doğrudan kaynak kodu doğrulamaları (`openclaw` ve `codex` depoları) sonucunda:
> 1. Köprünün yalnızca "mesaj götürüp getiren pasif bir boru" olarak kalmaması için **Otonom Orkestrasyon ve Karşı-Kanıt Döngüsü (`Autonomous Resolution Loop`)** birinci sınıf yürütme sözleşmesi haline getirildi.
> 2. "İhlali tespit etmek", "ihlali yayınlamadan önce önlemek" ve "kesintiden sonra aynı işe yeniden bağlanmak" birbirinden ayrıldı; **Tek Yayınlama Sahibi + İki Aşamalı Yayınlama Kapısı (`prepare_only` -> `verify` -> `authorize_publish`)** eklendi.
> 3. Görev yaşam döngüsü tek bir uzun MCP çağrısından koparılarak **`start -> handoffId -> attach/status -> continue`** durum makinesine bağlandı (`cancel_wait` ile `abort_remote` ayrıldı).
> 4. Kaynak kodu kanıtlarına dayanarak `runStarted: false` önbellek davranışı (`src/gateway/server-methods/session-create-initial-turn.ts:99-108`), GC tabanlı `worktree` arşivleme (`src/gateway/server-methods/sessions-patch-archive.ts:424`) ve Codex tarafında bellek-içi `mcp-server` yerine kalıcı oturum destekleyen **`codex app-server --stdio` (`thread/resume`)** (`codex-rs/mcp-server/src/message_processor.rs:475`, `codex-rs/core/src/thread_manager.rs:1366`, `codex-rs/app-server/README.md:20-84`) düzeltmeleri işlendi.
> 5. Çıktı şemasında model beyanı (`reported`) ile köprünün kriptografik/süreçsel gözlemi (`observed`) kesin olarak ayrıldı; Faz-1 MVP kapsamı daraltılıp sertleştirildi.

---

## 1. Fikrin Özeti ve Ürünün Asıl Vaadi

### 1.1 Problem: Yalnızca Dosya Taşımak Değil, "İtiraz ve Kanıt Ping-Pongu"
Geliştirici aynı anda iki farklı ortamı birlikte kullanmaktadır:
1. **Yerel İş İstasyonu Ajanları (Claude Code, Codex, Yerel OpenClaw):** Windows masaüstü + WSL2 gibi yerel derleyicilere (`MSBuild`, WinUI, `ISCC.exe` Inno Setup, yerel GUI testleri) doğrudan erişen ortam.
2. **Uzak Paylaşımlı OpenClaw Gateway Ajanları (`robo`):** Cloudflare Access (`trusted-proxy`) arkasındaki yüksek kaynaklı Linux sunucusunda çalışan, hazır `worktree` havuzuna ve yönetimli PR araçlarına sahip olan ancak geliştiricinin yerel araç zincirini göremeyen ortam.

İnsanı asıl yoran şey yalnızca ilk devir mesajını taşımak değildir; **devirden sonra başlayan çok turlu itiraz/doğrulama ping-pongudur**:
- Uzak ajan (`robo`), aslında yerel commit'te zaten karşılanmış bir koşul için *"Windows derleme kanıtı eksik, ilerleyemem"* diyerek durur,
- Veya Linux ortamında yanlış bir varsayımla yerel kodda olmayan bir aksaklık iddia eder ya da gerçekten küçük bir Linux test pürüzü bulur,
- Veya "dalı değiştirme" denmesine rağmen derleyemediği `.iss` dosyasını değiştirip bozuk PR açar,
- Veya yönetimli yayınlama adımı (`github_publish`) karakter/yaşam döngüsü hatasıyla belirsiz (*uncertain*) kesilir.

Eğer kurulan sistem yalnızca "mesajı uzaktaki ajana ilet ve gelen cevabı kullanıcıya göster" düzeyinde kalırsa, geliştirici bu kez de **"onay ve yönlendirme kuryesi"** olmaya devam eder.

### 1.2 Temel Fikir: Yerel-Merkezli Otonom Orkestrasyon ve Doğrulama Köprüsü
`agent-bridge-mcp`, geliştiricinin kendi makinesinde çalışan durum bilgili (*stateful*) bir MCP sunucusu **ve** birincil yerel asistana bağlanan **Otonom Orkestratör Yürütme Sözleşmesidir**:

1. **Ters Çevrilmiş Güvenlik Sınırı (`Outbound-Only`):** Paylaşımlı uzak sunucu geliştiricinin bilgisayarına asla bağlanamaz ve komut çalıştıramaz. Tüm bağlantılar yerelden dışarıya açılır.
2. **Otonom Çözüm Döngüsü:** Uzak ajandan bir engel, itiraz veya ek kanıt talebi döndüğünde yerel orkestratör asistan bunu hemen kullanıcıya paslamaz. İtirazı yerel kod, sabit commit kimlikleri ve test çıktılarıyla **kanıt temelli** değerlendirir:
   - İddia yanlışsa veya koşul zaten sağlanmışsa sabit commit'e bağlı kanıtı derleyip **aynı uzak oturuma** (`continue`) sunar.
   - Gerçek ve yetki dahilinde çözülebilir bir eksiklik varsa yerelde testi/derlemeyi/onaylı düzeltmeyi çalıştırır, doğrular ve aynı uzak oturumu ilerletir.
   - Kullanıcıya yalnızca **tamamlanmış iş**, **yetki kapsamı dışındaki gerçek kararlar** (yeni ürün/şema/yapılandırma kararı, süresi dolmuş kimlik oturumu) veya **ilerleme üretmeyen somut tıkanma** (üst üste tekrar eden aynı engel) taşınır.
3. **Tespit Değil, Yayınlama Öncesi Önleme (`Single Publisher Gate`):** Uzak ajanın kilitli dosyaları bozup PR açmasını sonradan yakalamak yerine, yayınlama yetkisi tek bir sahipte toplanır ve commit/Tree-SHA doğrulanmadan hiçbir PR açılmaz.

---

## 2. Mevcut Çözümlerle Doğrulanmış Karşılaştırma

| Mevcut Mekanizma | Kaynak / Davranış Kanıtı | Bu Tasarımla İlişkisi ve Farkı |
| :--- | :--- | :--- |
| **OpenClaw `beam` & `session-share`** | `docs/plugins/beam.md`, `docs/plugins/session-share.md` | Salt-okunur veya tek yönlü transkript paylaşımıdır; görev yürütme ve devam ettirme yapmaz. |
| **OpenClaw `extensions/mcp-relay`** | `extensions/mcp-relay/src/operations.ts:254-478` | `reply.get` üzerinden 50 sn'lik pencerelerle uzun koşuları gözlemleyebilir; ancak paylaşımlı sunucuda varsayılan olarak kapalıdır (`disabled-by-default`) ve yalnızca ham sohbet taşır. Sözleşme, Git nesne doğrulaması, yayınlama kapısı ve otonom çözüm döngüsü içermez. |
| **OpenClaw `@openclaw/codex` & `@openclaw/acpx`** | `extensions/codex/README.md:23`, `extensions/acpx/skills/acp-router/SKILL.md:11-33` | Eşleştirilmiş düğümlerde oturumlar listelenip okunabilir fakat `continue` ve `archive` yalnızca Gateway-yerel makinede çalışır. Uzak Linux Gateway yerel Windows ajanını süremez. |
| **İstemci `edgeAuth` (`trusted-proxy`)** | `docs/gateway/remote.md:162-195` | `cloudflared access token` ile WebSocket yükseltmesinde vekil kimlik doğrulamasını çözer. **Önkoşul:** Sunucu değişikliği gerekmemesi, hedef Gateway'de ilgili RPC'lerin (`sessions.create`, `chat.send`, `agent.wait`, `chat.history`) ve kullanıcı rol izinlerinin zaten açık olmasına bağlıdır; `bridge_preflight` bunu varsaymaz, açıkça sınar. |
| **Codex `mcp-server` vs `app-server`** | `codex-rs/mcp-server/src/message_processor.rs:475`, `codex-rs/core/src/thread_manager.rs:1366`, `codex-rs/app-server/README.md:20-84` | `codex mcp-server` içindeki `codex-reply` yalnızca bellek-içi (`self.threads`) haritaya bakar; süreç yeniden başlarsa `threadId` kaybolur ve arayüz kullanımdan kaldırılmaktadır. Bu nedenle Faz-2 Codex adaptörü doğrudan **`codex app-server --stdio` (`thread/start`, `thread/resume`, `turn/start`)** üzerine kurulur. |

---

## 3. Üç Ayrı Güvenlik ve Doğruluk Sözleşmesi

v0.2 mimarisi; **talimat vermeyi**, **ihlali önlemeyi**, **ihlali gözlemlemeyi** ve **kesintiden kurtarmayı** birbirine karıştırmaz:

### 3.1 Yetki ve Yayınlama Sözleşmesi: "Tek Yayınlama Sahibi" (`Single Publisher`)
Modelin istek zarfına `canOpenDraftPr: true` yazması kendi başına yetki üretmez. **Etkin yetki**; `(kullanıcı yapılandırma politikası) ∩ (hedef ortamın gerçek izinleri) ∩ (görev zarfındaki talep)` kesişimidir. Köprünün teknik olarak zorlayamadığı kurallar dokümanda ve şemada açıkça **"ajana iletilen çalışma talimatı (`advisoryInstruction`)"** olarak adlandırılır; kriptografik garanti gibi sunulmaz.

`publish_unchanged` garantisinin PR açıldıktan sonra delinmemesi için her görevde **tek bir `publisherOwner` (`"local"` veya `"remote_gated"`)** seçilir:
1. **`publisherOwner: "local"` (Varsayılan ve En Güvenli Yol):** Uzak ajan (`robo`) yalnızca inceleme, Linux test kanıtı ve gerekirse aday dal/commit üretir; **PR açma yetkisi yoktur**. Köprü aday commit'i yerelde nesne düzeyinde doğrular ve PR'ı yerel sahip açar (veya kullanıcı onayına sunar).
2. **`publisherOwner: "remote_gated"` (Yönetimli Uzak Bot Kimliği Gerektiğinde İki Aşamalı Kapı):**
   - **Aşama 1 (`prepare_only`):** Uzak ajan incelemesini/hazırlığını tamamlar, erişilebilir uzak dal referansını ve aday `headSha` / `treeSha` değerini döner; **henüz `github_publish` çağırmaz**.
   - **Doğrulama Kapısı:** Yerel köprü `git fetch` ile nesneleri çeker; sabit `baseCommitSha`, `expectedTreeSha` ve `lockedPaths` kurallarını doğrular.
   - **Aşama 2 (`authorize_publish`):** Yalnızca doğrulama tam geçerse köprü aynı uzak oturuma **o sabit `headSha` için** yayınlama onay turunu gönderir. Doğrulama başarısızsa PR hiç açılmadan döngü durdurulur veya düzeltme turuna girilir. *(Not: Yerel `gh` yoluna geçiş asla sessiz bir yedek olarak çalışmaz; uzak servisin inceleme/yetki kurallarını atlamamak için `publisherOwner` değişikliği açık kullanıcı onayına tabidir.)*

### 3.2 Kalıcı Yaşam Döngüsü ve Kesinti Kurtarma Sözleşmesi (`Durability & Reconnect`)
20 dakikalık bir uzak görevin kaderi tek bir açık MCP çağrısına bağlanamaz. Temel yaşam döngüsü kalıcıdır:

```text
bridge_handoff_start ──► [SQLite: handoffId + idempotencyKey ön-kaydı]
                             │
                             ▼
                   (kısa bekleme bütçesi dolarsa: status="running" döner)
                             │
                             ▼
bridge_handoff_attach ◄──► [Aynı runId üzerinde yeniden bağlanma / uzlaştırma]
                             │
                             ▼
                   status="settled" (observed + reported zarfı)
                             │
         ┌───────────────────┴───────────────────┐
         ▼ (çözülebilir engel / kanıt talebi)    ▼ (tamamlandı veya gerçek insan kapısı)
bridge_handoff_continue                   Kullanıcıya Nihai Rapor / Karar Sunumu
```

Zorunlu durum makinesi kuralları:
1. **Ön-Kayıt (*Write-Ahead Intent*):** `handoffId` ve `idempotencyKey` ağ çağrısı yapılmadan **önce** `bridge-state.sqlite` içine `dispatch_pending` olarak yazılır.
2. **Belirsiz Kesinti (*Uncertain State*):** Ağ kopması, süreç kapanması veya zaman aşımında durum `uncertain` kalır; köprü **asla** otomatik yeni oturum veya yeni iş başlatmaz. Önce `sessions.describe` ve `runId` eşleşmeli `chat.history` ile uzlaştırma yapar.
3. **Önbellek ve Arşivleme Gerçekliği:** OpenClaw kaynağında doğrulandığı üzere (`src/gateway/server-methods/session-create-initial-turn.ts:99-108`), önbellekten dönen yanıt da `runStarted: false` üretebilir; ayrıca `sessions.patch(archived: true)` `worktree` temizliğini anında değil GC'ye bırakır (`src/gateway/server-methods/sessions-patch-archive.ts:424`). Bu nedenle köprü `runStarted: false` gördüğünde oturumu körlemesine arşivlemez; önce oturum durumunu ve mesaj geçmişini uzlaştırır, yalnızca ilk turun gerçekten düşmediği kanıtlanırsa kontrollü yeniden deneme önerir.
4. **Beklemeyi Bırakmak != İşi Durdurmak:** Yerel MCP çağrısının bekleme süresinin dolması (`cancel_wait` / `waitBudgetMs` bitimi) uzaktaki koşuyu iptal etmez; yalnızca `status: "running"` döner. Uzaktaki işi gerçekten durdurmak ayrı bir `bridge_handoff_abort` çağrısı gerektirir.
5. **TekUçuş Kilidi (*Single-Flight Serialization*):** Aynı `handoffId` üzerinde aktif veya `uncertain` bir tur varken ikinci bir `bridge_handoff_continue` çağrısı reddedilir (`BUSY_ACTIVE_TURN`).
6. **Tur Kimliği Eşleştirmesi:** Geçmişten yanıt okunurken "son asistan mesajı" varsayımı yapılmaz; ilgili `runId` / tur zaman damgası ve sıra numarasıyla eşleştirme yapılır.

### 3.3 Git Bütünlüğü ve Güvenilmeyen İçerik (*Untrusted Git Object*) Sözleşmesi
- **Hareketli Referans Yasağı:** `origin/main` gibi hareketli dal adları görev başlangıcında kesin commit kimliğine (`pinnedBaseCommitSha`, `pinnedSourceCommitSha`) çözülür ve SQLite defterine kaydedilir.
- **`Tree-SHA` ve `lockedPaths` Ne Kanıtlar, Ne Kanıtlamaz?**
  - `expectedTreeSha === observedTreeSha`, yalnızca kayıtlı Git ağaç nesnesinin bayt-bayt aynı olduğunu kanıtlar; uzak test sırasında çalışma dizininin temiz olduğunu, aynı bağımlılıkların kurulduğunu veya ara commit'lerde kilitli bir dosyanın değiştirilip geri alınmadığını tek başına kanıtlamaz.
  - Ara commit ihlallerini de yakalamak için `lockedPaths` denetimi yalnızca uçtan uca `base..head` farkına değil, `git log --format=%H <pinnedBase>..<observedHead>` içindeki **her ara commit'e** uygulanır.
- **Çalışma Dizinsiz (*Checkout-Free*) Güvenli İlk Doğrulama:**
  - Uzak/paylaşımlı bir ajanın ittiği dal **güvenilmeyen girdi** kabul edilir.
  - Köprü doğrulamayı kullanıcının aktif çalışma dizininde değil, köprünün yönettiği izole çıplak/ayrı depoda ve **hiçbir dosyayı checkout etmeden** doğrudan Git nesneleri üzerinde yürütür:
    `git -c core.hooksPath=/dev/null -c protocol.allow=user -c submodule.recurse=false fetch --no-recurse-submodules <remote> <ref>`
    ve ardından `git diff-tree --no-ext-diff --no-textconv -r <base> <head>`.
  - Checkout etmek ve test çalıştırmak ayrı bir güven sınırıdır; yerel alt ajan yazma/test yapacaksa her zaman ayrı bir `git worktree` açılır, kullanıcının yerel kirli çalışma dizini (*uncommitted changes*) asla sessizce `stash` edilmez veya ezilmez.

---

## 4. Otonom Orkestratör Döngüsü (`Autonomous Resolution Loop`)

Köprünün yalnızca "tekil mesaj arayüzü" olarak kalmaması için sistem iki parçayı birlikte sunar: **MCP Araçları** + **Orkestratör Yürütme Sözleşmesi (`SKILL.md` + Araç Çıktısı Yönergeleri)**.

### 4.1 Yerel Orkestratörün Zorunlu Davranış Kuralları
Birincil yerel asistan (`Claude Code`, `Codex` veya `yerel OpenClaw`) bir görevi `robo`'ya devrettiğinde **görevin sahibi yerel orkestratördür**:

1. **Ham Cevap Aktarıcılığı Yasaktır:** Uzak ajandan dönen bir itirazı, soruyu veya doğrulama talebini değerlendirmeden kullanıcıya *"Robo şöyle dedi, ne yapalım?"* diye taşımaz.
2. **Kanıt Temelli İtiraz Sınıflandırması:** Uzak yanıt geldiğinde yerel orkestratör bunu dört sınıftan birine ayırır:
   - **Sınıf A — Yanlış Varsayım veya Zaten Karşılanmış Koşul:** (Örn. *"Windows derleme kanıtı eksik"* dendi ama kanıt `pinnedSourceCommitSha` için zaten alındı veya yerelde doğrulanabilir). Yerel ajan her itirazı körlemesine reddetmez; kanıtın gerçekten ilgili commit'e ait olduğunu kontrol eder ve kanıt referanslarıyla `bridge_handoff_continue` çağırarak aynı uzak oturumu ilerletir.
   - **Sınıf B — Yetki Dahilinde Çözülebilir Gerçek Eksik / Hata:** Uzak ajan gerçek bir derleme/test/kod hatası bulduysa ve düzeltme etkin yetki kapsamındaysa, yerel ajan düzeltmeyi izole yerel ortamda yapar, test eder, yeni commit'i iter ve aynı uzak oturuma yeni `pinnedSourceCommitSha` + kanıtla döner.
   - **Sınıf C — Sözleşme İhlali (`lockedPaths` veya `expectedTreeSha` Sapması):** Köprünün `observed` alanında tespit ettiği ihlali uzak ajana somut fark listesiyle bildirip sabit commit'e dönmesini ister veya yerel yayınlama sahibine düşer.
   - **Sınıf D — Gerçek İnsan Kapısı (*Human Gate*):** Yalnızca şu durumlarda döngüyü durdurup kullanıcıya sorar: (i) Görev başarıyla bitti, (ii) Kapsam/ürün/şema/yetki sınırını aşan bir karar gerekiyor, (iii) Kimlik doğrulama oturumu (`cloudflared access login`) düştü, (iv) **İlerleme Durması (*Stagnation*):** Arka arkaya 2 tur boyunca ne yeni bir commit ne yeni bir test kanıtı üretildi ve aynı engel tekrarlandı (`sameBlockerStreak >= 2`) veya toplam otonom tur bütçesi (`maxAutonomousTurns`, varsayılan `5`) doldu.
3. **Daraltılmış Onay Kuralı:** Hedef ajanlara verilen talimat *"asla soru sorma"* değil; **"Zaten yetkilendirilmiş kapsam içi adımlar için yeniden onay isteme ('başlayayım mı?' deme); ancak gerçek yetki veya erişim eksikliğini açık engel (`blocker`) olarak hemen bildir"** şeklindedir.

---

## 5. Veri Şemaları: `reported` ile `observed` Ayrımı

### 5.1 İstek Zarfı (`HandoffEnvelope` v0.2)

```typescript
export interface HandoffEnvelopeV2 {
  schemaVersion: "0.2";
  requestId: string;          // İdempotent takip kimliği (UUID)
  workspaceId: string;        // Depo / çalışma alanı kimliği
  title: string;
  outcome: string;

  mode: "investigate" | "implement" | "verify_only" | "publish_unchanged";
  publisherOwner: "none" | "local" | "remote_gated";

  gitContext: {
    repoId: string;                 // ör. "openclaw/openclaw"
    pinnedBaseCommitSha: string;    // Hareketli dal adı DEĞİL, çözülmüş 40-hex SHA
    pinnedSourceCommitSha?: string; // Gönderilen erişilebilir commit SHA
    sourceRemoteRef?: string;       // Uzak tarafın fetch edebileceği dal/ref
    expectedTreeSha?: string;       // publish_unchanged ve verify_only için zorunlu
    lockedPaths?: string[];         // Ara commit'ler dahil dokunulması yasak yollar
  };

  requestedCapabilities: {
    allowCodeEdit: boolean;
    allowBranchPush: boolean;
    allowManagedPublishStage: boolean; // Yalnızca remote_gated Aşama-2'de true olabilir
  };

  /** Köprünün teknik olarak zorlayamadığı, hedef ajana iletilen çalışma kuralları */
  advisoryInstructions: Array<{
    instruction: string;
    reason: string;
  }>;

  /** Yalnızca kanıt referansı taşıyan ön bulgular */
  priorEvidence: Array<{
    claim: string;
    sourceRef: string; // dosya:satır, commit SHA, komut çıkış kodu veya log özeti
  }>;

  nonBindingHints?: string[];
  acceptanceCriteria: string[];
}
```
*Doğrulama Kuralı:* `mode === "publish_unchanged"` iken `requestedCapabilities.allowCodeEdit === true` verilirse köprü bunu sessizce değiştirmez; açık `INVALID_CONTRACT_CONFLICT` hatası döner.

### 5.2 Sonuç Zarfı (`HandoffResultEnvelope` v0.2)
Bağlam bütçesini (*token budget*) korumak için tam transkript taşınmaz; yalnızca tur deltası döner ve modelin beyanıyla köprünün gözlemi ayrılır:

```typescript
export interface HandoffResultEnvelopeV2 {
  schemaVersion: "0.2";
  handoffId: string;
  turnNumber: number;
  runId: string;

  /** İşin yaşam döngüsü durumu */
  lifecycleStatus: "running" | "settled" | "uncertain" | "aborted" | "failed";

  /** 1) REPORTED: Hedef ajanın kendi beyanı (kanıtlanmamış iddia olarak ele alınır) */
  reported?: {
    disposition: "completed" | "needs_evidence" | "blocked" | "ready_for_publish_gate";
    candidateCommitSha?: string;
    candidateRef?: string;
    summaryDelta: string;
    blockers: string[];
    claimedChecks: Array<{ command: string; exitCode?: number; environment?: string }>;
  };

  /** 2) OBSERVED: Köprünün Git nesneleri, RPC durumu ve GitHub üzerinden bizzat doğruladığı gerçekler */
  observed: {
    reachableRefVerified: boolean;
    observedHeadSha?: string;
    observedTreeSha?: string;
    treeMatchesExpected?: boolean;
    lockedPathsClean?: boolean;
    violatedPaths?: string[];
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
      | "ESCALATE_TO_HUMAN";        // Görev bitti, yetki dışı karar var veya tıkanma (stagnation) algılandı
    reason: string;
    remainingTurnBudget: number;
  };
}
```

---

## 6. Daraltılmış Faz-1 MVP Araç Yüzeyi ve Kabul Testi

### 6.1 Faz-1 Kapsamı (Tek Hedef Ailesi, Tam Dayanıklılık)
İlk sürüm satır sayısı iddiasıyla değil, **sıfır kayıp iş ve sıfır bozuk PR** hedefiyle daraltılmıştır:
- **Hedef Adaptör (Faz 1):** Yalnızca `openclaw-gateway` (uzak paylaşımlı `robo` + yerel OpenClaw). Yerel `codex app-server --stdio` ve `claude -p --resume` adaptörleri Faz 2'ye ayrılmıştır.
- **Yayınlama Kurtarma Sınırı (Faz 1):** Yalnızca **erişilebilir bir Git referansına push edilmiş** işleri yerelde devralır (uzak diskteki push edilmemiş `worktree` dosyalarını kurtarma vaadi Faz 1'de yoktur). Uzak yayınlama `uncertain_in_flight` durumundaysa (hedef depo + kaynak dal + hedef dal + görev kimliği uzlaştırması netleşmeden) ikinci bir PR kesinlikle açılmaz. PR metni serbest metin temizleyicisi (*regex sanitizer*) yerine yalnızca yapılandırılmış dar şablon alanlarından üretilir ve bilinen gizli dizgeler için taranır.

**Faz-1 MCP Araçları:**
1. **`bridge_preflight`:** Gateway `health`, kimlik oturumu ve gerekli RPC/yetki hazırlığını sınar; isteğe bağlı olarak açık/birleşmiş rakip PR'ları *engelleyici olmayan uyarı* olarak raporlar.
2. **`bridge_handoff_start`:** Kalıcı `handoffId` oluşturur, ön-kaydı SQLite'a yazar, sabit commit SHA'larıyla oturumu açar ve kısa bekleme bütçesi (`waitBudgetMs`) içinde bitmezse `lifecycleStatus: "running"` döner.
3. **`bridge_handoff_attach`:** Kesinti, yeniden başlatma veya bekleme bütçesi dolumu sonrasında aynı `handoffId` / `runId` koşusuna yeniden bağlanır; tek bir yeni koşu veya çift mesaj üretmeden sonucu uzlaştırır.
4. **`bridge_handoff_continue`:** Otonom çözüm döngüsünün devam adımıdır (veya `remote_gated` modunda `observed` doğrulaması geçtikten sonra Aşama-2 yayınlama onayını iletir).
5. **`bridge_verify_git`:** Checkout yapmadan izole depoda `pinnedBaseCommitSha`, `observedHeadSha`, `observedTreeSha` ve tüm ara commit'lerde `lockedPaths` kurallarını doğrular.
6. **`bridge_handoff_abort`:** Beklemeyi bırakmaktan bağımsız olarak, gerçekten uzaktaki koşuyu durdurmak istendiğinde çağrılır.

### 6.2 Faz-1 Birincil Kabul Testi ve Başarı Ölçütleri
- **Zorunlu Kesinti Kabul Testi (*Crash-Reconnect Test*):** Uzak `robo` görevi çalışırken yerel `agent-bridge-mcp` sürecini ve çağıran yerel asistanı tamamen kapat; yeniden başlat; `bridge_handoff_attach(handoffId)` çağır; **ikinci bir uzak koşu veya ikinci bir PR üretmeden** devam eden işin sonucunu al ve doğrulama döngüsünü tamamla.
- **Başarı Metrikleri:**
  1. Görev başına **insan müdahalesi sayısı** (hedef: başlangıç + nihai onay dışında `0`),
  2. Kesinti/zaman aşımı sonrası **kaybolan veya çiftlenen iş/PR sayısı** (hedef: `0`),
  3. **Doğrulanan commit (`observedHeadSha`) ile yayınlanan commit'in birebir eşleşme oranı** (hedef: `%100`).
